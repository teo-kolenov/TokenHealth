# Token Health Analysis — Figma Plugin

Audits a design system's token architecture from the **live Figma file** and renders a self-contained HTML health dashboard.

## Why a plugin and not the JSON export

A run of the companion CLI skill against a Figma DTCG export (a sizing collection, 41 tokens) scored **39%**. Two of the four score inputs were artifacts of the export format rather than real defects:

| Metric | Export path | Why it was wrong | Plugin path |
|---|---|---|---|
| Alias coverage | `0%` | Figma's exporter **resolves aliases to literals** before writing the file, so no alias can ever be detected | Reads live `VARIABLE_ALIAS` references and walks the chain |
| Mode coverage | `50%` | Figma writes **one file per mode**, so only one mode is visible | `valuesByMode` exposes every mode at once |

The same file now scores **77%**, with the genuine findings intact:

- Naming compliance still **58.5%** (17 tokens fail — uppercase size suffixes)
- `global-raduis-S` is now **caught as a typo** — the old run missed it entirely
- `padding-16` vs `spacing-16` is no longer a false duplicate; it is reported as an informational *parallel scale*

## Install (development)

```bash
npm install && npm run build
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and choose `manifest.json`.

## Commands

```bash
npm run build      # bundle dist/code.js + dist/ui.html
npm run watch      # rebuild on change
npm test           # unit tests, no Figma required
npm run typecheck  # both tsconfigs
```

Render a report headlessly (no Figma):

```bash
npm run render -- test/fixtures/sample-token-input.json --out report.html
```

Reproduce the export-vs-plugin comparison:

```bash
npm run render -- test/fixtures/Mobile.tokens.json,test/fixtures/Desktop.tokens.json --dtcg --collection Sizes
```

## Architecture

```
src/
  analysis/   pure, Figma-free — runs in the UI iframe and in tests
    analyzer.ts   metrics
    duplicates.ts role-based duplicate detection (H1–H3 + parallel scales)
    naming.ts     compliance + Damerau-Levenshtein typo detection
    score.ts      strict and adaptive scoring
    render.ts     template -> HTML
    dtcg.ts       DTCG export importer (for the comparison above)
  main/       Figma-only — scene access, no DOM
    extract.ts       variables -> normalized input
    alias-resolve.ts chain walking, cycle guard, cross-collection mode mapping
    scan.ts          reuse counts, color literals, per-component theme coverage
    canvas.ts        the one write: an opt-in summary frame
  ui/         DOM-only — no scene access
```

The split is forced by the sandbox: the main thread has the `figma` global but no DOM (no `Blob`, no download anchor); the iframe has the DOM but cannot see a single node. A test mechanically enforces that `src/analysis` and `src/ui` never reference the `figma` global.

## Read-only by default

The plugin never modifies variables or nodes. The single exception is **Insert into file**, which draws a summary frame and is gated behind an explicit button and an inline confirmation step.

`manifest.json` declares `networkAccess: none` — analysis data cannot leave the file.

> The dashboard template loads Roboto from Google Fonts, which that policy would block if the report were ever rendered inside the plugin iframe. The plugin UI shows only a score summary and chips — the full dashboard is produced solely via **Download HTML**, so it always loads in a normal browser where those requests succeed. `renderDashboard`'s `inlineFontsOnly` option exists for any future in-iframe rendering path and is covered by its own test, but nothing in the current UI uses it.

## Scoring

```
score = aliasCoverage×0.35 + naming×0.25 + modeCoverage×0.20 + duplicateFactor×0.20
```

- **strict** — the formula verbatim; a missing input counts as 0.
- **adaptive** (default) — inapplicable inputs are dropped and the remaining weights renormalized.

Adaptive exists because two inputs can be legitimately inapplicable: a pure primitive collection has no semantic layer (alias coverage of 0% is arithmetically true but analytically meaningless), and a Mobile/Desktop collection has no light/dark axis to measure. Those render as `N/A` with a stated assumption rather than as zeros.

Thresholds: `≥80` green, `≥60` amber, `<60` red.

## Duplicate detection

Keyed on **role**, not raw value. Names are canonicalized (noise segments stripped, trailing scale separated, a conservative synonym table applied). `padding` / `spacing` / `gap` / `margin` are deliberately **not** synonyms — merging them is opt-in, because treating two intentional scales as duplicates is what made the original report untrustworthy.

| | Rule | Severity |
|---|---|---|
| H1 | Same value + same role, different name | high (info across layers) |
| H2 | Segment-order inversion (`color-primary-*` vs `primary-color-*`) | high |
| H3 | Same role, different values | high / warn |
| — | Parallel scales (value-aligned groups, different roles) | info, never scored |

Weighted `high=1, warn=0.5, info=0` feeds the score; the raw breakdown is shown alongside.

## Known upstream issue

The shared template (`src/template.html`, copied from the skill) embeds its authoring reference in an HTML comment that contains a nested `<!-- SVG -->`. HTML comments do not nest, so the block terminates early and **~680 characters of internal documentation render as visible text** at the top of the page. `stripAuthoringComments()` removes the block by position before substitution, which also cuts output size by ~40%.

The skill's own template still has this bug; fixing it there would fix it for the CLI path too.

## Status

- **M0/M1 complete** — variables, alias resolution, analysis, rendering, downloads, canvas insert.
- **M2** — document scan is implemented but not yet verified against a live file.
- **M3** — Community listing polish, screenshots, publishing.
