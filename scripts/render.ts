#!/usr/bin/env node
/**
 * Headless renderer — runs the exact analysis + render path the plugin uses,
 * without Figma. Used for tests and for the cross-source parity check.
 *
 *   node --experimental-strip-types scripts/render.ts <input.json> [--out file.html]
 *        [--scoring strict|adaptive] [--dtcg] [--name "Project"]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analysis/analyzer.ts';
import { renderDashboard } from '../src/analysis/render.ts';
import { importDtcg } from '../src/analysis/dtcg.ts';
import type { NormalizedInput, Scoring } from '../src/analysis/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const inputs = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.startsWith('/dev'));
const positional = inputs.filter((_, i) => {
  const prev = process.argv[process.argv.indexOf(inputs[i]) - 1];
  return !prev?.startsWith('--') || prev === '--dtcg';
});

if (positional.length === 0) {
  console.error('usage: render.ts <input.json[,input2.json]> [--out out.html] [--scoring strict|adaptive] [--dtcg] [--name "Project"]');
  process.exit(1);
}

const files = positional[0].split(',').map((f) => resolve(process.cwd(), f.trim()));
const isDtcg = process.argv.includes('--dtcg');
const scoring = (arg('--scoring') as Scoring | undefined) ?? 'adaptive';
const projectName = arg('--name') ?? basename(files[0]).replace(/\.(tokens\.)?json$/, '');

let input: NormalizedInput;
if (isDtcg) {
  input = importDtcg(
    files.map((f) => ({ data: JSON.parse(readFileSync(f, 'utf8')), fallbackModeName: basename(f).split('.')[0] })),
    {
      projectName,
      collectionName: arg('--collection') ?? 'Sizes',
      sourceLabel: files.map((f) => basename(f)).join(', '),
      generatedAt: arg('--date'),
    },
  );
} else {
  input = JSON.parse(readFileSync(files[0], 'utf8')) as NormalizedInput;
  input.meta.sourceFidelity ??= 'unknown';
}

const result = analyze(input, { scoring, generatedAt: arg('--date') });
const template = readFileSync(resolve(root, 'src/template.html'), 'utf8');
const html = renderDashboard(result, template, { generatedAt: arg('--date') });

const out = arg('--out');
if (out) {
  writeFileSync(resolve(process.cwd(), out), html, 'utf8');
}

const m = result.metrics;
const fmt = (v: number | null, d = 1) => (v === null ? 'N/A' : `${v.toFixed(d)}%`);
console.log(`
  Project        ${input.meta.projectName}
  Fidelity       ${input.meta.sourceFidelity}
  Tokens         ${m.totalTokens} in ${m.totalCollections} collection(s), ${m.totalGroups} group(s)
  Modes          ${m.modeNames.join(', ') || '(none)'}
  ---
  Alias coverage ${fmt(m.aliasLayerCoverage)}
  Naming         ${fmt(m.namingCompliance)}  (${m.namingFailures.length} failing)
  Mode coverage  ${fmt(m.modeCoverage, 0)}
  Duplicates     ${m.weightedDuplicates} weighted (${m.duplicateBreakdown.high} high, ${m.duplicateBreakdown.warn} warn, ${m.duplicateBreakdown.info} info)
  Typos          ${m.typos.length}${m.typos.length ? ` -> ${m.typos.map((t) => t.token.name).join(', ')}` : ''}
  Parallel       ${m.parallelScales.length}
  Overrides      ${m.directOverrideCount}
  ---
  SCORE          ${result.score.score}% (${result.score.label}, ${result.score.scoring})
  ${result.score.note}
${out ? `\n  Written to ${out}` : ''}`);
