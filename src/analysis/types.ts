/**
 * Normalized input + analysis result types.
 *
 * The input shape matches token-health-analysis/schema/token-health-input.schema.json.
 * That schema sets `additionalProperties: true` at every level, so the extra Figma
 * fields below (figmaVariableId, valuesByMode, aliasChain, ...) are schema-legal.
 */

export type TokenType = 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN' | 'DIMENSION' | 'OTHER';

export type TokenValue = string | number | boolean;

/** How the input was obtained. Drives the source-fidelity badge. */
export type SourceFidelity = 'figma-plugin' | 'dtcg-export' | 'text' | 'unknown';

export interface Meta {
  projectName: string;
  figmaFileUrl?: string;
  sourceLabel?: string;
  generatedAt?: string;
  /** Extensions */
  sourceFidelity?: SourceFidelity;
  modeNames?: string[];
  scanScope?: string;
  scanTruncated?: boolean;
  scannedNodes?: number;
}

export interface Token {
  name: string;
  value: TokenValue;
  modes?: string[];
  description?: string;
  aliasOf?: string;
  chainDepth?: number;
  usedBy?: string[];

  /** ---- Extensions (Figma plugin path only) ---- */
  figmaVariableId?: string;
  /** Resolved value per mode name. Present only via the plugin path. */
  valuesByMode?: Record<string, TokenValue | null>;
  /** Whether this token aliases another in at least one mode. */
  aliasInAnyMode?: boolean;
  aliasChain?: string[];
  aliasBroken?: boolean;
  aliasCyclic?: boolean;
  /** Alias target lives in another collection whose modes had to be mapped by name. */
  modeMappingFallback?: boolean;
  /** Variable came from a subscribed library; value may be unavailable. */
  external?: boolean;
  valueUnavailable?: boolean;
  usageCount?: number;
  scopes?: string[];
  codeSyntax?: Record<string, string>;
}

export interface Group {
  name: string;
  type: TokenType;
  tokens: Token[];
  /** Extension: set when member resolvedTypes disagreed. */
  mixedTypes?: boolean;
}

export interface Collection {
  name: string;
  groups: Group[];
  /** Extension: every mode name defined on this collection. */
  modes?: string[];
  /** Extension: true when the collection's modes look like a light/dark theme axis. */
  themeAxis?: boolean;
}

export interface ComponentUsage {
  name: string;
  modeCoverage?: Record<string, boolean> & { light?: boolean; dark?: boolean };
  tokens?: string[];
  /** Extensions */
  colorTokenCount?: number;
  literalCount?: number;
  reason?: string;
}

export interface DirectOverride {
  area: string;
  literal: string;
  replacement: string;
  details?: string;
  /** Extension: informational overrides (pure white/black) do not count as failures. */
  severity?: Severity;
  occurrences?: number;
}

export interface NormalizedInput {
  meta: Meta;
  collections: Collection[];
  components?: ComponentUsage[];
  directCssOverrides?: DirectOverride[];
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

export type Severity = 'high' | 'warn' | 'info';

/** Weight each severity contributes to the duplicate count fed into the score. */
export const SEVERITY_WEIGHT: Record<Severity, number> = { high: 1, warn: 0.5, info: 0 };

export type Heuristic = 'H1' | 'H2' | 'H3';

export interface TokenRef {
  name: string;
  collection: string;
  group: string;
  type: TokenType;
  value: TokenValue;
}

export interface DuplicateFinding {
  a: TokenRef;
  b: TokenRef;
  heuristic: Heuristic;
  severity: Severity;
  evidence: string;
  normalizationTarget: string;
}

export interface NamingFailure {
  token: TokenRef;
  reason: string;
}

export interface TypoFinding {
  token: TokenRef;
  nearest: TokenRef;
  distance: number;
  evidence: string;
}

/** Two groups whose values run in parallel — informational, not a duplicate. */
export interface ParallelScaleFinding {
  collection: string;
  groupA: string;
  groupB: string;
  sharedSteps: number;
  totalA: number;
  totalB: number;
  evidence: string;
}

export interface ReuseRow {
  token: string;
  count: number;
}

export interface ModeCoverageRow {
  component: string;
  modes: Record<string, boolean>;
  covered: number;
  total: number;
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* Metrics + result                                                    */
/* ------------------------------------------------------------------ */

export interface Metrics {
  totalTokens: number;
  totalCollections: number;
  totalGroups: number;

  /** Alias metrics. null when the source cannot express aliases at all. */
  aliasTokens: number;
  aliasLayerCoverage: number | null;
  orphanedAliases: number;
  cyclicAliases: number;
  avgChainDepth: number | null;

  namingCompliance: number | null;
  namingFailures: NamingFailure[];
  typos: TypoFinding[];

  duplicates: DuplicateFinding[];
  duplicateBreakdown: Record<Severity, number>;
  /** Severity-weighted duplicate count — this is what the score consumes. */
  weightedDuplicates: number;
  parallelScales: ParallelScaleFinding[];

  directOverrides: DirectOverride[];
  directOverrideCount: number;

  modeCoverage: number | null;
  modeCoverageRows: ModeCoverageRow[];
  themeModes: string[];

  reuse: ReuseRow[];
  hasUsageData: boolean;

  globalTokenViolations: number;
  modeNames: string[];
}

export type Scoring = 'strict' | 'adaptive';

export interface ScoreBreakdownEntry {
  key: string;
  label: string;
  value: number | null;
  weight: number;
  applied: boolean;
}

export interface ScoreResult {
  score: number;
  color: string;
  label: 'ok' | 'warn' | 'fail';
  scoring: Scoring;
  breakdown: ScoreBreakdownEntry[];
  /** Human-readable explanation of any renormalization. */
  note: string;
}

export interface AnalyzeOptions {
  scoring?: Scoring;
  /** Treat padding/spacing/gap/margin as one role. Default false. */
  mergeSpacingRoles?: boolean;
  /** Names/patterns identifying the primitive layer. */
  primitivePattern?: RegExp;
  generatedAt?: string;
}

export interface AnalysisResult {
  input: NormalizedInput;
  metrics: Metrics;
  score: ScoreResult;
  options: Required<Pick<AnalyzeOptions, 'scoring' | 'mergeSpacingRoles'>>;
  /** Assumptions and N/A explanations surfaced in the report. */
  notes: string[];
}
