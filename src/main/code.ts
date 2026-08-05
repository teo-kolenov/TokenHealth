import {
  DEFAULT_SETTINGS,
  chunkJson,
  type CollectionSummary,
  type MainToUi,
  type Settings,
  type UiToMain,
} from '../shared/messages.ts';
import { extractVariables } from './extract.ts';
import { applyScanResult, scanDocument } from './scan.ts';
import { insertSummaryFrame } from './canvas.ts';
import { ScanCancelled, ScanControl } from './yield.ts';
import type { VariablesApi } from './figma-api.ts';

const SETTINGS_KEY = 'token-health-settings';

let control: ScanControl | null = null;

function post(message: MainToUi): void {
  figma.ui.postMessage(message);
}

/** figma.variables satisfies the narrow interface the extractor is typed against. */
const variablesApi = figma.variables as unknown as VariablesApi;

async function loadSettings(): Promise<Settings> {
  try {
    const stored = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Partial<Settings> | undefined;
    return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function summarizeCollections(): Promise<CollectionSummary[]> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync();
  return collections.map((collection) => ({
    name: collection.name,
    modes: collection.modes.map((m) => m.name),
    variableCount: variables.filter((v) => v.variableCollectionId === collection.id).length,
  }));
}

async function sendInit(): Promise<void> {
  const settings = await loadSettings();
  const collections = await summarizeCollections();

  // figma.fileKey is undefined for public Community plugins, so the source URL
  // is user-supplied rather than assumed.
  const fileKey = (figma as unknown as { fileKey?: string }).fileKey;

  post({
    type: 'INIT',
    settings,
    fileName: figma.root.name,
    figmaFileUrl: fileKey ? `https://www.figma.com/design/${fileKey}` : undefined,
    collections,
    hasVariables: collections.some((c) => c.variableCount > 0),
  });
}

async function run(settings: Settings): Promise<void> {
  control = new ScanControl((progress) => post({ type: 'PROGRESS', ...progress }));

  try {
    post({ type: 'PROGRESS', phase: 'variables', done: 0, total: 1, label: 'Reading variables' });

    const input = await extractVariables(variablesApi, {
      projectName: figma.root.name,
      figmaFileUrl: settings.figmaFileUrl || undefined,
      excludeHidden: settings.excludeHidden,
      onProgress: (done, total) => {
        if (done % 100 === 0) post({ type: 'PROGRESS', phase: 'aliases', done, total, label: 'Resolving aliases' });
      },
    });

    if (settings.scope !== 'none') {
      const scan = await scanDocument({
        scope: settings.scope,
        maxNodes: settings.maxNodes,
        input,
        control,
      });
      applyScanResult(input, scan, settings.scope);

      if (scan.stats.truncated) {
        figma.notify(`Scan stopped at ${settings.maxNodes.toLocaleString()} nodes — results are partial.`, {
          timeout: 4000,
        });
      }
    }

    post({ type: 'PROGRESS', phase: 'analyze', done: 1, total: 1, label: 'Analyzing' });

    const chunks = chunkJson(input);
    for (let i = 0; i < chunks.length; i++) {
      post({ type: 'RESULT_CHUNK', index: i, count: chunks.length, chunk: chunks[i] });
    }
  } catch (error) {
    if (error instanceof ScanCancelled) {
      post({ type: 'CANCELLED' });
      return;
    }
    post({
      type: 'ERROR',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    control = null;
  }
}

figma.showUI(__html__, { width: 346, height: 576, themeColors: true });

figma.ui.onmessage = async (message: UiToMain) => {
  switch (message.type) {
    case 'UI_READY':
      await sendInit();
      break;

    case 'RUN':
      await figma.clientStorage.setAsync(SETTINGS_KEY, message.settings).catch(() => undefined);
      await run(message.settings);
      break;

    case 'CANCEL':
      if (control) control.cancelled = true;
      break;

    case 'SAVE_SETTINGS':
      await figma.clientStorage.setAsync(SETTINGS_KEY, message.settings).catch(() => undefined);
      break;

    case 'INSERT_TO_CANVAS':
      try {
        await insertSummaryFrame(message.summary);
        post({ type: 'INSERTED' });
        figma.notify('Report frame inserted.');
      } catch (error) {
        post({ type: 'ERROR', message: error instanceof Error ? error.message : String(error) });
      }
      break;

    case 'NOTIFY':
      figma.notify(message.message, { error: message.error });
      break;

    case 'RESIZE':
      figma.ui.resize(message.width, message.height);
      break;

    case 'CLOSE':
      figma.closePlugin();
      break;
  }
};
