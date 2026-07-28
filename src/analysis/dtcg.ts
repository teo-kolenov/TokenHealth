import type { Collection, Group, NormalizedInput, Token, TokenType, TokenValue } from './types.ts';

/**
 * Importer for Figma's DTCG variable export.
 *
 * This exists so the plugin's output can be diffed against the export path on the
 * same source file. The export flattens aliases and emits one file per mode, so
 * anything produced here is marked sourceFidelity: 'dtcg-export' — which makes
 * alias coverage report N/A rather than a misleading 0%.
 */

interface DtcgLeaf {
  $type?: string;
  $value?: unknown;
  $description?: string;
  $extensions?: Record<string, unknown>;
}

function isLeaf(node: unknown): node is DtcgLeaf {
  return typeof node === 'object' && node !== null && '$value' in (node as Record<string, unknown>);
}

const TYPE_MAP: Record<string, TokenType> = {
  color: 'COLOR',
  number: 'FLOAT',
  dimension: 'DIMENSION',
  string: 'STRING',
  boolean: 'BOOLEAN',
  fontWeight: 'FLOAT',
  fontFamily: 'STRING',
};

function mapType(dtcgType: string | undefined): TokenType {
  if (!dtcgType) return 'OTHER';
  return TYPE_MAP[dtcgType] ?? 'OTHER';
}

function coerceValue(value: unknown): TokenValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

/** A DTCG `{group.token}` reference. Figma's exporter resolves these away. */
function aliasTargetOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\{(.+)\}$/.exec(value.trim());
  if (!match) return undefined;
  const path = match[1].split('.');
  return path[path.length - 1];
}

export interface DtcgFile {
  /** File contents, already JSON-parsed. */
  data: Record<string, unknown>;
  /** Used as the mode name when $extensions does not carry one. */
  fallbackModeName?: string;
}

export interface DtcgImportOptions {
  projectName: string;
  collectionName?: string;
  sourceLabel?: string;
  generatedAt?: string;
}

/**
 * Merge one or more per-mode DTCG files into a single normalized input.
 * Passing every mode file is what recovers real mode coverage from an export.
 */
export function importDtcg(files: DtcgFile[], options: DtcgImportOptions): NormalizedInput {
  const collectionName = options.collectionName ?? 'Variables';
  const modeNames: string[] = [];
  // groupName -> tokenName -> token
  const groups = new Map<string, { type: TokenType; tokens: Map<string, Token> }>();

  for (const file of files) {
    const extensions = file.data.$extensions as Record<string, unknown> | undefined;
    const modeName =
      (extensions?.['com.figma.modeName'] as string | undefined) ?? file.fallbackModeName ?? `Mode ${modeNames.length + 1}`;
    if (!modeNames.includes(modeName)) modeNames.push(modeName);

    walk(file.data, [], (path, leaf) => {
      const tokenName = path[path.length - 1];
      const groupName = path.slice(0, -1).join('/') || '(root)';
      const type = mapType(leaf.$type);

      let group = groups.get(groupName);
      if (!group) {
        group = { type, tokens: new Map() };
        groups.set(groupName, group);
      }

      const figmaExtensions = leaf.$extensions ?? {};
      const existing = group.tokens.get(tokenName);
      const value = coerceValue(leaf.$value);
      const alias = aliasTargetOf(leaf.$value);

      if (existing) {
        existing.modes = [...(existing.modes ?? []), modeName];
        existing.valuesByMode = { ...(existing.valuesByMode ?? {}), [modeName]: value };
      } else {
        group.tokens.set(tokenName, {
          name: tokenName,
          value,
          modes: [modeName],
          description: leaf.$description,
          aliasOf: alias,
          aliasInAnyMode: alias !== undefined ? true : undefined,
          chainDepth: alias !== undefined ? 1 : undefined,
          figmaVariableId: figmaExtensions['com.figma.variableId'] as string | undefined,
          scopes: figmaExtensions['com.figma.scopes'] as string[] | undefined,
          valuesByMode: { [modeName]: value },
        });
      }
    });
  }

  const collection: Collection = {
    name: collectionName,
    modes: modeNames,
    groups: [...groups.entries()].map(
      ([name, group]): Group => ({
        name,
        type: group.type,
        tokens: [...group.tokens.values()],
      }),
    ),
  };

  return {
    meta: {
      projectName: options.projectName,
      sourceLabel: options.sourceLabel,
      generatedAt: options.generatedAt,
      // The critical flag: tells the analyzer that alias data is structurally
      // absent rather than genuinely zero.
      sourceFidelity: 'dtcg-export',
      modeNames,
    },
    collections: [collection],
  };
}

function walk(node: unknown, path: string[], visit: (path: string[], leaf: DtcgLeaf) => void): void {
  if (typeof node !== 'object' || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith('$')) continue;
    if (isLeaf(value)) visit([...path, key], value);
    else walk(value, [...path, key], visit);
  }
}
