import type { VariableCollectionLike, VariableLike, VariablesApi } from './figma-api.ts';
import { createContext, resolveAlias } from './alias-resolve.ts';
import type { Collection, Group, NormalizedInput, Token, TokenType, TokenValue } from '../analysis/types.ts';

/** Scopes that indicate a FLOAT is really a dimension. */
const DIMENSIONAL = new Set([
  'WIDTH_HEIGHT',
  'GAP',
  'CORNER_RADIUS',
  'STROKE_FLOAT',
  'PARAGRAPH_SPACING',
  'PARAGRAPH_INDENT',
]);

const TYPE_MAP: Record<VariableLike['resolvedType'], TokenType> = {
  COLOR: 'COLOR',
  FLOAT: 'FLOAT',
  STRING: 'STRING',
  BOOLEAN: 'BOOLEAN',
};

export interface ExtractOptions {
  projectName: string;
  figmaFileUrl?: string;
  generatedAt?: string;
  /** Skip variables hidden from publishing. */
  excludeHidden?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/** Split a Figma slash-path name into group path + leaf token name. */
export function splitVariableName(name: string): { group: string; token: string } {
  const parts = name
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const token = parts.pop() ?? name;
  return { group: parts.join('/') || '(root)', token };
}

/**
 * A collection's modes are a theme axis only if they read as light/dark.
 * Mobile/Desktop is a platform axis and must not be measured for theme parity.
 */
const LIGHT = /^(light|day|светл)/i;
const DARK = /^(dark|night|тёмн|темн)/i;

function isThemeAxis(collection: VariableCollectionLike): boolean {
  if (collection.modes.length < 2) return false;
  return collection.modes.some((m) => LIGHT.test(m.name)) && collection.modes.some((m) => DARK.test(m.name));
}

function groupType(variables: VariableLike[]): { type: TokenType; mixed: boolean } {
  const types = new Set(variables.map((v) => TYPE_MAP[v.resolvedType] ?? 'OTHER'));
  if (types.size > 1) return { type: 'OTHER', mixed: true };
  const [only] = [...types];
  if (only === 'FLOAT') {
    const allDimensional = variables.every(
      (v) => (v.scopes ?? []).length > 0 && (v.scopes ?? []).every((s) => DIMENSIONAL.has(s)),
    );
    if (allDimensional) return { type: 'DIMENSION', mixed: false };
  }
  return { type: only ?? 'OTHER', mixed: false };
}

/**
 * Read every local variable into the normalized shape the analyzer consumes.
 *
 * Unlike a DTCG export this captures all modes at once and preserves live alias
 * references, so alias coverage and mode data are real rather than artifacts.
 */
export async function extractVariables(api: VariablesApi, options: ExtractOptions): Promise<NormalizedInput> {
  const collections = await api.getLocalVariableCollectionsAsync();
  const variables = await api.getLocalVariablesAsync();

  const included = options.excludeHidden ? variables.filter((v) => !v.hiddenFromPublishing) : variables;
  const ctx = createContext(variables, collections, api);

  const allModeNames = new Set<string>();
  const outCollections: Collection[] = [];
  let processed = 0;

  for (const collection of collections) {
    const members = included.filter((v) => v.variableCollectionId === collection.id);
    if (members.length === 0) continue;

    for (const mode of collection.modes) allModeNames.add(mode.name);

    // Bucket by group path.
    const byGroup = new Map<string, VariableLike[]>();
    for (const variable of members) {
      const { group } = splitVariableName(variable.name);
      const bucket = byGroup.get(group);
      if (bucket) bucket.push(variable);
      else byGroup.set(group, [variable]);
    }

    const groups: Group[] = [];
    for (const [groupName, groupVariables] of byGroup) {
      const { type, mixed } = groupType(groupVariables);
      const tokens: Token[] = [];

      for (const variable of groupVariables) {
        const { token: leaf } = splitVariableName(variable.name);
        const valuesByMode: Record<string, TokenValue | null> = {};
        const modes: string[] = [];

        let aliasInAnyMode = false;
        let broken = false;
        let cyclic = false;
        let modeMappingFallback = false;
        let defaultResolved: TokenValue | null = null;
        let defaultAliasTarget: string | undefined;
        let defaultDepth: number | undefined;
        let defaultChain: string[] | undefined;

        for (const mode of collection.modes) {
          // A variable can legitimately have no value in some mode.
          if (variable.valuesByMode[mode.modeId] === undefined) {
            valuesByMode[mode.name] = null;
            continue;
          }
          modes.push(mode.name);

          const resolved = await resolveAlias(variable, mode.modeId, mode.name, ctx);
          valuesByMode[mode.name] = resolved.finalValue;

          if (resolved.isAlias) aliasInAnyMode = true;
          if (resolved.broken) broken = true;
          if (resolved.cyclic) cyclic = true;
          if (resolved.modeMappingFallback) modeMappingFallback = true;

          if (mode.modeId === collection.defaultModeId) {
            defaultResolved = resolved.finalValue;
            defaultAliasTarget = resolved.chain[0];
            defaultDepth = resolved.isAlias ? resolved.depth : undefined;
            defaultChain = resolved.chain.length > 0 ? resolved.chain : undefined;
          }
        }

        // Fall back to any resolved mode when the default mode carried no value.
        const fallbackValue =
          defaultResolved ?? Object.values(valuesByMode).find((v) => v !== null) ?? '(unresolved)';

        tokens.push({
          name: leaf,
          value: fallbackValue,
          modes,
          description: variable.description || undefined,
          aliasOf: defaultAliasTarget,
          chainDepth: defaultDepth,
          aliasInAnyMode: aliasInAnyMode || undefined,
          aliasChain: defaultChain,
          aliasBroken: broken || undefined,
          aliasCyclic: cyclic || undefined,
          modeMappingFallback: modeMappingFallback || undefined,
          external: variable.remote || undefined,
          valueUnavailable: defaultResolved === null && broken ? true : undefined,
          figmaVariableId: variable.id,
          valuesByMode,
          scopes: variable.scopes,
          codeSyntax: variable.codeSyntax,
        });

        processed++;
        options.onProgress?.(processed, included.length);
      }

      groups.push({ name: groupName, type, tokens, mixedTypes: mixed || undefined });
    }

    groups.sort((a, b) => a.name.localeCompare(b.name));

    outCollections.push({
      name: collection.name,
      modes: collection.modes.map((m) => m.name),
      themeAxis: isThemeAxis(collection) || undefined,
      groups,
    });
  }

  return {
    meta: {
      projectName: options.projectName,
      figmaFileUrl: options.figmaFileUrl,
      sourceLabel: `Figma variables — ${outCollections.length} collection${outCollections.length === 1 ? '' : 's'}`,
      generatedAt: options.generatedAt ?? new Date().toISOString().slice(0, 10),
      // Tells the analyzer that alias and mode data here are trustworthy.
      sourceFidelity: 'figma-plugin',
      modeNames: [...allModeNames],
    },
    collections: outCollections,
  };
}
