import TEMPLATE from '../template.html';
import { analyze } from '../analysis/analyzer.ts';
import { renderDashboard } from '../analysis/render.ts';
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

function showView(name: 'setup' | 'running' | 'report' | 'error'): void {
  for (const view of Array.from(document.querySelectorAll('.view'))) view.classList.remove('active');
  $(`view-${name}`).classList.add('active');
  // Never leave a pending confirmation visible across a view change.
  const confirmBar = document.getElementById('insert-confirm');
  if (confirmBar) confirmBar.hidden = true;
}

function readSettings(): Settings {
  const scope = (document.querySelector('input[name="scope"]:checked') as HTMLInputElement | null)?.value;
  return {
    scope: (scope as Settings['scope']) ?? DEFAULT_SETTINGS.scope,
    scoring: $<HTMLSelectElement>('scoring').value as Settings['scoring'],
    mergeSpacingRoles: $<HTMLInputElement>('merge-spacing').checked,
    excludeHidden: $<HTMLInputElement>('exclude-hidden').checked,
    maxNodes: Number($<HTMLInputElement>('max-nodes').value) || DEFAULT_SETTINGS.maxNodes,
    figmaFileUrl: $<HTMLInputElement>('file-url').value.trim(),
  };
}

function applySettings(next: Settings): void {
  settings = next;
  const radio = document.querySelector(`input[name="scope"][value="${next.scope}"]`) as HTMLInputElement | null;
  if (radio) radio.checked = true;
  $<HTMLSelectElement>('scoring').value = next.scoring;
  $<HTMLInputElement>('merge-spacing').checked = next.mergeSpacingRoles;
  $<HTMLInputElement>('exclude-hidden').checked = next.excludeHidden;
  $<HTMLInputElement>('max-nodes').value = String(next.maxNodes);
  $<HTMLInputElement>('file-url').value = next.figmaFileUrl;
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

function chip(text: string, status: string): string {
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<span class="chip ${status}">${safe}</span>`;
}

function renderReport(analysis: AnalysisResult): void {
  const m = analysis.metrics;

  $('score-value').textContent = `${analysis.score.score}%`;
  $('score-value').className = `score-value ${analysis.score.label}`;
  $('score-note').textContent = analysis.score.note;
  $('report-sub').textContent =
    `${m.totalTokens} tokens · ${m.totalCollections} collection${m.totalCollections === 1 ? '' : 's'}` +
    (m.modeNames.length ? ` · ${m.modeNames.join(' / ')}` : '');

  const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(0)}%`);
  $('report-chips').innerHTML = [
    chip(`Alias ${pct(m.aliasLayerCoverage)}`, statusOf(m.aliasLayerCoverage, 90, 60)),
    chip(`Naming ${pct(m.namingCompliance)}`, statusOf(m.namingCompliance, 100, 90)),
    chip(`Modes ${pct(m.modeCoverage)}`, statusOf(m.modeCoverage, 100, 75)),
    chip(`${m.duplicateBreakdown.high} high duplicates`, m.duplicateBreakdown.high === 0 ? 'ok' : 'fail'),
    chip(`${m.typos.length} typos`, m.typos.length === 0 ? 'ok' : 'warn'),
    chip(`${m.directOverrideCount} overrides`, m.directOverrideCount === 0 ? 'ok' : 'warn'),
  ].join('');

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

  const findings: string[] = [];
  for (const typo of m.typos.slice(0, 2)) findings.push(`Possible typo: "${typo.token.name}" vs "${typo.nearest.name}"`);
  for (const dup of m.duplicates.filter((d) => d.severity === 'high').slice(0, 2)) {
    findings.push(`Duplicate: ${dup.a.name} and ${dup.b.name}`);
  }
  if (m.namingFailures.length > 0) {
    findings.push(`${m.namingFailures.length} tokens fail the naming convention (${m.namingFailures[0].reason})`);
  }
  for (const parallel of m.parallelScales.slice(0, 1)) {
    findings.push(`${parallel.groupA} and ${parallel.groupB} are parallel scales sharing ${parallel.sharedSteps} values`);
  }
  if (m.directOverrideCount > 0) findings.push(`${m.directOverrideCount} hardcoded color literals found`);

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
      if (message.figmaFileUrl && !message.settings.figmaFileUrl) {
        $<HTMLInputElement>('file-url').value = message.figmaFileUrl;
      }

      const totalVariables = message.collections.reduce((sum, c) => sum + c.variableCount, 0);
      const totalModes = new Set(message.collections.flatMap((c) => c.modes)).size;
      $('file-summary').textContent =
        `${message.collections.length} collection${message.collections.length === 1 ? '' : 's'} · ` +
        `${totalModes} mode${totalModes === 1 ? '' : 's'} · ${totalVariables} variables`;

      $('collections').innerHTML = message.collections
        .map(
          (c) =>
            `<div class="collection-row"><span>${c.name.replace(/</g, '&lt;')}</span>` +
            `<span class="collection-modes">${c.variableCount} vars · ${c.modes.join(' / ')}</span></div>`,
        )
        .join('');

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

$('download-json').addEventListener('click', () => {
  if (!input) return;
  const date = input.meta.generatedAt ?? new Date().toISOString().slice(0, 10);
  download(`${slug(input.meta.projectName)}-token-health-${date}.json`, 'application/json', JSON.stringify(input, null, 2));
  send({ type: 'NOTIFY', message: 'Normalized JSON downloaded.' });
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
