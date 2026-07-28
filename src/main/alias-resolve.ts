import { isAlias, isColor } from './figma-api.ts';
import type {
  AnyVariableValue,
  ModeLike,
  VariableCollectionLike,
  VariableLike,
  VariablesApi,
} from './figma-api.ts';
import { rgbaToHex } from './color.ts';
import type { TokenValue } from '../analysis/types.ts';

/**
 * Alias chain resolution.
 *
 * This is the capability the DTCG export path structurally lacks: the exporter
 * resolves aliases to literals before writing the file, so alias coverage always
 * computes to 0%. Here the alias graph is live and walkable.
 */

/** Guards against a pathological or malicious graph regardless of the cycle check. */
const MAX_DEPTH = 16;

export interface ResolvedAlias {
  /** Final literal value after following the chain, or null if unresolvable. */
  finalValue: TokenValue | null;
  /** Variable names traversed, source first, excluding the starting variable. */
  chain: string[];
  depth: number;
  isAlias: boolean;
  /** A hop returned null — the target was deleted or is an unavailable remote. */
  broken: boolean;
  cyclic: boolean;
  crossCollection: boolean;
  /** Target collection had no mode matching by name; fell back to its default. */
  modeMappingFallback: boolean;
}

export interface ResolveContext {
  byId: Map<string, VariableLike>;
  collections: Map<string, VariableCollectionLike>;
  api: VariablesApi;
  memo: Map<string, ResolvedAlias>;
}

export function createContext(
  variables: VariableLike[],
  collections: VariableCollectionLike[],
  api: VariablesApi,
): ResolveContext {
  return {
    byId: new Map(variables.map((v) => [v.id, v])),
    collections: new Map(collections.map((c) => [c.id, c])),
    api,
    memo: new Map(),
  };
}

export function literalValue(value: AnyVariableValue): TokenValue {
  if (isColor(value)) return rgbaToHex(value);
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  return String(value);
}

/**
 * Pick the mode to follow when an alias crosses into another collection.
 *
 * Mode ids are collection-scoped, so the source mode id is meaningless in the
 * target. Match by mode name, fall back to a sole mode, then to the collection
 * default — and report when the fallback was used, because a semantic layer whose
 * Dark values resolve through another collection's default mode is a real smell.
 */
export function pickModeId(
  target: VariableCollectionLike,
  sourceModeName: string,
): { modeId: string; fallback: boolean } {
  const byName = target.modes.find(
    (m: ModeLike) => m.name.trim().toLowerCase() === sourceModeName.trim().toLowerCase(),
  );
  if (byName) return { modeId: byName.modeId, fallback: false };
  if (target.modes.length === 1) return { modeId: target.modes[0].modeId, fallback: false };
  return { modeId: target.defaultModeId, fallback: true };
}

async function lookup(ctx: ResolveContext, id: string): Promise<VariableLike | null> {
  const cached = ctx.byId.get(id);
  if (cached) return cached;
  // Remote / library variables enter the graph here.
  const fetched = await ctx.api.getVariableByIdAsync(id);
  if (fetched) ctx.byId.set(id, fetched);
  return fetched;
}

export async function resolveAlias(
  variable: VariableLike,
  modeId: string,
  modeName: string,
  ctx: ResolveContext,
): Promise<ResolvedAlias> {
  const memoKey = `${variable.id}:${modeId}`;
  const memoized = ctx.memo.get(memoKey);
  if (memoized) return memoized;

  const chain: string[] = [];
  const visited = new Set<string>([memoKey]);

  let current: VariableLike = variable;
  let currentModeId = modeId;
  let currentModeName = modeName;
  let crossCollection = false;
  let modeMappingFallback = false;
  let startedAsAlias = false;

  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    const raw: AnyVariableValue | undefined = current.valuesByMode[currentModeId];

    // No value in this mode is a real signal, not something to paper over.
    if (raw === undefined) {
      const result: ResolvedAlias = {
        finalValue: null,
        chain,
        depth: chain.length,
        isAlias: startedAsAlias,
        broken: true,
        cyclic: false,
        crossCollection,
        modeMappingFallback,
      };
      ctx.memo.set(memoKey, result);
      return result;
    }

    if (!isAlias(raw)) {
      const result: ResolvedAlias = {
        finalValue: literalValue(raw),
        chain,
        depth: chain.length,
        isAlias: startedAsAlias,
        broken: false,
        cyclic: false,
        crossCollection,
        modeMappingFallback,
      };
      ctx.memo.set(memoKey, result);
      return result;
    }

    startedAsAlias = true;
    const target = await lookup(ctx, raw.id);

    if (!target) {
      const result: ResolvedAlias = {
        finalValue: null,
        chain,
        depth: chain.length,
        isAlias: true,
        broken: true,
        cyclic: false,
        crossCollection,
        modeMappingFallback,
      };
      ctx.memo.set(memoKey, result);
      return result;
    }

    if (target.variableCollectionId !== current.variableCollectionId) {
      crossCollection = true;
      const targetCollection = ctx.collections.get(target.variableCollectionId);
      if (targetCollection) {
        const picked = pickModeId(targetCollection, currentModeName);
        currentModeId = picked.modeId;
        if (picked.fallback) modeMappingFallback = true;
        const resolvedMode = targetCollection.modes.find((m) => m.modeId === currentModeId);
        currentModeName = resolvedMode?.name ?? currentModeName;
      }
    }

    const nextKey = `${target.id}:${currentModeId}`;
    if (visited.has(nextKey)) {
      const result: ResolvedAlias = {
        finalValue: null,
        chain,
        depth: chain.length,
        isAlias: true,
        broken: false,
        cyclic: true,
        crossCollection,
        modeMappingFallback,
      };
      ctx.memo.set(memoKey, result);
      return result;
    }

    visited.add(nextKey);
    chain.push(target.name);
    current = target;
  }

  // Depth cap exceeded — treat as cyclic rather than looping forever.
  const result: ResolvedAlias = {
    finalValue: null,
    chain,
    depth: chain.length,
    isAlias: true,
    broken: false,
    cyclic: true,
    crossCollection,
    modeMappingFallback,
  };
  ctx.memo.set(memoKey, result);
  return result;
}
