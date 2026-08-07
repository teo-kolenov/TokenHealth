import TEMPLATE from '../template.html';
import { analyze } from '../analysis/analyzer.ts';
import { renderDashboard } from '../analysis/render.ts';
import { deriveKeyFindings } from '../analysis/findings.ts';
import { DEFAULT_SETTINGS, type CanvasSummary, type MainToUi, type Settings, type UiToMain } from '../shared/messages.ts';
import type { AnalysisResult, NormalizedInput } from '../analysis/types.ts';

/**
 * The UI thread owns analysis and rendering.
 *
 * The main thread has scene access but no DOM — no Blob, no download anchor.
 * This side has the DOM but cannot see a single node. Running analyze/render
 * here also keeps the heavy string work off the thread that drives the canvas.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function send(message: UiToMain): void {
  parent.postMessage({ pluginMessage: message }, '*');
}

let settings: Settings = { ...DEFAULT_SETTINGS };
let result: AnalysisResult | null = null;
let input: NormalizedInput | null = null;
let downloadHtml = '';
let chunks: string[] = [];
/** Auto-detected from figma.fileKey when available; not user-configurable. */
let detectedFigmaFileUrl = '';

function showView(name: 'setup' | 'running' | 'report' | 'error'): void {
  for (const view of Array.from(document.querySelectorAll('.view'))) view.classList.remove('active');
  $(`view-${name}`).classList.add('active');
  // Never leave a pending confirmation visible across a view change.
  const confirmBar = document.getElementById('insert-confirm');
  if (confirmBar) confirmBar.hidden = true;
}

/**
 * Scoring mode, max node budget, and the source file URL are no longer
 * user-configurable — they always run at their defaults. The file URL is the
 * one exception with a live value: it's auto-detected from figma.fileKey when
 * Figma provides one, so it still ends up in the report header without a field.
 */
function readSettings(): Settings {
  const scope = (document.querySelector('input[name="scope"]:checked') as HTMLInputElement | null)?.value;
  return {
    scope: (scope as Settings['scope']) ?? DEFAULT_SETTINGS.scope,
    scoring: DEFAULT_SETTINGS.scoring,
    mergeSpacingRoles: $<HTMLInputElement>('merge-spacing').checked,
    excludeHidden: $<HTMLInputElement>('exclude-hidden').checked,
    maxNodes: DEFAULT_SETTINGS.maxNodes,
    figmaFileUrl: detectedFigmaFileUrl,
  };
}

function applySettings(next: Settings): void {
  settings = next;
  const radio = document.querySelector(`input[name="scope"][value="${next.scope}"]`) as HTMLInputElement | null;
  if (radio) radio.checked = true;
  $<HTMLInputElement>('merge-spacing').checked = next.mergeSpacingRoles;
  $<HTMLInputElement>('exclude-hidden').checked = next.excludeHidden;
}

/** Downloads must happen inside the click handler to satisfy the gesture rule. */
function download(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'token-health';
}

function statusOf(value: number | null, okAt: number, warnAt: number): 'ok' | 'warn' | 'fail' | 'muted' {
  if (value === null) return 'muted';
  if (value >= okAt) return 'ok';
  if (value >= warnAt) return 'warn';
  return 'fail';
}

/** Ring fill color by health-score status: red = negative, orange = average, green = positive. */
const SCORE_RING_COLOR: Record<'ok' | 'warn' | 'fail', string> = {
  ok: 'var(--color-green-60)',
  warn: 'var(--color-yellow-40)',
  fail: 'var(--color-red-50)',
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function chip(value: string, label: string, status: string): string {
  return (
    `<div class="chip ${status}">` +
    `<div class="chip-value">${escapeHtml(value)}</div>` +
    `<div class="chip-label">${escapeHtml(label)}</div>` +
    `</div>`
  );
}

function renderReport(analysis: AnalysisResult): void {
  const m = analysis.metrics;

  $('score-value').textContent = `${analysis.score.score}%`;
  const ring = $('score-ring');
  ring.style.setProperty('--score', String(analysis.score.score));
  ring.style.setProperty('--ring-color', SCORE_RING_COLOR[analysis.score.label]);
  $('score-note').textContent = analysis.score.note;
  $('report-sub').textContent =
    `${m.totalTokens} tokens · ${m.totalCollections} collection${m.totalCollections === 1 ? '' : 's'}` +
    (m.modeNames.length ? ` · ${m.modeNames.length} mode${m.modeNames.length === 1 ? '' : 's'}` : '');

  const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(0)}%`);
  $('report-chips').innerHTML = [
    chip(pct(m.aliasLayerCoverage), 'Alias', statusOf(m.aliasLayerCoverage, 90, 60)),
    chip(pct(m.namingCompliance), 'Naming', statusOf(m.namingCompliance, 100, 90)),
    chip(pct(m.modeCoverage), 'Modes', statusOf(m.modeCoverage, 100, 75)),
    chip(String(m.duplicateBreakdown.high), 'High duplicates', m.duplicateBreakdown.high === 0 ? 'ok' : 'fail'),
    chip(String(m.orphanedAliases), 'Orphans', m.orphanedAliases === 0 ? 'ok' : 'fail'),
    chip(String(m.directOverrideCount), 'Overrides', m.directOverrideCount === 0 ? 'ok' : 'warn'),
  ].join('');

  // Same source as the inserted canvas frame and the downloaded dashboard, so
  // all three name the same problems.
  const findings = deriveKeyFindings(analysis);
  $('report-findings').innerHTML = findings.length
    ? `<ul class="findings-list">${findings.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`
    : `<p class="findings-empty">No blocking issues found in this scope.</p>`;

  const banner = $('report-banner');
  if (analysis.input.meta.scanTruncated) {
    banner.innerHTML = `<div class="banner warn">The scan hit the node limit, so reuse and override data are partial. Raise the limit in Advanced for a complete pass.</div>`;
  } else {
    banner.innerHTML = '';
  }

  // The downloaded/copied file keeps the Google Fonts links; there is no
  // in-plugin preview to strip them for.
  downloadHtml = renderDashboard(analysis, TEMPLATE, {});
}

function canvasSummary(analysis: AnalysisResult): CanvasSummary {
  const m = analysis.metrics;
  const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(0)}%`);

  // Shared with the dashboard's "Key findings" section so the inserted frame
  // and the downloaded report always name the same problems.
  const findings = deriveKeyFindings(analysis);

  const color: [number, number, number] =
    analysis.score.label === 'ok' ? [0.0039, 0.4314, 0.1098]
      : analysis.score.label === 'warn' ? [0.4863, 0.1804, 0.0039]
        : [0.8784, 0.0118, 0.1216];

  return {
    projectName: analysis.input.meta.projectName,
    score: analysis.score.score,
    scoreLabel: analysis.score.note,
    scoreColor: color,
    generatedAt: analysis.input.meta.generatedAt ?? new Date().toISOString().slice(0, 10),
    stats: [
      { label: 'Total tokens', value: String(m.totalTokens), status: 'muted' },
      { label: 'Alias layer coverage', value: pct(m.aliasLayerCoverage), status: statusOf(m.aliasLayerCoverage, 90, 60) },
      { label: 'Naming compliance', value: pct(m.namingCompliance), status: statusOf(m.namingCompliance, 100, 90) },
      { label: 'Mode coverage', value: pct(m.modeCoverage), status: statusOf(m.modeCoverage, 100, 75) },
      { label: 'Semantic duplicates (high)', value: String(m.duplicateBreakdown.high), status: m.duplicateBreakdown.high ? 'fail' : 'ok' },
      { label: 'Direct color overrides', value: String(m.directOverrideCount), status: m.directOverrideCount ? 'warn' : 'ok' },
    ],
    findings,
  };
}

/* ------------------------------------------------------------------ */
/* Message handling                                                    */
/* ------------------------------------------------------------------ */

window.onmessage = (event: MessageEvent) => {
  const message = event.data?.pluginMessage as MainToUi | undefined;
  if (!message) return;

  switch (message.type) {
    case 'INIT': {
      applySettings(message.settings);
      $('file-name').textContent = message.fileName;
      detectedFigmaFileUrl = message.figmaFileUrl || message.settings.figmaFileUrl || '';

      const totalVariables = message.collections.reduce((sum, c) => sum + c.variableCount, 0);
      const totalModes = new Set(message.collections.flatMap((c) => c.modes)).size;
      $('file-summary').textContent =
        `${message.collections.length} collection${message.collections.length === 1 ? '' : 's'} · ` +
        `${totalModes} mode${totalModes === 1 ? '' : 's'} · ${totalVariables} variables`;

      if (!message.hasVariables) {
        $('error-title').textContent = 'No local variables found';
        $('error-message').textContent = 'This file has no local variable collections to analyze.';
        $('error-help').innerHTML =
          'If the tokens live in a subscribed library, open that library file and run the plugin there. ' +
          'Alternatively, export the variables as JSON and run the CLI skill with ' +
          '<code>/token-health-analysis JSON &lt;file&gt;</code> — note that a JSON export flattens alias ' +
          'references and splits modes across files, so alias and mode coverage will read as N/A.';
        showView('error');
      }
      break;
    }

    case 'PROGRESS': {
      showView('running');
      const percent = message.total > 0 ? Math.min(100, (message.done / message.total) * 100) : 0;
      $('progress-fill').style.width = `${percent}%`;
      $('phase-label').textContent = message.phase;
      $('progress-detail').textContent =
        message.total > 1 ? `${message.label} — ${message.done} of ${message.total}` : message.label;
      break;
    }

    case 'RESULT_CHUNK': {
      chunks[message.index] = message.chunk;
      if (chunks.filter((c) => c !== undefined).length < message.count) return;

      try {
        input = JSON.parse(chunks.join('')) as NormalizedInput;
        chunks = [];
        result = analyze(input, { scoring: settings.scoring, mergeSpacingRoles: settings.mergeSpacingRoles });
        renderReport(result);
        showView('report');
      } catch (error) {
        $('error-title').textContent = 'Could not read the result';
        $('error-message').textContent = error instanceof Error ? error.message : String(error);
        $('error-help').textContent = '';
        showView('error');
      }
      break;
    }

    case 'CANCELLED':
      showView('setup');
      send({ type: 'NOTIFY', message: 'Analysis cancelled.' });
      break;

    case 'INSERTED':
      send({ type: 'NOTIFY', message: 'Report frame added to the current page.' });
      break;

    case 'ERROR':
      $('error-title').textContent = 'Analysis failed';
      $('error-message').textContent = message.message;
      $('error-help').textContent = message.stack ?? '';
      showView('error');
      break;
  }
};

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

$('run').addEventListener('click', () => {
  settings = readSettings();
  chunks = [];
  showView('running');
  send({ type: 'RUN', settings });
});

$('cancel').addEventListener('click', () => send({ type: 'CANCEL' }));
$('error-close').addEventListener('click', () => send({ type: 'CLOSE' }));
$('error-back').addEventListener('click', () => showView('setup'));
$('rerun').addEventListener('click', () => showView('setup'));

$('download-html').addEventListener('click', () => {
  if (!result) return;
  download(`${slug(result.input.meta.projectName)}-token-health.html`, 'text/html', downloadHtml);
  send({ type: 'NOTIFY', message: 'Dashboard downloaded.' });
});

/**
 * Confirmation for the one write this plugin performs.
 *
 * This is an inline bar rather than window.confirm(): a sandboxed plugin iframe
 * suppresses native modals silently — confirm() returns false without ever
 * showing a dialog — which would leave the button looking simply broken.
 */
const insertConfirm = $('insert-confirm');

function showInsertConfirm(show: boolean): void {
  insertConfirm.hidden = !show;
  if (show) $('insert-yes').focus();
}

$('insert-canvas').addEventListener('click', () => {
  if (!result) return;
  showInsertConfirm(true);
});

$('insert-no').addEventListener('click', () => {
  showInsertConfirm(false);
  $('insert-canvas').focus();
});

$('insert-yes').addEventListener('click', () => {
  if (!result) return;
  showInsertConfirm(false);
  send({ type: 'INSERT_TO_CANVAS', summary: canvasSummary(result) });
});

insertConfirm.addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Escape') {
    showInsertConfirm(false);
    $('insert-canvas').focus();
  }
});

send({ type: 'UI_READY' });
