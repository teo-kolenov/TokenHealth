import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../src/analysis/analyzer.ts';
import { renderDashboard, PLACEHOLDERS } from '../src/analysis/render.ts';
import { computeScore, duplicateFactor, WEIGHTS, scoreColor } from '../src/analysis/score.ts';
import { NAMING_RE, nameFailureReason, damerauLevenshtein, findTypos } from '../src/analysis/naming.ts';
import { findDuplicates, canonicalize } from '../src/analysis/duplicates.ts';
import { importDtcg } from '../src/analysis/dtcg.ts';
import type { NormalizedInput } from '../src/analysis/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const fixture = (name: string) => JSON.parse(readFileSync(resolve(here, 'fixtures', name), 'utf8'));
const TEMPLATE = readFileSync(resolve(root, 'src/template.html'), 'utf8');

/* ================================================================== */
describe('naming', () => {
  test('regex matches SKILL.md contract', () => {
    assert.ok(NAMING_RE.test('color-brand-50'));
    assert.ok(NAMING_RE.test('a-b-c'));
    assert.ok(!NAMING_RE.test('global-radius-M'), 'uppercase segment must fail');
    assert.ok(!NAMING_RE.test('sp8'), 'single segment must fail');
    assert.ok(!NAMING_RE.test('global-fontSize-H1'), 'camelCase must fail');
  });

  test('failure reasons are specific, not generic', () => {
    assert.equal(nameFailureReason('color-brand-50'), null);
    assert.match(nameFailureReason('global-radius-M')!, /uppercase/);
    assert.match(nameFailureReason('sp8')!, /single segment/);
    assert.match(nameFailureReason('global_padding_2')!, /underscore/);
    assert.match(nameFailureReason('-leading')!, /leading or trailing/);
  });

  test('damerau-levenshtein scores a transposition as one edit', () => {
    // This is why plain Levenshtein is not enough: raduis->radius is a swap.
    assert.equal(damerauLevenshtein('raduis', 'radius'), 1);
    assert.equal(damerauLevenshtein('radius', 'radius'), 0);
    assert.equal(damerauLevenshtein('abc', 'xyz'), 3);
  });
});

/* ================================================================== */
describe('score', () => {
  test('weights sum to 1', () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  test('strict mode reproduces the SKILL.md formula exactly', () => {
    const parts = {
      aliasLayerCoverage: 94,
      namingPatternCompliance: 98,
      modeCoverage: 80,
      duplicateFactor: duplicateFactor(2, 100)!,
    };
    // Oracle: the literal formula from SKILL.md
    const oracle = Math.round(94 * 0.35 + 98 * 0.25 + 80 * 0.2 + (100 - Math.min((2 / 100) * 100, 100)) * 0.2);
    assert.equal(computeScore(parts, 'strict').score, oracle);
  });

  test('strict counts nulls as zero; adaptive excludes them', () => {
    const parts = { aliasLayerCoverage: null, namingPatternCompliance: 100, modeCoverage: null, duplicateFactor: 100 };
    assert.equal(computeScore(parts, 'strict').score, Math.round(100 * 0.25 + 100 * 0.2)); // 45
    assert.equal(computeScore(parts, 'adaptive').score, 100);
  });

  test('adaptive renormalized weights sum to 1', () => {
    const result = computeScore(
      { aliasLayerCoverage: null, namingPatternCompliance: 60, modeCoverage: null, duplicateFactor: 90 },
      'adaptive',
    );
    const sum = result.breakdown.filter((b) => b.applied).reduce((a, b) => a + b.weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `renormalized weights summed to ${sum}`);
  });

  test('color thresholds flip exactly at 60 and 80', () => {
    assert.equal(scoreColor(80).label, 'ok');
    assert.equal(scoreColor(79).label, 'warn');
    assert.equal(scoreColor(60).label, 'warn');
    assert.equal(scoreColor(59).label, 'fail');
    assert.equal(scoreColor(80).color, 'var(--c-ok-60)');
    assert.equal(scoreColor(60).color, 'var(--c-warn-40)');
    assert.equal(scoreColor(59).color, 'var(--c-danger-50)');
  });
});

/* ================================================================== */
describe('duplicates', () => {
  const build = (tokens: { name: string; value: number | string; group: string }[]): NormalizedInput => ({
    meta: { projectName: 'test' },
    collections: [
      {
        name: 'Sizes',
        groups: [...new Set(tokens.map((t) => t.group))].map((group) => ({
          name: group,
          type: 'FLOAT' as const,
          tokens: tokens.filter((t) => t.group === group).map((t) => ({ name: t.name, value: t.value })),
        })),
      },
    ],
  });

  test('REGRESSION: padding-16 vs spacing-16 is NOT a duplicate', () => {
    // The false positive that made the original report untrustworthy. padding and
    // spacing are distinct layout roles that happen to share a numeric scale.
    const input = build([
      { name: 'global-padding-16', value: 16, group: 'padding' },
      { name: 'global-spacing-16', value: 16, group: 'spacing' },
    ]);
    const { duplicates } = findDuplicates(input);
    assert.equal(duplicates.length, 0, 'padding/spacing must not be reported as duplicates');
  });

  test('REGRESSION: parallel scales are reported as informational instead', () => {
    const steps = [2, 4, 8, 12, 16, 24];
    const input = build([
      ...steps.map((v) => ({ name: `global-padding-${v}`, value: v, group: 'padding' })),
      ...steps.map((v) => ({ name: `global-spacing-${v}`, value: v, group: 'spacing' })),
    ]);
    const { duplicates, parallelScales, weighted } = findDuplicates(input);
    assert.equal(duplicates.length, 0);
    assert.equal(parallelScales.length, 1);
    assert.equal(weighted, 0, 'informational findings must not affect the score');
    assert.match(parallelScales[0].evidence, /parallel scales/i);
  });

  test('opting in to mergeSpacingRoles does flag them', () => {
    const input = build([
      { name: 'global-padding-16', value: 16, group: 'padding' },
      { name: 'global-spacing-16', value: 16, group: 'spacing' },
    ]);
    const { duplicates } = findDuplicates(input, { mergeSpacingRoles: true });
    assert.equal(duplicates.length, 1, 'explicit opt-in should surface the pair');
  });

  test('H2: segment-order inversion is high severity', () => {
    const input: NormalizedInput = {
      meta: { projectName: 'test' },
      collections: [
        {
          name: 'Colors',
          groups: [
            {
              name: 'semantic',
              type: 'COLOR',
              tokens: [
                { name: 'color-primary-content-default', value: '#007BBE' },
                { name: 'primary-color-content-default', value: '#219CDE' },
              ],
            },
          ],
        },
      ],
    };
    const { duplicates } = findDuplicates(input);
    const inversion = duplicates.find((d) => d.heuristic === 'H2');
    assert.ok(inversion, 'inversion pair must be detected');
    assert.equal(inversion.severity, 'high');
  });

  test('H1: same value + same role in one group is high severity', () => {
    const input = build([
      { name: 'color-brand-primary', value: '#007BBE', group: 'brand' },
      { name: 'color-primary-brand', value: '#007BBE', group: 'brand' },
    ]);
    const { duplicates } = findDuplicates(input);
    assert.ok(duplicates.length >= 1);
    assert.ok(duplicates.some((d) => d.severity === 'high'));
  });

  test('canonicalization strips noise and maps synonyms', () => {
    assert.equal(canonicalize('global-color-bg-default').role, 'color-background');
    assert.equal(canonicalize('color-surface').role, 'color-background');
    assert.equal(canonicalize('global-padding-16').scale, '16');
    // padding and spacing must NOT collapse by default
    assert.notEqual(canonicalize('global-padding-16').role, canonicalize('global-spacing-16').role);
  });
});

/* ================================================================== */
describe('typo detection', () => {
  test('REGRESSION: global-raduis-S is flagged as a typo', () => {
    // The real defect the 39% report missed entirely.
    const input: NormalizedInput = {
      meta: { projectName: 'test' },
      collections: [
        {
          name: 'Sizes',
          groups: [
            {
              name: 'radius',
              type: 'FLOAT',
              tokens: [
                { name: 'global-raduis-S', value: 4 },
                { name: 'global-radius-M', value: 6 },
                { name: 'global-radius-L', value: 8 },
                { name: 'global-radius-XL', value: 12 },
              ],
            },
          ],
        },
      ],
    };
    const typos = findTypos(input);
    assert.equal(typos.length, 1);
    assert.equal(typos[0].token.name, 'global-raduis-S');
    assert.equal(typos[0].distance, 1);
  });

  test('a legitimate scale family produces no typos', () => {
    const input: NormalizedInput = {
      meta: { projectName: 'test' },
      collections: [
        {
          name: 'Sizes',
          groups: [
            {
              name: 'radius',
              type: 'FLOAT',
              tokens: [
                { name: 'global-radius-S', value: 4 },
                { name: 'global-radius-M', value: 6 },
                { name: 'global-radius-L', value: 8 },
              ],
            },
          ],
        },
      ],
    };
    assert.equal(findTypos(input).length, 0);
  });
});

/* ================================================================== */
describe('alias coverage fidelity', () => {
  test('a DTCG export reports N/A, not a misleading 0%', () => {
    // The core insight: the exporter flattens aliases, so 0% would be an artifact.
    const input = importDtcg([{ data: fixture('Mobile.tokens.json') }], {
      projectName: 'Example Sizes',
      collectionName: 'Sizes',
    });
    const result = analyze(input);
    assert.equal(result.metrics.aliasLayerCoverage, null);
    assert.ok(result.notes.some((n) => /cannot express alias/i.test(n)));
  });

  test('a plugin-sourced input reports a real 0% when there genuinely are no aliases', () => {
    const input: NormalizedInput = {
      meta: { projectName: 'test', sourceFidelity: 'figma-plugin' },
      collections: [
        { name: 'Sizes', groups: [{ name: 'spacing', type: 'FLOAT', tokens: [{ name: 'sp-8', value: 8 }] }] },
      ],
    };
    const result = analyze(input);
    assert.equal(result.metrics.aliasLayerCoverage, 0, 'plugin source must be trusted');
    assert.ok(result.notes.some((n) => /trustworthy/i.test(n)));
  });

  test('alias chain depth is averaged over aliased tokens only', () => {
    const input: NormalizedInput = {
      meta: { projectName: 'test', sourceFidelity: 'figma-plugin' },
      collections: [
        {
          name: 'Semantic',
          groups: [
            {
              name: 'action',
              type: 'COLOR',
              tokens: [
                { name: 'color-action-primary', value: '#007BBE', aliasOf: 'color-brand-50', aliasInAnyMode: true, chainDepth: 1 },
                { name: 'color-action-hover', value: '#219CDE', aliasOf: 'color-action-primary', aliasInAnyMode: true, chainDepth: 3 },
                { name: 'color-literal', value: '#FFFFFF' },
              ],
            },
          ],
        },
      ],
    };
    const { metrics } = analyze(input);
    assert.equal(metrics.aliasTokens, 2);
    assert.equal(metrics.avgChainDepth, 2);
    assert.ok(Math.abs(metrics.aliasLayerCoverage! - 66.67) < 0.01);
  });
});

/* ================================================================== */
describe('mode coverage', () => {
  test('a Mobile/Desktop axis is NOT scored as a light/dark failure', () => {
    // A platform-axis sizing collection. Scoring this as 50% is what dragged the
    // original report down; a size axis has no theme parity to miss.
    const input: NormalizedInput = {
      meta: { projectName: 'test', sourceFidelity: 'figma-plugin' },
      collections: [
        {
          name: 'Sizes',
          modes: ['Mobile', 'Desktop'],
          groups: [{ name: 'spacing', type: 'FLOAT', tokens: [{ name: 'sp-8', value: 8, modes: ['Mobile', 'Desktop'] }] }],
        },
      ],
    };
    const { metrics, notes } = analyze(input);
    assert.equal(metrics.themeModes.length, 0, 'Mobile/Desktop is not a theme axis');
    assert.equal(metrics.modeCoverage, null);
    assert.ok(notes.some((n) => /size or platform axis/i.test(n)));
  });

  test('a Light/Dark axis IS recognised as a theme axis', () => {
    const input: NormalizedInput = {
      meta: { projectName: 'test', sourceFidelity: 'figma-plugin' },
      collections: [
        {
          name: 'Colors',
          modes: ['Light', 'Dark'],
          groups: [{ name: 'brand', type: 'COLOR', tokens: [{ name: 'color-brand-50', value: '#007BBE' }] }],
        },
      ],
      components: [
        { name: 'Button', modeCoverage: { light: true, dark: true } },
        { name: 'Tooltip', modeCoverage: { light: true, dark: false } },
      ],
    };
    const { metrics } = analyze(input);
    assert.deepEqual(metrics.themeModes.sort(), ['Dark', 'Light']);
    assert.equal(metrics.modeCoverage, 75);
  });
});

/* ================================================================== */
describe('renderer', () => {
  const render = (input: NormalizedInput) =>
    renderDashboard(analyze(input), TEMPLATE, { generatedAt: '2026-07-23' });

  test('every placeholder is consumed — no {{...}} survives', () => {
    const html = render(fixture('sample-token-input.json'));
    const leftovers = html.match(/\{\{[a-zA-Z]+\}\}/g);
    assert.equal(leftovers, null, `unfilled placeholders: ${leftovers?.join(', ')}`);
  });

  test('the renderer knows about exactly the placeholders in the template', () => {
    const inTemplate = new Set((TEMPLATE.match(/\{\{([a-zA-Z]+)\}\}/g) ?? []).map((p) => p.slice(2, -2)));
    for (const name of inTemplate) {
      assert.ok(PLACEHOLDERS.includes(name as never), `template placeholder {{${name}}} has no renderer`);
    }
  });

  /** The template carries commented-out example rows; they must not be counted. */
  const stripComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');

  const bodyRows = (html: string, from: string, to: string) => {
    const section = stripComments(html).split(from)[1].split(to)[0];
    return (section.match(/<tr>/g) ?? []).length - 1; // minus the thead row
  };

  test('SKILL validation #3: duplicate count matches rendered rows', () => {
    // Use a fixture that actually produces findings, or the assertion is vacuous.
    const input = importDtcg([{ data: fixture('Mobile.tokens.json') }], {
      projectName: 'Example Sizes',
      collectionName: 'Sizes',
    });
    const result = analyze(input);
    const html = renderDashboard(result, TEMPLATE, { generatedAt: '2026-07-23' });
    const claimed = result.metrics.duplicates.length + result.metrics.parallelScales.length;
    assert.ok(claimed > 0, 'fixture must produce findings for this test to mean anything');
    assert.equal(
      bodyRows(html, 'Semantic Duplicates Detected', 'Direct CSS Color Overrides'),
      claimed,
      'rendered duplicate rows must match the stated count',
    );
  });

  test('SKILL validation #3: override count matches rendered rows', () => {
    const input = fixture('sample-token-input.json') as NormalizedInput;
    const result = analyze(input);
    const html = renderDashboard(result, TEMPLATE, { generatedAt: '2026-07-23' });
    assert.equal(
      bodyRows(html, 'Direct CSS Color Overrides', 'Token Inventory'),
      result.input.directCssOverrides?.length ?? 0,
    );
  });

  test('REGRESSION: content is not duplicated into the template authoring comments', () => {
    // The template documents its placeholders inside HTML comments. Substituting
    // into those pastes a second copy of every section into the output and, if
    // injected markup ever contained "-->", would escape into the visible page.
    const result = analyze(
      importDtcg([{ data: fixture('Mobile.tokens.json') }], { projectName: 'K', collectionName: 'Sizes' }),
    );
    const html = renderDashboard(result, TEMPLATE, { generatedAt: '2026-07-23' });

    const claimed = result.metrics.duplicates.length + result.metrics.parallelScales.length;
    assert.ok(claimed > 0);
    // Count in the RAW output, not a comment-stripped copy: exactly one render.
    const dividers = (html.match(/class="dup-divider"/g) ?? []).length;
    assert.equal(dividers, claimed, 'each finding must be rendered exactly once');

    // Inspect comment bodies directly — a `<!--[\s\S]*?X` regex would match
    // across a closing `-->` and prove nothing.
    for (const comment of html.match(/<!--[\s\S]*?-->/g) ?? []) {
      const body = comment.slice(4, -3);
      assert.ok(!body.includes('{{'), `placeholder survived inside a comment: ${body.slice(0, 60)}`);
      assert.ok(!/<\w+[\s>]/.test(body), `generated markup sits inside a comment: ${body.slice(0, 60)}`);
    }
  });

  test('REGRESSION: the template authoring docs never reach the visible page', () => {
    // The template's doc block contains a nested `<!-- SVG -->`. HTML comments do
    // not nest, so the outer comment ends there and the rest is painted as page
    // text. Every report from the unpatched template shows ~680 chars of
    // internal documentation above the header.
    const result = analyze(fixture('sample-token-input.json'));
    const html = renderDashboard(result, TEMPLATE, {});

    const body = html.slice(html.search(/<body[\s>]/i));
    const visible = body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, '');

    for (const phrase of ['One or more', 'Integer count', 'Short plain-text note', 'normalization-target']) {
      assert.ok(!visible.includes(phrase), `authoring documentation leaked into the page: "${phrase}"`);
    }
    assert.ok(!html.includes('PLACEHOLDER REFERENCE'), 'the doc block header must be gone');
  });

  test('section divider comments are preserved for readability', () => {
    const result = analyze(fixture('sample-token-input.json'));
    const html = renderDashboard(result, TEMPLATE, {});
    assert.ok(html.includes('━'), 'plain divider comments should survive');
  });

  test('inlineFontsOnly strips the blocked Google Fonts links', () => {
    // networkAccess "none" blocks these inside the plugin iframe.
    const result = analyze(fixture('sample-token-input.json'));
    const preview = renderDashboard(result, TEMPLATE, { inlineFontsOnly: true });
    const download = renderDashboard(result, TEMPLATE, {});
    assert.ok(!preview.includes('fonts.googleapis.com'), 'preview must not request external fonts');
    assert.ok(download.includes('fonts.googleapis.com'), 'downloaded copy keeps them');
  });

  test('output escapes hostile token names', () => {
    const input: NormalizedInput = {
      meta: { projectName: '<script>alert(1)</script>' },
      collections: [
        {
          name: 'X',
          groups: [{ name: 'g', type: 'STRING', tokens: [{ name: '<img src=x onerror=alert(1)>', value: 'v' }] }],
        },
      ],
    };
    const html = render(input);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('onerror=alert(1)'));
  });

  test('the health ring receives the score and its matching color', () => {
    const result = analyze(fixture('sample-token-input.json'));
    const html = renderDashboard(result, TEMPLATE, { generatedAt: '2026-07-23' });
    assert.ok(html.includes(`--hs:${result.score.score}`));
    assert.ok(html.includes(`--ring-color:${result.score.color}`));
  });
});

/* ================================================================== */
describe('end-to-end on the real 39% file', () => {
  const input = () =>
    importDtcg([{ data: fixture('Mobile.tokens.json') }], { projectName: 'Example Sizes', collectionName: 'Sizes' });

  test('real findings survive: 41 tokens, 58.5% naming', () => {
    const { metrics } = analyze(input());
    assert.equal(metrics.totalTokens, 41);
    assert.ok(Math.abs(metrics.namingCompliance! - 58.54) < 0.1);
    assert.equal(metrics.namingFailures.length, 17);
  });

  test('the typo is caught and the false duplicates are gone', () => {
    const { metrics } = analyze(input());
    assert.ok(metrics.typos.some((t) => t.token.name === 'global-raduis-S'));
    assert.equal(metrics.duplicateBreakdown.high, 0, 'no high-severity duplicates in a clean primitive scale');
    assert.ok(metrics.parallelScales.length > 0, 'padding/spacing surface as parallel scales instead');
  });

  test('the score is no longer dragged down by export artifacts', () => {
    const { score, metrics } = analyze(input());
    assert.equal(metrics.aliasLayerCoverage, null);
    assert.equal(metrics.modeCoverage, null);
    // The original run scored 39% on this exact file.
    assert.ok(score.score > 60, `expected a truthful score above 60, got ${score.score}`);
  });

  test('merging both mode files recovers both modes', () => {
    const merged = importDtcg(
      [{ data: fixture('Mobile.tokens.json') }, { data: fixture('Desktop.tokens.json') }],
      { projectName: 'Example Sizes', collectionName: 'Sizes' },
    );
    assert.deepEqual(analyze(merged).metrics.modeNames, ['Mobile', 'Desktop']);
  });
});
