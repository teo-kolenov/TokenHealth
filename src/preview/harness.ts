import { extractVariables } from '../main/extract.ts';
import { applyScanResult } from '../main/scan.ts';
import { chunkJson, DEFAULT_SETTINGS, type MainToUi, type Settings, type UiToMain } from '../shared/messages.ts';
import { collections, mockScanData, mockVariablesApi, variables } from './design-system-mock.ts';
import type { ComponentUsage, DirectOverride } from '../analysis/types.ts';

/**
 * Stands in for the Figma main thread.
 *
 * Everything downstream of the Figma API is the real thing: the real extractor,
 * the real alias resolver, the real analyzer and renderer, and the real UI
 * bundle loaded into an iframe over the same postMessage protocol Figma uses.
 * Only `figma.variables` and the scene graph are mocked.
 */

const frame = document.getElementById('plugin-frame') as HTMLIFrameElement;
const canvas = document.getElementById('canvas-content') as HTMLElement;
const toasts = document.getElementById('toasts') as HTMLElement;

let settings: Settings = { ...DEFAULT_SETTINGS };
let cancelled = false;

function toUi(message: MainToUi): void {
  frame.contentWindow?.postMessage({ pluginMessage: message }, '*');
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function notify(text: string, isError = false): void {
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' error' : ''}`;
  toast.textContent = text;
  toasts.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2600);
}

async function sendInit(): Promise<void> {
  toUi({
    type: 'INIT',
    settings,
    fileName: 'Example Design System',
    // Undefined for public Community plugins — the UI must cope without it.
    figmaFileUrl: undefined,
    collections: collections.map((collection) => ({
      name: collection.name,
      modes: collection.modes.map((m) => m.name),
      variableCount: variables.filter((v) => v.variableCollectionId === collection.id).length,
    })),
    hasVariables: true,
  });
}

async function run(next: Settings): Promise<void> {
  settings = next;
  cancelled = false;

  toUi({ type: 'PROGRESS', phase: 'variables', done: 0, total: 1, label: 'Reading variable collections' });
  await wait(320);

  // The real extractor, against the mock API.
  const input = await extractVariables(mockVariablesApi, {
    projectName: 'Example Design System',
    figmaFileUrl: settings.figmaFileUrl || undefined,
    excludeHidden: settings.excludeHidden,
    generatedAt: new Date().toISOString().slice(0, 10),
  });

  const total = variables.length;
  for (let done = 0; done <= total; done += Math.ceil(total / 6)) {
    if (cancelled) return void toUi({ type: 'CANCELLED' });
    toUi({ type: 'PROGRESS', phase: 'aliases', done: Math.min(done, total), total, label: 'Resolving alias chains' });
    await wait(140);
  }

  if (settings.scope !== 'none') {
    const scan = mockScanData();
    const pages = settings.scope === 'document' ? scan.stats.pages : 1;
    const nodes = settings.scope === 'document' ? scan.stats.nodes : Math.round(scan.stats.nodes / scan.stats.pages);

    for (let done = 0; done <= nodes; done += Math.ceil(nodes / 10)) {
      if (cancelled) return void toUi({ type: 'CANCELLED' });
      toUi({
        type: 'PROGRESS',
        phase: 'scan',
        done: Math.min(done, nodes),
        total: nodes,
        label: settings.scope === 'document' ? `Scanning ${pages} pages` : 'Scanning current page',
      });
      await wait(110);
    }

    applyScanResult(
      input,
      {
        usageByVariableId: scan.usageByVariableId,
        overrides: scan.overrides as DirectOverride[],
        components: scan.components as ComponentUsage[],
        stats: { ...scan.stats, pages, nodes },
      },
      settings.scope,
    );
  }

  toUi({ type: 'PROGRESS', phase: 'analyze', done: 1, total: 1, label: 'Analyzing tokens' });
  await wait(260);

  const chunks = chunkJson(input);
  for (let i = 0; i < chunks.length; i++) {
    toUi({ type: 'RESULT_CHUNK', index: i, count: chunks.length, chunk: chunks[i] });
  }
}

/** Draws a stand-in for the frame the plugin would insert onto the canvas. */
function insertFrame(summary: { projectName: string; score: number; stats: { label: string; value: string; status: string }[]; findings: string[] }): void {
  const node = document.createElement('div');
  node.className = 'canvas-frame';
  node.innerHTML =
    `<div class="canvas-frame-label">Token Health — ${summary.projectName}</div>` +
    `<div class="canvas-frame-body">` +
    `<div class="cf-accent"></div>` +
    `<div class="cf-title">Token Health Analysis</div>` +
    `<div class="cf-score">${summary.score}%</div>` +
    summary.stats
      .map((s) => `<div class="cf-row"><span>${s.label}</span><b class="${s.status}">${s.value}</b></div>`)
      .join('') +
    (summary.findings.length
      ? `<div class="cf-findings">${summary.findings.slice(0, 4).map((f) => `<div>• ${f}</div>`).join('')}</div>`
      : '') +
    `</div>`;
  canvas.appendChild(node);
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

window.addEventListener('message', async (event: MessageEvent) => {
  const message = event.data?.pluginMessage as UiToMain | undefined;
  if (!message) return;

  switch (message.type) {
    case 'UI_READY':
      await sendInit();
      break;
    case 'RUN':
      await run(message.settings);
      break;
    case 'CANCEL':
      cancelled = true;
      break;
    case 'SAVE_SETTINGS':
      settings = message.settings;
      break;
    case 'INSERT_TO_CANVAS':
      insertFrame(message.summary as never);
      toUi({ type: 'INSERTED' });
      notify('Report frame inserted.');
      break;
    case 'NOTIFY':
      notify(message.message, message.error);
      break;
    case 'RESIZE':
      frame.style.width = `${message.width}px`;
      frame.style.height = `${message.height}px`;
      break;
    case 'CLOSE':
      notify('Plugin closed. Reload the page to run it again.');
      frame.style.display = 'none';
      break;
  }
});

// Surface the seeded structure so it is clear what the mock contains.
const summary = document.getElementById('mock-summary');
if (summary) {
  summary.textContent =
    `${variables.length} variables · ${collections.length} collections · ` +
    `${new Set(collections.flatMap((c) => c.modes.map((m) => m.name))).size} modes`;
}
