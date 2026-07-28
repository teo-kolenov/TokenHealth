import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripAuthoringComments } from '../src/analysis/render.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function filesUnder(dir: string, ext = '.ts'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, ext));
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

/**
 * Strip comments and string literals before scanning for the figma global.
 * Without this, DTCG extension keys like 'com.figma.variableId' read as usage.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** `figma.x` as a global reference, not `something.figma.x`. */
const FIGMA_GLOBAL = /(?<![.\w$])figma\s*\./;

describe('layer purity', () => {
  /**
   * The analysis layer must stay Figma-free so it can run in the UI iframe (which
   * has no scene access) and in the headless test runner. One convenience import
   * of the `figma` global would break both, silently, at runtime rather than
   * build time — hence a mechanical guard.
   */
  test('src/analysis never touches the figma global', () => {
    const files = filesUnder(resolve(root, 'src/analysis'));
    assert.ok(files.length > 0, 'expected analysis files to scan');
    for (const file of files) {
      const source = codeOnly(readFileSync(file, 'utf8'));
      assert.ok(!FIGMA_GLOBAL.test(source), `${file} references the figma global`);
      assert.ok(!/@figma\/plugin-typings/.test(source), `${file} imports Figma typings`);
      assert.ok(!/from ['"]\.\.\/main\//.test(readFileSync(file, 'utf8')), `${file} imports from the main thread layer`);
    }
  });

  test('the UI layer never touches the figma global either', () => {
    // The UI runs in a sandboxed iframe; `figma` is simply not defined there.
    for (const file of filesUnder(resolve(root, 'src/ui'))) {
      const source = codeOnly(readFileSync(file, 'utf8'));
      assert.ok(!FIGMA_GLOBAL.test(source), `${file} references the figma global`);
    }
  });

  test('the guard actually catches a real violation', () => {
    // A purity check that cannot fail is worthless — prove it detects usage.
    assert.ok(FIGMA_GLOBAL.test(codeOnly('const x = figma.variables.getLocalVariablesAsync();')));
    assert.ok(!FIGMA_GLOBAL.test(codeOnly(`const key = 'com.figma.variableId';`)));
    assert.ok(!FIGMA_GLOBAL.test(codeOnly('obj.figma.thing')));
  });

  test('the plugin UI declares no hardcoded colors outside :root', () => {
    // A tool that reports hardcoded colors must not ship any itself.
    const html = readFileSync(resolve(root, 'src/ui/ui.html'), 'utf8');
    const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(styleBlock)?.[1] ?? '';
    const outsideRoot = styleBlock.replace(rootBlock, '');

    const hexes = outsideRoot.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(hexes, [], `hardcoded colors outside :root: ${hexes.join(', ')}`);
  });

  test('the UI never relies on native modal dialogs', () => {
    // A sandboxed plugin iframe suppresses window.confirm/alert/prompt silently:
    // confirm() returns false with no dialog, so a gated action just looks broken.
    for (const file of filesUnder(resolve(root, 'src/ui'))) {
      const source = codeOnly(readFileSync(file, 'utf8'));
      for (const api of ['confirm', 'alert', 'prompt']) {
        assert.ok(
          !new RegExp(`(?:window\\s*\\.\\s*)?\\b${api}\\s*\\(`).test(source),
          `${file} calls window.${api}() — suppressed in a sandboxed iframe; use the inline confirm bar`,
        );
      }
    }
  });

  test('the destructive action has an inline confirmation gate', () => {
    const html = readFileSync(resolve(root, 'src/ui/ui.html'), 'utf8');
    assert.ok(html.includes('id="insert-confirm"'), 'insert must be gated by an inline confirm bar');
    assert.ok(html.includes('id="insert-yes"') && html.includes('id="insert-no"'), 'confirm bar needs both choices');
    assert.ok(/role="alertdialog"/.test(html), 'the confirm bar should be announced to assistive tech');
  });

  test('focus is never suppressed without a visible replacement', () => {
    // CLAUDE.md: never `outline: none` without a box-shadow ring.
    const html = readFileSync(resolve(root, 'src/ui/ui.html'), 'utf8');
    const rules = html.match(/[^{}]*\{[^{}]*outline:\s*none[^{}]*\}/g) ?? [];
    for (const rule of rules) {
      assert.ok(/box-shadow/.test(rule), `outline suppressed without a replacement ring: ${rule.trim()}`);
    }
    assert.ok(rules.length > 0, 'expected focus-visible rules to exist at all');
  });
});

describe('manifest', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

  test('declares no network access', () => {
    // The trust guarantee for a public Community plugin: design data cannot leave.
    assert.deepEqual(manifest.networkAccess.allowedDomains, ['none']);
    assert.ok(manifest.networkAccess.reasoning.length > 0);
  });

  test('targets the Figma editor only and uses dynamic-page access', () => {
    assert.deepEqual(manifest.editorType, ['figma']);
    assert.equal(manifest.documentAccess, 'dynamic-page');
  });

  test('points at the built bundles', () => {
    assert.equal(manifest.main, 'dist/code.js');
    assert.equal(manifest.ui, 'dist/ui.html');
  });
});

describe('template sync', () => {
  test('the bundled template matches the skill original where it counts', () => {
    // The plugin ships its own copy; drift in the *rendered* markup would mean
    // two different reports. Authoring comments are compared loosely because the
    // plugin copy has them sanitized — they are stripped before rendering, so
    // they cannot affect output either way.
    const mine = readFileSync(resolve(root, 'src/template.html'), 'utf8');
    const original = resolve(root, '../token-health-analysis/templates/token-strategy-dashboard.template.html');
    let source: string;
    try {
      source = readFileSync(original, 'utf8');
    } catch {
      return; // skill repo not present alongside; nothing to compare
    }
    assert.equal(
      stripAuthoringComments(mine),
      stripAuthoringComments(source),
      'plugin template has drifted from the skill template',
    );
  });
});

describe('organization anonymity', () => {
  /**
   * This plugin is destined for the public Figma Community. Nothing in the
   * shipped source may name the organization whose design system it was
   * developed against, or link to its private Figma file.
   */
  const FORBIDDEN = [/keenetic/i, /netcraze/i, /hSgrh1iz/];

  /** This file necessarily spells the forbidden terms out in order to detect them. */
  const SELF = fileURLToPath(import.meta.url);

  test('no organization identifiers appear in shipped source', () => {
    const roots = ['src', 'test', 'scripts'];
    const scanned: string[] = [];
    for (const dir of roots) {
      for (const ext of ['.ts', '.html', '.json', '.mjs']) scanned.push(...filesUnder(resolve(root, dir), ext));
    }
    assert.ok(scanned.length > 10, 'expected to scan a meaningful number of files');
    assert.ok(scanned.includes(SELF), 'the scan must cover the test directory');

    for (const file of scanned) {
      if (file === SELF) continue;
      const source = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        assert.ok(!pattern.test(source), `${file} contains an organization identifier matching ${pattern}`);
      }
    }
  });

  test('the manifest and readme are clean too', () => {
    for (const name of ['manifest.json', 'README.md', 'package.json']) {
      const source = readFileSync(resolve(root, name), 'utf8');
      for (const pattern of FORBIDDEN) {
        assert.ok(!pattern.test(source), `${name} contains an organization identifier matching ${pattern}`);
      }
    }
  });
});
