import type { ScoreBreakdownEntry, ScoreResult, Scoring } from './types.ts';

/** Weights from SKILL.md. Must sum to 1. */
export const WEIGHTS = {
  aliasLayerCoverage: 0.35,
  namingPatternCompliance: 0.25,
  modeCoverage: 0.2,
  duplicateFactor: 0.2,
} as const;

export const LABELS: Record<keyof typeof WEIGHTS, string> = {
  aliasLayerCoverage: 'Alias layer coverage',
  namingPatternCompliance: 'Naming pattern compliance',
  modeCoverage: 'Mode coverage',
  duplicateFactor: 'Duplicate-free factor',
};

export interface ScoreParts {
  aliasLayerCoverage: number | null;
  namingPatternCompliance: number | null;
  modeCoverage: number | null;
  /** Already expressed as 0-100 where 100 = no duplicates. */
  duplicateFactor: number | null;
}

/** SKILL.md: 100 - min(semanticDuplicates / totalTokens * 100, 100) */
export function duplicateFactor(weightedDuplicates: number, totalTokens: number): number | null {
  if (totalTokens <= 0) return null;
  return 100 - Math.min((weightedDuplicates / totalTokens) * 100, 100);
}

export function scoreColor(score: number): { color: string; label: 'ok' | 'warn' | 'fail' } {
  if (score >= 80) return { color: 'var(--c-ok-60)', label: 'ok' };
  if (score >= 60) return { color: 'var(--c-warn-40)', label: 'warn' };
  return { color: 'var(--c-danger-50)', label: 'fail' };
}

/**
 * Two scoring modes.
 *
 * `strict`   — the SKILL.md formula verbatim; a null input counts as 0.
 * `adaptive` — inapplicable inputs are dropped and the remaining weights are
 *              renormalized to sum to 1.
 *
 * Adaptive exists because two of the four inputs can be legitimately
 * inapplicable. A pure primitive collection has no semantic layer, so an alias
 * coverage of 0% is arithmetically correct but analytically meaningless; a file
 * with no light/dark axis has no mode coverage to measure. Scoring those as
 * zeros is what dragged a structurally fine token set to 39%.
 */
export function computeScore(parts: ScoreParts, scoring: Scoring = 'adaptive'): ScoreResult {
  const keys = Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[];

  if (scoring === 'strict') {
    const breakdown: ScoreBreakdownEntry[] = keys.map((key) => ({
      key,
      label: LABELS[key],
      value: parts[key],
      weight: WEIGHTS[key],
      applied: true,
    }));
    const raw = keys.reduce((sum, key) => sum + (parts[key] ?? 0) * WEIGHTS[key], 0);
    const score = Math.round(raw);
    const { color, label } = scoreColor(score);
    const nulls = keys.filter((k) => parts[k] === null);
    return {
      score,
      color,
      label,
      scoring,
      breakdown,
      note:
        nulls.length > 0
          ? `Strict scoring: ${nulls.map((k) => LABELS[k]).join(', ')} had no data and counted as 0.`
          : 'Strict scoring: all four inputs available.',
    };
  }

  // Adaptive
  const applicable = keys.filter((key) => parts[key] !== null);
  const totalWeight = applicable.reduce((sum, key) => sum + WEIGHTS[key], 0);

  const breakdown: ScoreBreakdownEntry[] = keys.map((key) => ({
    key,
    label: LABELS[key],
    value: parts[key],
    weight: totalWeight > 0 && parts[key] !== null ? WEIGHTS[key] / totalWeight : 0,
    applied: parts[key] !== null,
  }));

  if (applicable.length === 0 || totalWeight === 0) {
    return {
      score: 0,
      color: 'var(--c-gray-30)',
      label: 'fail',
      scoring,
      breakdown,
      note: 'No scoreable metrics available for this source.',
    };
  }

  const raw = applicable.reduce((sum, key) => sum + (parts[key] as number) * (WEIGHTS[key] / totalWeight), 0);
  const score = Math.round(raw);
  const { color, label } = scoreColor(score);

  const excluded = keys.filter((key) => parts[key] === null);
  const note =
    excluded.length === 0
      ? 'Adaptive scoring: all four inputs applicable; standard weights used.'
      : `${excluded.map((k) => LABELS[k]).join(' and ')} not applicable to this scope — ` +
        `excluded and remaining weights renormalized (` +
        applicable.map((k) => `${LABELS[k].toLowerCase()} ${(WEIGHTS[k] / totalWeight).toFixed(2)}`).join(', ') +
        `).`;

  return { score, color, label, scoring, breakdown, note };
}
