import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractVariables, splitVariableName } from '../src/main/extract.ts';
import { rgbaToHex, hexToRgba, hexDeltaE } from '../src/main/color.ts';
import { pickModeId } from '../src/main/alias-resolve.ts';
import { analyze } from '../src/analysis/analyzer.ts';
import type { VariableCollectionLike, VariableLike, VariablesApi } from '../src/main/figma-api.ts';

/** A fake variables API — lets the extractor be tested without a live file. */
function fakeApi(collections: VariableCollectionLike[], variables: VariableLike[]): VariablesApi {
  return {
    getLocalVariableCollectionsAsync: async () => collections,
    getLocalVariablesAsync: async () => variables,
    getVariableByIdAsync: async (id) => variables.find((v) => v.id === id) ?? null,
  };
}

const collection = (id: string, name: string, modes: [string, string][]): VariableCollectionLike => ({
  id,
  name,
  modes: modes.map(([modeId, modeName]) => ({ modeId, name: modeName })),
  defaultModeId: modes[0][0],
});

const variable = (
  id: string,
  name: string,
  collectionId: string,
  valuesByMode: VariableLike['valuesByMode'],
  resolvedType: VariableLike['resolvedType'] = 'COLOR',
): VariableLike => ({ id, name, variableCollectionId: collectionId, valuesByMode, resolvedType });

const alias = (id: string) => ({ type: 'VARIABLE_ALIAS' as const, id });

/* ================================================================== */
describe('color conversion', () => {
  test('converts Figma floats to the uppercase hex the analyzer expects', () => {
    assert.equal(rgbaToHex({ r: 0, g: 0.4823529411764706, b: 0.7450980392156863 }), '#007BBE');
    assert.equal(rgbaToHex({ r: 1, g: 1, b: 1 }), '#FFFFFF');
    assert.equal(rgbaToHex({ r: 0, g: 0, b: 0 }), '#000000');
  });

  test('emits 8-digit hex only when not opaque', () => {
    assert.equal(rgbaToHex({ r: 0, g: 0.4823529, b: 0.745098, a: 1 }), '#007BBE');
    assert.equal(rgbaToHex({ r: 0, g: 0.4823529, b: 0.745098, a: 0.5 }), '#007BBE80');
  });

  test('clamps out-of-range channels instead of producing garbage', () => {
    assert.equal(rgbaToHex({ r: -1, g: 2, b: 0.5 }), '#00FF80');
  });

  test('hex round-trips', () => {
    const parsed = hexToRgba('#007BBE');
    assert.ok(parsed);
    assert.equal(rgbaToHex(parsed), '#007BBE');
    assert.equal(rgbaToHex(hexToRgba('#0AF')!), '#00AAFF');
    assert.equal(hexToRgba('nonsense'), null);
  });

  test('deltaE separates identical, near, and distant colors', () => {
    assert.equal(hexDeltaE('#007BBE', '#007BBE'), 0);
    assert.ok(hexDeltaE('#007BBE', '#007CBE')! < 2, 'near-identical should be under the JND');
    assert.ok(hexDeltaE('#007BBE', '#E0031F')! > 10, 'brand vs red should be clearly distinct');
  });
});

/* ================================================================== */
describe('name splitting', () => {
  test('splits slash paths into group + leaf', () => {
    assert.deepEqual(splitVariableName('global/brand/color-brand-50'), {
      group: 'global/brand',
      token: 'color-brand-50',
    });
    assert.deepEqual(splitVariableName('spacing/sp-8'), { group: 'spacing', token: 'sp-8' });
  });

  test('a name with no path lands in (root) and is counted as a layer violation', () => {
    assert.deepEqual(splitVariableName('loose-token'), { group: '(root)', token: 'loose-token' });
  });
});

/* ================================================================== */
describe('cross-collection mode mapping', () => {
  const target = collection('c2', 'Primitives', [
    ['m1', 'Light'],
    ['m2', 'Dark'],
  ]);

  test('matches by mode name', () => {
    assert.deepEqual(pickModeId(target, 'Dark'), { modeId: 'm2', fallback: false });
    assert.deepEqual(pickModeId(target, 'light'), { modeId: 'm1', fallback: false });
  });

  test('falls back to the default mode and reports it', () => {
    // A semantic layer resolving Dark through another collection's default mode
    // is a real architecture smell, so the fallback must be visible.
    assert.deepEqual(pickModeId(target, 'Mobile'), { modeId: 'm1', fallback: true });
  });

  test('a single-mode target needs no fallback flag', () => {
    const single = collection('c3', 'Base', [['only', 'Value']]);
    assert.deepEqual(pickModeId(single, 'Dark'), { modeId: 'only', fallback: false });
  });
});

/* ================================================================== */
describe('alias chain resolution', () => {
  test('resolves a 3-hop chain to its literal and records depth', async () => {
    const c = collection('c1', 'Colors', [['m1', 'Light']]);
    const api = fakeApi(c ? [c] : [], [
      variable('v1', 'semantic/color-action', 'c1', { m1: alias('v2') }),
      variable('v2', 'semantic/color-primary', 'c1', { m1: alias('v3') }),
      variable('v3', 'global/color-brand-50', 'c1', { m1: { r: 0, g: 0.4823529, b: 0.745098 } }),
    ]);

    const input = await extractVariables(api, { projectName: 'test' });
    const tokens = input.collections[0].groups.flatMap((g) => g.tokens);
    const action = tokens.find((t) => t.name === 'color-action')!;

    assert.equal(action.value, '#007BBE', 'chain must resolve to the terminal literal');
    assert.equal(action.chainDepth, 2);
    assert.deepEqual(action.aliasChain, ['semantic/color-primary', 'global/color-brand-50']);
    assert.equal(action.aliasInAnyMode, true);
  });

  test('a 2-node cycle is caught, not looped', async () => {
    const api = fakeApi(
      [collection('c1', 'Colors', [['m1', 'Light']])],
      [
        variable('v1', 'a/loop-one', 'c1', { m1: alias('v2') }),
        variable('v2', 'a/loop-two', 'c1', { m1: alias('v1') }),
      ],
    );

    const input = await extractVariables(api, { projectName: 'test' });
    const tokens = input.collections[0].groups.flatMap((g) => g.tokens);
    assert.ok(tokens.every((t) => t.aliasCyclic === true), 'both ends of the cycle must be flagged');
    assert.equal(analyze(input).metrics.cyclicAliases, 2);
  });

  test('a broken alias target is reported as orphaned', async () => {
    const api = fakeApi(
      [collection('c1', 'Colors', [['m1', 'Light']])],
      [variable('v1', 'a/dangling', 'c1', { m1: alias('deleted-id') })],
    );

    const input = await extractVariables(api, { projectName: 'test' });
    const token = input.collections[0].groups[0].tokens[0];
    assert.equal(token.aliasBroken, true);
    assert.equal(analyze(input).metrics.orphanedAliases, 1);
  });

  test('a cross-collection alias with mismatched mode names sets the fallback flag', async () => {
    const semantic = collection('c1', 'Semantic', [
      ['s1', 'Mobile'],
      ['s2', 'Desktop'],
    ]);
    const primitives = collection('c2', 'Primitives', [
      ['p1', 'Light'],
      ['p2', 'Dark'],
    ]);
    const api = fakeApi(
      [semantic, primitives],
      [
        variable('v1', 'semantic/color-surface', 'c1', { s1: alias('v2'), s2: alias('v2') }),
        variable('v2', 'global/color-gray-0', 'c2', { p1: { r: 1, g: 1, b: 1 }, p2: { r: 0, g: 0, b: 0 } }),
      ],
    );

    const input = await extractVariables(api, { projectName: 'test' });
    const surface = input.collections
      .find((c) => c.name === 'Semantic')!
      .groups.flatMap((g) => g.tokens)
      .find((t) => t.name === 'color-surface')!;

    assert.equal(surface.modeMappingFallback, true);
    // Mobile has no name match in the target, so it resolves via the default (Light).
    assert.equal(surface.valuesByMode!.Mobile, '#FFFFFF');
    assert.ok(analyze(input).notes.some((n) => /mode names do not match/i.test(n)));
  });

  test('a variable missing a value in one mode records null, not a fabricated value', async () => {
    const c = collection('c1', 'Colors', [
      ['m1', 'Light'],
      ['m2', 'Dark'],
    ]);
    const api = fakeApi([c], [variable('v1', 'a/partial-token', 'c1', { m1: { r: 1, g: 1, b: 1 } })]);

    const input = await extractVariables(api, { projectName: 'test' });
    const token = input.collections[0].groups[0].tokens[0];
    assert.deepEqual(token.modes, ['Light'], 'only modes with values are listed');
    assert.equal(token.valuesByMode!.Dark, null);
    assert.equal(token.value, '#FFFFFF');
  });

  test('a remote variable with an empty valuesByMode does not crash extraction', async () => {
    const api = fakeApi(
      [collection('c1', 'Colors', [['m1', 'Light']])],
      [
        variable('v1', 'a/uses-remote', 'c1', { m1: alias('v2') }),
        { ...variable('v2', 'lib/remote-token', 'c1', {}), remote: true },
      ],
    );

    const input = await extractVariables(api, { projectName: 'test' });
    const token = input.collections[0].groups.flatMap((g) => g.tokens).find((t) => t.name === 'uses-remote')!;
    assert.equal(token.aliasBroken, true, 'unavailable remote value is a broken hop');
    assert.equal(token.aliasInAnyMode, true, 'but the alias link itself still counts');
  });
});

/* ================================================================== */
describe('extraction shape', () => {
  test('marks the source as plugin-derived so alias data is trusted', async () => {
    const api = fakeApi(
      [collection('c1', 'Colors', [['m1', 'Light']])],
      [variable('v1', 'g/color-x', 'c1', { m1: { r: 0, g: 0, b: 0 } })],
    );
    const input = await extractVariables(api, { projectName: 'Example Design System' });
    assert.equal(input.meta.sourceFidelity, 'figma-plugin');
    // A plugin-sourced 0% is real and must be scored, unlike a DTCG 0%.
    assert.equal(analyze(input).metrics.aliasLayerCoverage, 0);
  });

  test('captures every mode at once — the thing a per-mode export cannot do', async () => {
    const c = collection('c1', 'Sizes', [
      ['m1', 'Mobile'],
      ['m2', 'Desktop'],
    ]);
    const api = fakeApi([c], [variable('v1', 'spacing/sp-8', 'c1', { m1: 8, m2: 12 }, 'FLOAT')]);

    const input = await extractVariables(api, { projectName: 'Example Sizes' });
    assert.deepEqual(input.meta.modeNames, ['Mobile', 'Desktop']);
    const token = input.collections[0].groups[0].tokens[0];
    assert.deepEqual(token.valuesByMode, { Mobile: 8, Desktop: 12 });
    // And a size axis must not be scored as a missing theme.
    assert.equal(analyze(input).metrics.modeCoverage, null);
  });

  test('promotes FLOAT to DIMENSION only when every scope is dimensional', async () => {
    const c = collection('c1', 'Sizes', [['m1', 'Value']]);
    const api = fakeApi(
      [c],
      [
        { ...variable('v1', 'radius/global-radius-l', 'c1', { m1: 8 }, 'FLOAT'), scopes: ['CORNER_RADIUS'] },
        { ...variable('v2', 'opacity/global-opacity-50', 'c1', { m1: 0.5 }, 'FLOAT'), scopes: ['ALL_SCOPES'] },
      ],
    );
    const input = await extractVariables(api, { projectName: 'test' });
    assert.equal(input.collections[0].groups.find((g) => g.name === 'radius')!.type, 'DIMENSION');
    assert.equal(input.collections[0].groups.find((g) => g.name === 'opacity')!.type, 'FLOAT');
  });

  test('flags a group whose members disagree on type', async () => {
    const c = collection('c1', 'Mixed', [['m1', 'Value']]);
    const api = fakeApi(
      [c],
      [
        variable('v1', 'g/a-color', 'c1', { m1: { r: 0, g: 0, b: 0 } }, 'COLOR'),
        variable('v2', 'g/a-number', 'c1', { m1: 4 }, 'FLOAT'),
      ],
    );
    const group = (await extractVariables(api, { projectName: 'test' })).collections[0].groups[0];
    assert.equal(group.type, 'OTHER');
    assert.equal(group.mixedTypes, true);
  });

  test('root-level variables are counted as global layer violations', async () => {
    const api = fakeApi(
      [collection('c1', 'Colors', [['m1', 'Light']])],
      [variable('v1', 'loose-token', 'c1', { m1: { r: 0, g: 0, b: 0 } })],
    );
    const input = await extractVariables(api, { projectName: 'test' });
    assert.equal(analyze(input).metrics.globalTokenViolations, 1);
  });

  test('excludeHidden drops variables hidden from publishing', async () => {
    const api = fakeApi(
      [collection('c1', 'Colors', [['m1', 'Light']])],
      [
        variable('v1', 'g/visible', 'c1', { m1: { r: 0, g: 0, b: 0 } }),
        { ...variable('v2', 'g/hidden', 'c1', { m1: { r: 1, g: 1, b: 1 } }), hiddenFromPublishing: true },
      ],
    );
    const all = await extractVariables(api, { projectName: 'test' });
    const filtered = await extractVariables(api, { projectName: 'test', excludeHidden: true });
    assert.equal(analyze(all).metrics.totalTokens, 2);
    assert.equal(analyze(filtered).metrics.totalTokens, 1);
  });
});
