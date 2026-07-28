import type {
  AnalysisResult,
  AnalyzeOptions,
  Metrics,
  ModeCoverageRow,
  NormalizedInput,
  ReuseRow,
  Token,
} from './types.ts';
import { analyzeNaming, findTypos, flattenTokens } from './naming.ts';
import { findDuplicates } from './duplicates.ts';
import { analyzeAliases } from './alias.ts';
import { computeScore, duplicateFactor } from './score.ts';

/** Mode names that denote a light/dark theme axis, as opposed to a size axis. */
const LIGHT_MODE = /^(light|día|day|светл)/i;
const DARK_MODE = /^(dark|night|тёмн|темн)/i;

function allTokens(input: NormalizedInput): Token[] {
  const out: Token[] = [];
  for (const c of input.collections) for (const g of c.groups) for (const t of g.tokens) out.push(t);
  return out;
}

/**
 * A collection has a theme axis only when its mode names read as light/dark.
 *
 * This guard is what stops a Mobile/Desktop sizing collection
 * from being scored as "50% mode coverage" — a size axis is not a theme axis and
 * has no light/dark parity to miss.
 */
function collectThemeModes(input: NormalizedInput): string[] {
  const themeModes = new Set<string>();
  for (const collection of input.collections) {
    const modes = collection.modes ?? [];
    if (modes.length < 2) continue;
    const hasLight = modes.some((m) => LIGHT_MODE.test(m));
    const hasDark = modes.some((m) => DARK_MODE.test(m));
    if (hasLight && hasDark) for (const m of modes) themeModes.add(m);
  }
  return [...themeModes];
}

function collectModeNames(input: NormalizedInput): string[] {
  const names = new Set<string>();
  for (const collection of input.collections) {
    for (const mode of collection.modes ?? []) names.add(mode);
    for (const group of collection.groups) {
      for (const token of group.tokens) {
        for (const mode of token.modes ?? []) names.add(mode);
      }
    }
  }
  return [...names];
}

function analyzeModeCoverage(
  input: NormalizedInput,
  themeModes: string[],
): { coverage: number | null; rows: ModeCoverageRow[] } {
  const components = input.components ?? [];
  if (components.length === 0) return { coverage: null, rows: [] };

  // No theme axis anywhere means there is nothing to measure.
  if (themeModes.length === 0) {
    const anyExplicit = components.some((c) => c.modeCoverage && Object.keys(c.modeCoverage).length > 0);
    if (!anyExplicit) return { coverage: null, rows: [] };
  }

  const rows: ModeCoverageRow[] = [];
  let covered = 0;
  let total = 0;

  for (const component of components) {
    const modeCoverage = component.modeCoverage ?? {};
    const keys = Object.keys(modeCoverage);
    if (keys.length === 0) continue;

    const modes: Record<string, boolean> = {};
    let componentCovered = 0;
    for (const key of keys) {
      const value = modeCoverage[key] === true;
      modes[key] = value;
      if (value) componentCovered++;
    }

    rows.push({
      component: component.name,
      modes,
      covered: componentCovered,
      total: keys.length,
      reason: component.reason,
    });
    covered += componentCovered;
    total += keys.length;
  }

  if (total === 0) return { coverage: null, rows };
  return { coverage: (covered / total) * 100, rows };
}

function analyzeReuse(input: NormalizedInput): { rows: ReuseRow[]; hasData: boolean } {
  const tokens = allTokens(input);
  const counted = tokens
    .map((t) => ({
      token: t.name,
      count: t.usageCount ?? (t.usedBy ? t.usedBy.length : 0),
    }))
    .filter((r) => r.count > 0);

  if (counted.length === 0) return { rows: [], hasData: false };
  counted.sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
  return { rows: counted.slice(0, 8), hasData: true };
}

/**
 * Tokens that bypass the base/global layer policy: a token sitting directly at a
 * collection root with no group path, which cannot be placed in the layer model.
 */
function countGlobalViolations(input: NormalizedInput): number {
  let violations = 0;
  for (const collection of input.collections) {
    for (const group of collection.groups) {
      if (group.name === '(root)' || group.name.trim() === '') violations += group.tokens.length;
    }
  }
  return violations;
}

export function analyze(input: NormalizedInput, options: AnalyzeOptions = {}): AnalysisResult {
  const scoring = options.scoring ?? 'adaptive';
  const mergeSpacingRoles = options.mergeSpacingRoles ?? false;

  const refs = flattenTokens(input);
  const totalTokens = refs.length;
  const totalGroups = input.collections.reduce((sum, c) => sum + c.groups.length, 0);

  const naming = analyzeNaming(input);
  const typos = findTypos(input);
  const aliases = analyzeAliases(input);
  const duplicates = findDuplicates(input, { mergeSpacingRoles, primitivePattern: options.primitivePattern });

  const modeNames = collectModeNames(input);
  const themeModes = collectThemeModes(input);
  const modeCoverage = analyzeModeCoverage(input, themeModes);
  const reuse = analyzeReuse(input);

  const overrides = input.directCssOverrides ?? [];
  const countedOverrides = overrides.filter((o) => o.severity !== 'info');

  const metrics: Metrics = {
    totalTokens,
    totalCollections: input.collections.length,
    totalGroups,

    aliasTokens: aliases.aliasTokens,
    aliasLayerCoverage: aliases.coverage,
    orphanedAliases: aliases.orphaned,
    cyclicAliases: aliases.cyclic,
    avgChainDepth: aliases.avgChainDepth,

    namingCompliance: naming.compliance,
    namingFailures: naming.failures,
    typos,

    duplicates: duplicates.duplicates,
    duplicateBreakdown: duplicates.breakdown,
    weightedDuplicates: duplicates.weighted,
    parallelScales: duplicates.parallelScales,

    directOverrides: overrides,
    directOverrideCount: countedOverrides.length,

    modeCoverage: modeCoverage.coverage,
    modeCoverageRows: modeCoverage.rows,
    themeModes,

    reuse: reuse.rows,
    hasUsageData: reuse.hasData,

    globalTokenViolations: countGlobalViolations(input),
    modeNames,
  };

  const score = computeScore(
    {
      aliasLayerCoverage: metrics.aliasLayerCoverage,
      namingPatternCompliance: metrics.namingCompliance,
      modeCoverage: metrics.modeCoverage,
      duplicateFactor: duplicateFactor(metrics.weightedDuplicates, totalTokens),
    },
    scoring,
  );

  /* --- Assumption notes (SKILL.md: show N/A and state assumptions) --- */
  const notes: string[] = [];

  if (metrics.aliasLayerCoverage === null) {
    notes.push(
      'Alias coverage is N/A: this source cannot express alias references. A Figma DTCG export ' +
        'resolves aliases to literal values before writing the file, so no alias can be detected ' +
        'regardless of how the token set is actually structured. Run the plugin against the live ' +
        'file for a truthful reading.',
    );
  } else if (metrics.aliasLayerCoverage === 0 && aliases.aliasCapable) {
    notes.push(
      'Alias coverage is 0% and this reading is trustworthy — the source can express aliases and ' +
        'none were found. This scope is a flat primitive layer with no semantic tokens above it.',
    );
  }

  if (metrics.modeCoverage === null) {
    if (modeNames.length > 0 && themeModes.length === 0) {
      notes.push(
        `Mode coverage is N/A: the modes present (${modeNames.join(', ')}) form a size or platform axis, ` +
          'not a light/dark theme axis, so there is no theme parity to measure.',
      );
    } else {
      notes.push('Mode coverage is N/A: no per-component mode data was supplied for this scope.');
    }
  }

  if (!metrics.hasUsageData) {
    notes.push('Reuse counts are unavailable: no document scan was run, so token usage could not be measured.');
  }

  if (overrides.length === 0) {
    notes.push(
      'No direct color overrides recorded. Either the scan was skipped, or this scope contains no ' +
        'raw color literals.',
    );
  }

  if (aliases.modeMappingFallbacks > 0) {
    notes.push(
      `${aliases.modeMappingFallbacks} alias${aliases.modeMappingFallbacks === 1 ? '' : 'es'} resolve across ` +
        'collections whose mode names do not match; those fell back to the target collection default mode.',
    );
  }

  if (metrics.cyclicAliases > 0) {
    notes.push(`${metrics.cyclicAliases} alias chain(s) form a cycle and could not be fully resolved.`);
  }

  return {
    input,
    metrics,
    score,
    options: { scoring, mergeSpacingRoles },
    notes,
  };
}
