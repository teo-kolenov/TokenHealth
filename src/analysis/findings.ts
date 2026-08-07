import type { AnalysisResult } from './types.ts';

/**
 * The short headline list of what is actually wrong with the token set.
 *
 * Three surfaces render this: the plugin's report screen, the summary frame it
 * can insert onto the canvas, and the "Key findings" section at the foot of the
 * downloaded HTML dashboard. It lives here so those three can never disagree
 * about what the top problems are — previously the logic sat inline in the UI
 * layer and only the canvas frame had it.
 *
 * Ordered by how actionable the finding is, not by severity weight: a typo is
 * a one-character fix, a duplicate is a decision, and the aggregate counts are
 * background. Callers may take the first N and still get the useful ones.
 */
export function deriveKeyFindings(analysis: AnalysisResult): string[] {
  const m = analysis.metrics;
  const findings: string[] = [];

  for (const typo of m.typos.slice(0, 2)) {
    findings.push(`Possible typo: "${typo.token.name}" vs "${typo.nearest.name}"`);
  }

  for (const dup of m.duplicates.filter((d) => d.severity === 'high').slice(0, 2)) {
    findings.push(`Duplicate: ${dup.a.name} and ${dup.b.name}`);
  }

  if (m.namingFailures.length > 0) {
    findings.push(`${m.namingFailures.length} tokens fail the naming convention (${m.namingFailures[0].reason})`);
  }

  for (const parallel of m.parallelScales.slice(0, 1)) {
    findings.push(
      `${parallel.groupA} and ${parallel.groupB} are parallel scales sharing ${parallel.sharedSteps} values`,
    );
  }

  if (m.directOverrideCount > 0) {
    findings.push(`${m.directOverrideCount} hardcoded color literals found`);
  }

  return findings;
}
