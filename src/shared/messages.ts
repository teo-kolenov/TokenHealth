import type { NormalizedInput, Scoring } from '../analysis/types.ts';

export type ScanScope = 'none' | 'selection' | 'page' | 'document';

export interface Settings {
  scope: ScanScope;
  scoring: Scoring;
  mergeSpacingRoles: boolean;
  excludeHidden: boolean;
  maxNodes: number;
  figmaFileUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  // Deliberately not 'document': a whole-file scan on a large design system is
  // slow, and the user should opt into it knowingly.
  scope: 'page',
  scoring: 'adaptive',
  mergeSpacingRoles: false,
  excludeHidden: false,
  maxNodes: 150_000,
  figmaFileUrl: '',
};

export type Phase = 'variables' | 'aliases' | 'scan' | 'analyze' | 'render';

export interface CollectionSummary {
  name: string;
  modes: string[];
  variableCount: number;
}

export type UiToMain =
  | { type: 'UI_READY' }
  | { type: 'RUN'; settings: Settings }
  | { type: 'CANCEL' }
  | { type: 'SAVE_SETTINGS'; settings: Settings }
  | { type: 'INSERT_TO_CANVAS'; summary: CanvasSummary }
  | { type: 'NOTIFY'; message: string; error?: boolean }
  | { type: 'RESIZE'; width: number; height: number }
  | { type: 'CLOSE' };

export type MainToUi =
  | {
      type: 'INIT';
      settings: Settings;
      fileName: string;
      figmaFileUrl?: string;
      collections: CollectionSummary[];
      hasVariables: boolean;
    }
  | { type: 'PROGRESS'; phase: Phase; done: number; total: number; label: string }
  /**
   * The normalized input is sent as chunked JSON rather than a structured clone.
   * A large design system serializes to several MB, and slicing it keeps the
   * transfer predictable and gives free progress reporting.
   */
  | { type: 'RESULT_CHUNK'; index: number; count: number; chunk: string }
  | { type: 'CANCELLED' }
  | { type: 'INSERTED' }
  | { type: 'ERROR'; message: string; stack?: string };

export const CHUNK_SIZE = 512 * 1024;

export function chunkJson(input: NormalizedInput): string[] {
  const json = JSON.stringify(input);
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += CHUNK_SIZE) chunks.push(json.slice(i, i + CHUNK_SIZE));
  return chunks.length > 0 ? chunks : [''];
}

/** Compact payload for the canvas summary frame. */
export interface CanvasSummary {
  projectName: string;
  score: number;
  scoreLabel: string;
  scoreColor: [number, number, number];
  generatedAt: string;
  stats: { label: string; value: string; status: 'ok' | 'warn' | 'fail' | 'muted' }[];
  findings: string[];
}
