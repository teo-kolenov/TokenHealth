import type { AnalysisResult, TokenRef } from './types.ts';

/**
 * Every token bucketed by its worst finding, so the three counts sum to the
 * token total and the bars beside the health ring are genuinely proportional.
 *
 * A token can trip several checks at once; it is counted once, at its highest
 * severity (errors > warnings > passed). Without that precedence pass the
 * numbers would overcount and no longer add up to the total.
 *
 * Two things deliberately do NOT demote a token:
 *
 * - Informational duplicates. `duplicates.ts` weights them 0 toward the health
 *   score because a semantic token mirroring a primitive is the point of an
 *   alias layer, not a defect. The tally has to agree with the score, or the
 *   same token is "fine" in one number and "flagged" in another.
 *
 * - Parallel scales. That finding is an observation about two *groups*
 *   ("padding and spacing share 10 values"), not about any individual token.
 *   Attributing it to every member demoted whole scales at once — on a sizing
 *   collection it flagged padding, spacing and radius together and drove
 *   Passed to zero, which is why it is reported in Key findings instead.
 *
 * Direct color overrides are absent for a related reason: they are scene-node
 * findings with no token to attribute them to. They keep their own chip.
 */
export interface SeverityTally {
  passed: number;
  warnings: number;
  errors: number;
  total: number;
}

/**
 * Leaf token names are not unique across the file — two collections can each
 * have a `color-brand-50`. Key on the full path so distinct tokens never
 * collapse into one bucket entry.
 */
const SEP = ' ';
const pathKey = (collection: string, group: string, name: string) => `${collection}${SEP}${group}${SEP}${name}`;
const refKey = (ref: TokenRef) => pathKey(ref.collection, ref.group, ref.name);

export function tallyTokens(analysis: AnalysisResult): SeverityTally {
  const m = analysis.metrics;
  const errors = new Set<string>();
  const warnings = new Set<string>();

  // Structural breakage: an alias pointing at nothing, or a cycle.
  for (const collection of analysis.input.collections) {
    for (const group of collection.groups) {
      for (const token of group.tokens) {
        if (token.aliasBroken || token.aliasCyclic) {
          errors.add(pathKey(collection.name, group.name, token.name));
        }
      }
    }
  }

  for (const duplicate of m.duplicates) {
    if (duplicate.severity === 'high') {
      errors.add(refKey(duplicate.a));
      errors.add(refKey(duplicate.b));
    } else if (duplicate.severity === 'warn') {
      warnings.add(refKey(duplicate.a));
      warnings.add(refKey(duplicate.b));
    }
    // 'info' duplicates score 0 — see the note above.
  }

  for (const failure of m.namingFailures) warnings.add(refKey(failure.token));
  for (const typo of m.typos) warnings.add(refKey(typo.token));

  // Worst severity wins, so each token is counted exactly once.
  for (const key of errors) warnings.delete(key);

  const total = m.totalTokens;
  const flagged = errors.size + warnings.size;

  return {
    errors: errors.size,
    warnings: warnings.size,
    // Clamped because a finding could reference a token outside the counted
    // set; passed must never render negative.
    passed: Math.max(0, total - flagged),
    total,
  };
}
