import type { NormalizedInput, Token } from './types.ts';

export interface AliasReport {
  aliasTokens: number;
  /** null when the source format cannot express aliases at all. */
  coverage: number | null;
  orphaned: number;
  cyclic: number;
  avgChainDepth: number | null;
  /** True when the input carries any alias signal whatsoever. */
  aliasCapable: boolean;
  modeMappingFallbacks: number;
}

function allTokens(input: NormalizedInput): Token[] {
  const out: Token[] = [];
  for (const c of input.collections) for (const g of c.groups) for (const t of g.tokens) out.push(t);
  return out;
}

/**
 * Alias coverage is the metric the DTCG export path gets structurally wrong.
 *
 * A Figma DTCG export resolves every alias to a literal before writing the file,
 * so `aliasOf` is absent on every token and coverage computes to a hard 0% — a
 * number that looks like a damning architecture finding but is really an artifact
 * of the export format.
 *
 * We distinguish "no aliases exist" from "this source cannot express aliases":
 *   - meta.sourceFidelity === 'figma-plugin'  -> alias data is trustworthy; 0% is real
 *   - any token carries alias fields          -> alias data is present; trust it
 *   - otherwise                               -> coverage is null (renders N/A)
 */
export function analyzeAliases(input: NormalizedInput): AliasReport {
  const tokens = allTokens(input);
  const total = tokens.length;

  const aliasCapable =
    input.meta.sourceFidelity === 'figma-plugin' ||
    tokens.some((t) => t.aliasOf !== undefined || t.aliasInAnyMode !== undefined || t.chainDepth !== undefined);

  const aliased = tokens.filter((t) => t.aliasInAnyMode === true || (t.aliasOf !== undefined && t.aliasOf !== ''));
  const orphaned = tokens.filter((t) => t.aliasBroken === true).length;
  const cyclic = tokens.filter((t) => t.aliasCyclic === true).length;
  const modeMappingFallbacks = tokens.filter((t) => t.modeMappingFallback === true).length;

  const depths = aliased.map((t) => t.chainDepth ?? 1).filter((d) => d > 0);
  const avgChainDepth = depths.length > 0 ? depths.reduce((a, b) => a + b, 0) / depths.length : null;

  return {
    aliasTokens: aliased.length,
    coverage: aliasCapable && total > 0 ? (aliased.length / total) * 100 : null,
    orphaned,
    cyclic,
    avgChainDepth,
    aliasCapable,
    modeMappingFallbacks,
  };
}
