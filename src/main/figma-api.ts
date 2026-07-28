/**
 * Narrow structural interfaces over the Figma variables API.
 *
 * The extractor is typed against these rather than the `figma` global so it can
 * be unit-tested with plain object fixtures — covering alias chains, cycles,
 * broken targets and cross-collection mode mismatches without a live file.
 */

export interface VariableAliasValue {
  type: 'VARIABLE_ALIAS';
  id: string;
}

export interface RGBValue {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export type AnyVariableValue = boolean | number | string | RGBValue | VariableAliasValue;

export interface VariableLike {
  id: string;
  name: string;
  key?: string;
  resolvedType: 'BOOLEAN' | 'COLOR' | 'FLOAT' | 'STRING';
  valuesByMode: Record<string, AnyVariableValue>;
  description?: string;
  scopes?: string[];
  codeSyntax?: Record<string, string>;
  variableCollectionId: string;
  remote?: boolean;
  hiddenFromPublishing?: boolean;
}

export interface ModeLike {
  modeId: string;
  name: string;
}

export interface VariableCollectionLike {
  id: string;
  name: string;
  modes: ModeLike[];
  defaultModeId: string;
  remote?: boolean;
}

/** The subset of `figma.variables` the extractor needs. */
export interface VariablesApi {
  getLocalVariableCollectionsAsync(): Promise<VariableCollectionLike[]>;
  getLocalVariablesAsync(): Promise<VariableLike[]>;
  getVariableByIdAsync(id: string): Promise<VariableLike | null>;
}

export function isAlias(value: AnyVariableValue | undefined): value is VariableAliasValue {
  return typeof value === 'object' && value !== null && (value as VariableAliasValue).type === 'VARIABLE_ALIAS';
}

export function isColor(value: AnyVariableValue | undefined): value is RGBValue {
  return typeof value === 'object' && value !== null && 'r' in value && 'g' in value && 'b' in value;
}
