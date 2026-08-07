import type { AnalysisResult, DirectOverride, Metrics, Severity } from './types.ts';
import { deriveKeyFindings } from './findings.ts';

export interface RenderOptions {
  /**
   * Strip the Google Fonts <link> tags.
   *
   * The plugin manifest declares networkAccess "none", which blocks those
   * requests inside the plugin iframe. Set this for the in-plugin preview only;
   * the downloaded file keeps the links so fonts load in a normal browser.
   */
  inlineFontsOnly?: boolean;
  generatedAt?: string;
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pct(value: number | null, digits = 0): string {
  if (value === null) return 'N/A';
  return `${value.toFixed(digits)}%`;
}

function statusOf(value: number | null, okAt: number, warnAt: number): 'ok' | 'warn' | 'fail' | 'muted' {
  if (value === null) return 'muted';
  if (value >= okAt) return 'ok';
  if (value >= warnAt) return 'warn';
  return 'fail';
}

function inverseStatus(count: number, warnAt = 1, failAt = 5): 'ok' | 'warn' | 'fail' {
  if (count >= failAt) return 'fail';
  if (count >= warnAt) return 'warn';
  return 'ok';
}

const ICONS = {
  ok: `<svg viewBox="0 0 20 20" fill="none" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#F1F8EA"/><path d="M6 10.5L8.5 13L14 7" stroke="#016E1C" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  warn: `<svg viewBox="0 0 20 20" fill="none" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#FEF6E6"/><path d="M10 6v5M10 13.5v.5" stroke="#F57504" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  fail: `<svg viewBox="0 0 20 20" fill="none" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#FFEFF1"/><path d="M7 7l6 6M13 7l-6 6" stroke="#E0031F" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  muted: `<svg viewBox="0 0 20 20" fill="none" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#F0F2F4"/><path d="M6.5 10h7" stroke="#797D89" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

/* ------------------------------------------------------------------ */
/* Section builders — one per placeholder                              */
/* ------------------------------------------------------------------ */

function buildHeaderBadges(result: AnalysisResult): string {
  const { input, metrics } = result;
  const badges: string[] = [];

  // The fidelity badge is the guard against misreading an export artifact as an
  // architecture problem.
  const fidelity = input.meta.sourceFidelity ?? 'unknown';
  const fidelityText =
    fidelity === 'figma-plugin'
      ? `Figma Plugin API · ${metrics.modeNames.length} mode${metrics.modeNames.length === 1 ? '' : 's'} · aliases resolved`
      : fidelity === 'dtcg-export'
        ? 'DTCG export · aliases flattened by exporter'
        : fidelity === 'text'
          ? 'Text source · structural data limited'
          : 'Source fidelity unknown';
  badges.push(`<span class="badge badge-glass">${escapeHtml(fidelityText)}</span>`);

  badges.push(
    `<span class="badge badge-glass">${metrics.totalCollections} collection${metrics.totalCollections === 1 ? '' : 's'}</span>`,
  );
  badges.push(`<span class="badge badge-glass">${metrics.totalTokens} tokens</span>`);
  if (metrics.modeNames.length > 0) {
    badges.push(`<span class="badge badge-glass">${escapeHtml(metrics.modeNames.join(' / '))}</span>`);
  }
  badges.push(
    `<span class="badge badge-glass">${result.options.scoring === 'adaptive' ? 'Adaptive' : 'Strict'} scoring</span>`,
  );
  if (input.meta.scanScope) {
    badges.push(`<span class="badge badge-glass">Scan: ${escapeHtml(input.meta.scanScope)}</span>`);
  }
  if (input.meta.scanTruncated) {
    badges.push(`<span class="badge badge-glass">⚠ Scan truncated</span>`);
  }
  return badges.join('\n            ');
}

function ringStat(dot: string, label: string, value: string): string {
  return `<div class="ring-stat">
              <span class="ring-stat-dot ${dot}"></span>
              <span class="ring-stat-label">${escapeHtml(label)}</span>
              <span class="ring-stat-value">${escapeHtml(value)}</span>
            </div>`;
}

function buildRingStats(m: Metrics): string {
  const rows: string[] = [];
  rows.push(ringStat(statusOf(m.aliasLayerCoverage, 90, 60), 'Alias layer coverage', pct(m.aliasLayerCoverage, 1)));
  rows.push(ringStat(statusOf(m.namingCompliance, 100, 90), 'Naming pattern compliance', pct(m.namingCompliance, 1)));
  rows.push(ringStat(statusOf(m.modeCoverage, 100, 75), 'Mode coverage', pct(m.modeCoverage, 0)));
  rows.push(
    ringStat(
      inverseStatus(m.duplicateBreakdown.high, 1, 3),
      'Semantic duplicates (weighted)',
      `${m.weightedDuplicates} of ${m.duplicates.length}`,
    ),
  );
  rows.push(
    ringStat(inverseStatus(m.directOverrideCount, 1, 10), 'Direct color overrides', String(m.directOverrideCount)),
  );
  return rows.join('\n            ');
}

function metricCard(status: string, label: string, value: string, pillClass: string, pill: string): string {
  return `<article class="metric-card status-${status}">
          <p class="metric-label">${escapeHtml(label)}</p>
          <p class="metric-value ${pillClass}">${escapeHtml(value)}</p>
          <span class="metric-pill ${pillClass}">${escapeHtml(pill)}</span>
        </article>`;
}

function buildMetricCards(m: Metrics): string {
  const cards: string[] = [];

  cards.push(
    metricCard(
      'brand',
      'Total tokens',
      String(m.totalTokens),
      'brand',
      `${m.totalCollections} collection${m.totalCollections === 1 ? '' : 's'} · ${m.totalGroups} groups`,
    ),
  );

  const aliasStatus = statusOf(m.aliasLayerCoverage, 90, 60);
  cards.push(
    metricCard(
      aliasStatus,
      'Alias layer coverage',
      pct(m.aliasLayerCoverage, 1),
      aliasStatus,
      m.aliasLayerCoverage === null ? 'Not measurable from this source' : 'Target: ≥ 90%',
    ),
  );

  cards.push(
    metricCard(
      inverseStatus(m.orphanedAliases),
      'Orphaned aliases',
      String(m.orphanedAliases),
      inverseStatus(m.orphanedAliases),
      'Target: 0',
    ),
  );

  cards.push(
    metricCard(
      m.avgChainDepth === null ? 'info' : m.avgChainDepth <= 2 ? 'ok' : 'warn',
      'Avg alias chain depth',
      m.avgChainDepth === null ? 'N/A' : m.avgChainDepth.toFixed(2),
      m.avgChainDepth === null ? 'muted' : m.avgChainDepth <= 2 ? 'ok' : 'warn',
      m.avgChainDepth === null ? 'No aliases present' : 'Target: ≤ 2',
    ),
  );

  const namingStatus = statusOf(m.namingCompliance, 100, 90);
  cards.push(
    metricCard(
      namingStatus,
      'Naming compliance',
      pct(m.namingCompliance, 1),
      namingStatus,
      m.namingFailures.length > 0 ? `${m.namingFailures.length} failing` : 'Target: 100%',
    ),
  );

  cards.push(
    metricCard(
      inverseStatus(m.duplicateBreakdown.high, 1, 3),
      'Semantic duplicates',
      String(m.weightedDuplicates),
      inverseStatus(m.duplicateBreakdown.high, 1, 3),
      `${m.duplicateBreakdown.high} high · ${m.duplicateBreakdown.warn} warn · ${m.duplicateBreakdown.info} info`,
    ),
  );

  cards.push(
    metricCard(
      inverseStatus(m.directOverrideCount, 1, 10),
      'Direct color overrides',
      String(m.directOverrideCount),
      inverseStatus(m.directOverrideCount, 1, 10),
      'Target: 0',
    ),
  );

  const modeStatus = statusOf(m.modeCoverage, 100, 75);
  cards.push(
    metricCard(
      modeStatus,
      'Mode coverage',
      pct(m.modeCoverage, 0),
      modeStatus,
      m.modeCoverage === null ? 'No theme axis in scope' : 'Target: 100%',
    ),
  );

  cards.push(
    metricCard(
      inverseStatus(m.globalTokenViolations),
      'Global layer violations',
      String(m.globalTokenViolations),
      inverseStatus(m.globalTokenViolations),
      'Target: 0',
    ),
  );

  return cards.join('\n\n        ');
}

function checkRow(status: 'ok' | 'warn' | 'fail' | 'muted', label: string, target: string, chip: string): string {
  const chipClass = status === 'muted' ? 'muted' : status;
  return `<div class="check-row ${status === 'muted' ? '' : status}">
          <div class="check-icon">${ICONS[status]}</div>
          <span class="check-label">${escapeHtml(label)}</span>
          <span class="check-target">${escapeHtml(target)}</span>
          <span class="status-chip ${chipClass}">${escapeHtml(chip)}</span>
        </div>`;
}

function buildConsistencyChecks(result: AnalysisResult): string {
  const m = result.metrics;
  const rows: string[] = [];

  // Per-group naming compliance — says which part of the system is failing.
  const groupStats = new Map<string, { total: number; failed: number; reasons: Set<string> }>();
  for (const collection of result.input.collections) {
    for (const group of collection.groups) {
      const key = `${collection.name} / ${group.name}`;
      groupStats.set(key, { total: group.tokens.length, failed: 0, reasons: new Set() });
    }
  }
  for (const failure of m.namingFailures) {
    const key = `${failure.token.collection} / ${failure.token.group}`;
    const stat = groupStats.get(key);
    if (stat) {
      stat.failed++;
      stat.reasons.add(failure.reason);
    }
  }

  for (const [key, stat] of groupStats) {
    if (stat.total === 0) continue;
    const passed = stat.total - stat.failed;
    const percent = (passed / stat.total) * 100;
    const status = percent === 100 ? 'ok' : percent >= 50 ? 'warn' : 'fail';
    const reason = stat.reasons.size > 0 ? ` — ${[...stat.reasons][0]}` : '';
    rows.push(
      checkRow(status, `${key} naming (${passed}/${stat.total})${reason}`, 'target 100%', `${percent.toFixed(0)}%`),
    );
  }

  for (const typo of m.typos) {
    rows.push(
      checkRow(
        'warn',
        `Possible typo: "${typo.token.name}" vs "${typo.nearest.name}"`,
        `distance ${typo.distance}`,
        'Typo',
      ),
    );
  }

  rows.push(
    m.aliasLayerCoverage === null
      ? checkRow('muted', 'Semantic alias layer', 'not measurable here', 'N/A')
      : checkRow(
          m.aliasLayerCoverage > 0 ? 'ok' : 'fail',
          m.aliasLayerCoverage > 0 ? `Semantic alias layer present (${m.aliasTokens} aliased)` : 'No semantic alias layer present',
          'target: aliases exist',
          m.aliasLayerCoverage > 0 ? pct(m.aliasLayerCoverage, 0) : 'Missing',
        ),
  );

  if (m.cyclicAliases > 0) {
    rows.push(checkRow('fail', 'Alias chains free of cycles', 'target 0', `${m.cyclicAliases} cyclic`));
  }
  if (m.orphanedAliases > 0) {
    rows.push(checkRow('fail', 'Alias targets all resolve', 'target 0', `${m.orphanedAliases} broken`));
  }

  for (const parallel of m.parallelScales) {
    rows.push(
      checkRow(
        'muted',
        `Parallel scales: ${parallel.groupA} and ${parallel.groupB} share ${parallel.sharedSteps} values`,
        'review intent',
        'Info',
      ),
    );
  }

  for (const dup of m.duplicates.filter((d) => d.severity === 'high').slice(0, 4)) {
    rows.push(checkRow('fail', `Duplicate: ${dup.a.name} vs ${dup.b.name}`, dup.heuristic, 'High'));
  }

  if (rows.length === 0) rows.push(checkRow('ok', 'No consistency issues detected', 'target 0', 'Clean'));
  return rows.join('\n\n          ');
}

function buildReuseBars(m: Metrics): { rows: string; note: string } {
  if (!m.hasUsageData || m.reuse.length === 0) {
    return {
      rows: `<div class="bar-row"><span class="bar-label" style="min-width:auto;color:var(--c-gray-30);font-style:italic;">No usage data — run a document scan to populate reuse counts.</span></div>`,
      note: 'Reuse measurement requires a document scan. Re-run the plugin with a scan scope of Current page or Whole document to see which tokens actually carry the system.',
    };
  }

  const max = Math.max(...m.reuse.map((r) => r.count));
  const rows = m.reuse
    .map((r) => {
      const width = Math.max(2, Math.round((r.count / max) * 100));
      return `<div class="bar-row">
              <span class="bar-label">${escapeHtml(r.token)}</span>
              <div class="bar-track"><div class="bar-fill brand" style="width:${width}%"></div></div>
              <span class="bar-count">${r.count}×</span>
            </div>`;
    })
    .join('\n\n            ');

  const top = m.reuse[0];
  return {
    rows,
    note: `Top ${m.reuse.length} tokens by measured usage. <strong>${escapeHtml(top.token)}</strong> leads with ${top.count} bindings. Tokens with a single usage are candidates for removal or consolidation.`,
  };
}

function buildModeCoverage(m: Metrics): { rows: string; note: string } {
  if (m.modeCoverageRows.length === 0) {
    const reason =
      m.modeNames.length > 0 && m.themeModes.length === 0
        ? `The modes in this file (${m.modeNames.join(', ')}) form a size or platform axis, not a light/dark theme axis — there is no theme parity to measure, so this metric is excluded from the score rather than counted as a failure.`
        : 'No per-component mode data. Run a document scan to measure which components are theme-complete.';
    return {
      rows: `<div class="coverage-row"><span class="coverage-name" style="min-width:auto;color:var(--c-gray-30);font-style:italic;">Not applicable</span></div>`,
      note: reason,
    };
  }

  const rows = m.modeCoverageRows
    .map((row) => {
      const keys = Object.keys(row.modes);
      const width = keys.length > 0 ? 100 / keys.length : 100;
      const segments = keys
        .map((key, index) => {
          const cls = row.modes[key] ? (index === 0 ? 'seg-light' : 'seg-dark') : 'seg-miss';
          return `<div class="coverage-seg ${cls}" style="width:${width.toFixed(1)}%"></div>`;
        })
        .join('\n                ');
      const ratio = row.total > 0 ? row.covered / row.total : 0;
      const scoreClass = ratio === 1 ? 'full' : ratio >= 0.5 ? 'partial' : 'low';
      return `<div class="coverage-row">
            <span class="coverage-name">${escapeHtml(row.component)}</span>
            <div class="coverage-track">
                ${segments}
            </div>
            <span class="coverage-score ${scoreClass}">${row.covered}/${row.total}</span>
          </div>`;
    })
    .join('\n\n          ');

  const incomplete = m.modeCoverageRows.filter((r) => r.covered < r.total);
  const note =
    incomplete.length === 0
      ? `All ${m.modeCoverageRows.length} components are complete across ${m.themeModes.join(' / ') || 'all modes'}.`
      : `${incomplete.length} of ${m.modeCoverageRows.length} components are incomplete. Most common cause: a hardcoded color literal, which cannot respond to a theme change. ${incomplete[0].reason ? escapeHtml(incomplete[0].reason) : ''}`;

  return { rows, note };
}

const SEVERITY_LABEL: Record<Severity, string> = { high: 'High', warn: 'Warning', info: 'Informational' };

function buildDuplicateRows(m: Metrics): string {
  if (m.duplicates.length === 0 && m.parallelScales.length === 0) {
    return `<tr><td colspan="3" style="text-align:center;color:var(--c-gray-30);font-style:italic;padding:24px 16px;">No semantic duplicates detected.</td></tr>`;
  }

  const rows = m.duplicates.map((dup) => {
    return `<tr>
                <td>
                  <div class="dup-card">
                    <div class="dup-row a">
                      <span class="dup-label">Token A</span>
                      <span class="dup-token">${escapeHtml(dup.a.name)}</span>
                    </div>
                    <div class="dup-divider">${dup.heuristic === 'H2' ? 'inverted' : 'same as'}</div>
                    <div class="dup-row b">
                      <span class="dup-label">Token B</span>
                      <span class="dup-token">${escapeHtml(dup.b.name)}</span>
                    </div>
                  </div>
                </td>
                <td><span class="status-chip ${dup.severity === 'high' ? 'fail' : dup.severity === 'warn' ? 'warn' : 'muted'}">${SEVERITY_LABEL[dup.severity]}</span> <strong>${dup.heuristic}</strong> — ${dup.evidence}</td>
                <td class="col-token-name">${escapeHtml(dup.normalizationTarget)}</td>
              </tr>`;
  });

  // Parallel scales are reported here as informational context, because their
  // absence from the duplicates table is itself a finding worth explaining.
  for (const parallel of m.parallelScales) {
    rows.push(`<tr>
                <td>
                  <div class="dup-card">
                    <div class="dup-row a">
                      <span class="dup-label">Group A</span>
                      <span class="dup-token">${escapeHtml(parallel.groupA)}</span>
                    </div>
                    <div class="dup-divider" style="color:var(--c-gray-40);">parallel to</div>
                    <div class="dup-row b">
                      <span class="dup-label">Group B</span>
                      <span class="dup-token">${escapeHtml(parallel.groupB)}</span>
                    </div>
                  </div>
                </td>
                <td><span class="status-chip muted">Informational</span> <strong>Parallel scale</strong> — ${parallel.evidence} Not counted as a duplicate: the two groups carry different layout roles.</td>
                <td class="col-token-name">—</td>
              </tr>`);
  }

  return rows.join('\n\n              ');
}

function buildOverrideRows(overrides: DirectOverride[]): string {
  if (overrides.length === 0) {
    return `<tr><td colspan="4" style="text-align:center;color:var(--c-gray-30);font-style:italic;padding:24px 16px;">No direct color overrides detected in this scope.</td></tr>`;
  }
  return overrides
    .map(
      (o) => `<tr>
                <td>${escapeHtml(o.area)}</td>
                <td class="col-literal">${escapeHtml(o.literal)}</td>
                <td class="col-replacement">${escapeHtml(o.replacement)}</td>
                <td>${escapeHtml(o.details ?? '')}${o.severity === 'info' ? ' <span class="status-chip muted">Informational</span>' : ''}</td>
              </tr>`,
    )
    .join('\n\n              ');
}

function buildInventoryRows(result: AnalysisResult): string {
  const rows: string[] = [];
  for (const collection of result.input.collections) {
    const groups = collection.groups;
    if (groups.length === 0) continue;
    const collectionModes = collection.modes ?? [];

    groups.forEach((group, index) => {
      const modeTags =
        collectionModes.length > 0
          ? collectionModes
              .map((mode) => {
                const present = group.tokens.some((t) => !t.modes || t.modes.includes(mode));
                return `<span class="mode-tag ${present ? 'active' : 'missing'}">${escapeHtml(mode)}</span>`;
              })
              .join('\n                    ')
          : `<span class="mode-tag missing">—</span>`;

      const collectionCell =
        index === 0
          ? `<td class="col-collection" rowspan="${groups.length}">${escapeHtml(collection.name)}</td>\n                  `
          : '';

      rows.push(`<tr>
                  ${collectionCell}<td class="col-token-name">${escapeHtml(group.name)}</td>
                  <td>${escapeHtml(group.type)}${group.mixedTypes ? ' <span class="status-chip warn">mixed</span>' : ''}</td>
                  <td><span class="count-pill">${group.tokens.length}</span></td>
                  <td>
                    ${modeTags}
                  </td>
                </tr>`);
    });
  }

  if (rows.length === 0) {
    return `<tr><td colspan="5" style="text-align:center;color:var(--c-gray-30);font-style:italic;padding:24px 16px;">No token collections found.</td></tr>`;
  }
  return rows.join('\n\n              ');
}

/* ------------------------------------------------------------------ */
/* Key findings — appended below the templated sections                */
/* ------------------------------------------------------------------ */

/**
 * The same headline list the inserted canvas frame shows, rendered as a final
 * dashboard section.
 *
 * This is built here rather than added to `template.html` on purpose: the
 * template is a verbatim copy of the CLI skill's, and a test asserts it has not
 * drifted. Adding a plugin-only section by injection keeps that guarantee
 * intact — the skill's own output is unaffected.
 */
function buildKeyFindingsSection(result: AnalysisResult): string {
  const findings = deriveKeyFindings(result);

  const body = findings.length
    ? `<ul style="margin:0;padding-left:var(--sp-20);display:flex;flex-direction:column;gap:var(--sp-8);">\n` +
      findings
        .map(
          (finding) =>
            `            <li style="font-size:13px;line-height:20px;color:var(--c-gray-70);">${escapeHtml(finding)}</li>`,
        )
        .join('\n') +
      `\n          </ul>`
    : `<p style="font-size:13px;line-height:20px;color:var(--c-gray-50);">No blocking issues found in this scope.</p>`;

  return `    <!-- ━━━ KEY FINDINGS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -->
    <section class="section">
      <h2 class="section-title">Key Findings</h2>
      <div class="panel">
          ${body}
      </div>
    </section>

`;
}

/**
 * Place the section immediately before the attribution footer — i.e. after all
 * existing dashboard content. If the template ever loses that anchor the
 * section is skipped rather than spliced somewhere wrong.
 */
const FOOTER_ANCHOR = /(?:[ \t]*<!--[^\n]*FOOTER[^\n]*-->\r?\n)?[ \t]*<footer class="dashboard-footer"/;

function injectKeyFindings(html: string, section: string): string {
  const at = html.search(FOOTER_ANCHOR);
  if (at === -1) return html;
  return html.slice(0, at) + section + html.slice(at);
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

/**
 * Remove the template's authoring documentation before substitution.
 *
 * Two reasons this is not optional:
 *
 * 1. The doc block contains `{{placeholder}}` tokens. Substituting into them
 *    pastes a second copy of every section into the output.
 *
 * 2. The block contains a nested `<!-- SVG -->` example, and HTML comments do
 *    not nest — so the outer comment terminates at that inner `-->` and the
 *    remaining ~50 lines are parsed as *visible page content*. A naive
 *    comment regex inherits the same early-termination bug, so the leading
 *    block is cut by position (first `<!--` to the last `-->` before `<html`)
 *    rather than by matching comment syntax.
 *
 * Section-divider comments carry no braces or tags and are kept for readability.
 */
export function stripAuthoringComments(template: string): string {
  let out = template;

  const htmlTag = out.search(/<html[\s>]/i);
  if (htmlTag > 0) {
    const head = out.slice(0, htmlTag);
    const start = head.indexOf('<!--');
    const end = head.lastIndexOf('-->');
    if (start !== -1 && end > start) {
      out = head.slice(0, start) + head.slice(end + 3) + out.slice(htmlTag);
    }
  }

  // Inline example comments elsewhere in the body.
  return out.replace(/<!--([\s\S]*?)-->/g, (match, body: string) =>
    body.includes('{{') || /<\w+[\s>]/.test(body) ? '' : match,
  );
}

export function renderDashboard(result: AnalysisResult, template: string, options: RenderOptions = {}): string {
  const { metrics: m, input, score } = result;

  const generatedAt = options.generatedAt ?? input.meta.generatedAt ?? new Date().toISOString().slice(0, 10);
  const reuse = buildReuseBars(m);
  const modeCoverage = buildModeCoverage(m);

  const subtitle =
    input.meta.sourceLabel ??
    `${m.totalTokens} tokens across ${m.totalCollections} collection${m.totalCollections === 1 ? '' : 's'}` +
      (m.modeNames.length > 0 ? ` and ${m.modeNames.length} mode${m.modeNames.length === 1 ? '' : 's'}` : '');

  const footerParts = [
    'Generated by Token Health Analysis (Figma plugin)',
    escapeHtml(input.meta.projectName),
    generatedAt,
    escapeHtml(score.note),
  ];

  const replacements: Record<string, string> = {
    reportTitle: escapeHtml(`Token Health Analysis — ${input.meta.projectName}`),
    reportSubtitle: escapeHtml(subtitle),
    sourceLabel: escapeHtml(input.meta.figmaFileUrl ?? input.meta.sourceLabel ?? input.meta.projectName),
    generatedDate: escapeHtml(generatedAt),
    headerBadges: buildHeaderBadges(result),

    healthScorePercent: String(score.score),
    healthScoreLabel: `${score.score}%`,
    healthScoreColor: score.color,
    healthRingStats: buildRingStats(m),

    metricCards: buildMetricCards(m),
    consistencyChecks: buildConsistencyChecks(result),

    reuseBarRows: reuse.rows,
    reuseNote: reuse.note,
    modeCoverageRows: modeCoverage.rows,
    modeCoverageNote: modeCoverage.note,

    semanticDuplicateRows: buildDuplicateRows(m),
    semanticDuplicatesCount: String(m.duplicates.length + m.parallelScales.length),

    directOverrideRows: buildOverrideRows(m.directOverrides),
    directOverridesCount: String(m.directOverrideCount),

    inventoryRows: buildInventoryRows(result),
    footerText: footerParts.join(' &middot; ') + (result.notes.length > 0 ? `<br><br>${result.notes.map(escapeHtml).join(' ')}` : ''),
  };

  // The template documents its own placeholders inside HTML comments. Those must
  // be removed BEFORE substitution, or every generated report carries a second
  // copy of the content pasted into a comment — and any injected markup
  // containing "-->" would escape the comment into the visible page.
  let html = stripAuthoringComments(template);

  for (const [key, value] of Object.entries(replacements)) {
    html = html.split(`{{${key}}}`).join(value);
  }

  // After substitution, so a finding whose text contains {{…}} is never treated
  // as a placeholder.
  html = injectKeyFindings(html, buildKeyFindingsSection(result));

  if (options.inlineFontsOnly) {
    html = html
      .replace(/<link rel="preconnect"[^>]*>\s*/g, '')
      .replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>\s*/g, '');
  }

  return html;
}

/** Placeholder names the renderer fills. Used by tests to assert completeness. */
export const PLACEHOLDERS = [
  'reportTitle',
  'reportSubtitle',
  'sourceLabel',
  'generatedDate',
  'headerBadges',
  'healthScorePercent',
  'healthScoreLabel',
  'healthScoreColor',
  'healthRingStats',
  'metricCards',
  'consistencyChecks',
  'reuseBarRows',
  'reuseNote',
  'modeCoverageRows',
  'modeCoverageNote',
  'semanticDuplicateRows',
  'semanticDuplicatesCount',
  'directOverrideRows',
  'directOverridesCount',
  'inventoryRows',
  'footerText',
] as const;
