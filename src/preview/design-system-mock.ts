import type { VariableCollectionLike, VariableLike, VariablesApi } from '../main/figma-api.ts';
import { hexToRgba } from '../main/color.ts';

/**
 * A mock design system as the Figma Variables API would expose it.
 *
 * Values are the real ones from CLAUDE.md. The structure deliberately includes a
 * three-layer arrangement (primitives -> semantic aliases -> component tokens)
 * because that is what makes alias coverage meaningful — and it is precisely the
 * structure a DTCG export destroys.
 *
 * A handful of genuine defects are seeded so the report exercises every section:
 * an uppercase-suffixed radius family, a misspelled sibling, a segment-order
 * inversion, a dangling alias, and a component that hardcodes a color.
 */

const COLORS = 'col-colors';
const SEMANTIC = 'col-semantic';
const SIZES = 'col-sizes';

const LIGHT = 'mode-light';
const DARK = 'mode-dark';
const MOBILE = 'mode-mobile';
const DESKTOP = 'mode-desktop';

export const collections: VariableCollectionLike[] = [
  {
    id: COLORS,
    name: 'Colors',
    defaultModeId: LIGHT,
    modes: [
      { modeId: LIGHT, name: 'Light' },
      { modeId: DARK, name: 'Dark' },
    ],
  },
  {
    id: SEMANTIC,
    name: 'Semantic',
    defaultModeId: LIGHT,
    modes: [
      { modeId: LIGHT, name: 'Light' },
      { modeId: DARK, name: 'Dark' },
    ],
  },
  {
    id: SIZES,
    name: 'Sizes',
    defaultModeId: MOBILE,
    // A platform axis, not a theme axis — must not be scored for light/dark parity.
    modes: [
      { modeId: MOBILE, name: 'Mobile' },
      { modeId: DESKTOP, name: 'Desktop' },
    ],
  },
];

let counter = 0;
const nextId = () => `VariableID:${++counter}:0`;

const variables: VariableLike[] = [];

/** A primitive color with the same value in both themes. */
function primitive(name: string, light: string, dark = light, description?: string): VariableLike {
  const variable: VariableLike = {
    id: nextId(),
    name,
    resolvedType: 'COLOR',
    variableCollectionId: COLORS,
    description,
    scopes: ['ALL_SCOPES'],
    valuesByMode: { [LIGHT]: hexToRgba(light)!, [DARK]: hexToRgba(dark)! },
  };
  variables.push(variable);
  return variable;
}

/** A semantic token that aliases a primitive, optionally differing per theme. */
function semantic(name: string, light: VariableLike, dark = light, codeSyntax?: string): VariableLike {
  const variable: VariableLike = {
    id: nextId(),
    name,
    resolvedType: 'COLOR',
    variableCollectionId: SEMANTIC,
    scopes: ['ALL_SCOPES'],
    codeSyntax: codeSyntax ? { WEB: codeSyntax } : undefined,
    valuesByMode: {
      [LIGHT]: { type: 'VARIABLE_ALIAS', id: light.id },
      [DARK]: { type: 'VARIABLE_ALIAS', id: dark.id },
    },
  };
  variables.push(variable);
  return variable;
}

function size(group: string, name: string, mobile: number, desktop = mobile, scopes = ['ALL_SCOPES']): VariableLike {
  const variable: VariableLike = {
    id: nextId(),
    name: `${group}/${name}`,
    resolvedType: 'FLOAT',
    variableCollectionId: SIZES,
    scopes,
    valuesByMode: { [MOBILE]: mobile, [DESKTOP]: desktop },
  };
  variables.push(variable);
  return variable;
}

/* ---------------- Colors: primitive ramps (CLAUDE.md values) -------- */

const brand10 = primitive('global/brand/color-brand-10', '#E0EEFD', '#0F2D52');
const brand20 = primitive('global/brand/color-brand-20', '#AAD0F8', '#123A66');
const brand40 = primitive('global/brand/color-brand-40', '#219CDE', '#58ACE8');
const brand50 = primitive('global/brand/color-brand-50', '#007BBE', '#219CDE', 'Primary brand action');
primitive('global/brand/color-brand-30', '#58ACE8');
primitive('global/brand/color-brand-80', '#0F2D52', '#E0EEFD');

const gray0 = primitive('global/gray/color-gray-0', '#FFFFFF', '#303237');
const gray10 = primitive('global/gray/color-gray-10', '#F0F2F4', '#3F424D');
const gray20 = primitive('global/gray/color-gray-20', '#D0D4DA', '#515660');
const gray30 = primitive('global/gray/color-gray-30', '#989AA1', '#797D89');
const gray50 = primitive('global/gray/color-gray-50', '#6A6F7C', '#989AA1');
const gray80 = primitive('global/gray/color-gray-80', '#303237', '#FFFFFF', 'Default body text');
primitive('global/gray/color-gray-40', '#797D89');
primitive('global/gray/color-gray-60', '#515660');
primitive('global/gray/color-gray-70', '#3F424D');
primitive('global/gray/color-gray-100', '#000000');

const red10 = primitive('global/red/color-red-10', '#FFEFF1', '#61000D');
const red50 = primitive('global/red/color-red-50', '#E0031F', '#F65F73');
primitive('global/red/color-red-20', '#FDABB6');
primitive('global/red/color-red-60', '#AA0015');
primitive('global/red/color-red-80', '#61000D');

const green50 = primitive('global/green/color-green-50', '#66AC20', '#82C241');
primitive('global/green/color-green-10', '#F1F8EA', '#005616');
primitive('global/green/color-green-70', '#016E1C');

const yellow40 = primitive('global/yellow/color-yellow-40', '#F57504', '#FEA634');
primitive('global/yellow/color-yellow-10', '#FEF6E6', '#602300');
primitive('global/yellow/color-yellow-70', '#7C2E01');

/* ---------------- Semantic layer: aliases into the primitives ------- */

semantic('action/color-action-primary-default', brand50, brand50, 'var(--color-brand-50)');
semantic('action/color-action-primary-hover', brand40, brand40);
semantic('action/color-action-primary-tint', brand10, brand10);
semantic('action/color-action-focus-ring', brand20, brand20);

semantic('surface/color-surface-default', gray0, gray0, 'var(--color-gray-0)');
semantic('surface/color-surface-sunken', gray10, gray10);

semantic('content/color-content-default', gray80, gray80, 'var(--color-gray-80)');
semantic('content/color-content-secondary', gray50, gray50);
semantic('content/color-content-placeholder', gray30, gray30);

semantic('border/color-border-default', gray20, gray20);

semantic('status/color-status-negative', red50, red50);
semantic('status/color-status-negative-tint', red10, red10);
semantic('status/color-status-positive', green50, green50);
semantic('status/color-status-warning', yellow40, yellow40);

// Seeded defect: segment-order inversion against color-content-default.
variables.push({
  id: nextId(),
  name: 'content/content-color-default',
  resolvedType: 'COLOR',
  variableCollectionId: SEMANTIC,
  scopes: ['ALL_SCOPES'],
  valuesByMode: {
    [LIGHT]: { type: 'VARIABLE_ALIAS', id: gray80.id },
    [DARK]: { type: 'VARIABLE_ALIAS', id: gray80.id },
  },
});

// Seeded defect: alias pointing at a variable that no longer exists.
variables.push({
  id: nextId(),
  name: 'surface/color-surface-overlay',
  resolvedType: 'COLOR',
  variableCollectionId: SEMANTIC,
  scopes: ['ALL_SCOPES'],
  valuesByMode: {
    [LIGHT]: { type: 'VARIABLE_ALIAS', id: 'VariableID:deleted:0' },
    [DARK]: { type: 'VARIABLE_ALIAS', id: 'VariableID:deleted:0' },
  },
});

/* ---------------- Sizes: spacing, radius and typography scales ------- */

for (const step of [2, 4, 6, 8, 12, 16, 24, 28, 32, 40, 44, 56]) {
  size('padding', `global-padding-${step}`, step, step, ['GAP', 'WIDTH_HEIGHT']);
}
for (const step of [2, 4, 8, 12, 16, 24, 32, 40, 44, 56, 64, 128]) {
  size('spacing', `global-spacing-${step}`, step, step, ['GAP', 'WIDTH_HEIGHT']);
}

// Seeded defects: uppercase suffixes throughout, plus one misspelling.
size('radius', 'global-raduis-S', 4, 4, ['CORNER_RADIUS']);
size('radius', 'global-radius-M', 6, 6, ['CORNER_RADIUS']);
size('radius', 'global-radius-L', 8, 8, ['CORNER_RADIUS']);
size('radius', 'global-radius-XL', 12, 12, ['CORNER_RADIUS']);
size('radius', 'global-radius-XXL', 16, 16, ['CORNER_RADIUS']);

size('Typography/fontSize', 'global-fontSize-H1', 20, 40);
size('Typography/fontSize', 'global-fontSize-H2', 18, 32);
size('Typography/fontSize', 'global-fontSize-H3', 16, 25);
size('Typography/fontSize', 'global-fontSize-medium', 16, 16);
size('Typography/fontSize', 'global-fontSize-small', 14, 14);
size('Typography/fontSize', 'global-fontSize-xsmall', 12, 12);
size('Typography/fontSize', 'global-fontSize-xxsmall', 11, 11);
size('Typography/fontWeight', 'global-fontWeight-L', 400, 400);
size('Typography/fontWeight', 'global-fontWeight-XL', 500, 500);
size('Typography/letterSpacing', 'global-letterSpacing-L', 0, 0);
size('Typography/letterSpacing', 'global-letterSpacing-S', -0.1, -0.1);
size('Typography/letterSpacing', 'global-letterSpacing-XS', -0.2, -0.2);

export { variables };

/** Drop-in replacement for `figma.variables`. */
export const mockVariablesApi: VariablesApi = {
  getLocalVariableCollectionsAsync: async () => collections,
  getLocalVariablesAsync: async () => variables,
  getVariableByIdAsync: async (id) => variables.find((v) => v.id === id) ?? null,
};

export function variableIdByName(name: string): string | undefined {
  return variables.find((v) => v.name === name)?.id;
}

/**
 * Stand-in for the document scan.
 *
 * The scan itself needs a live scene graph, so these numbers are synthetic — but
 * they are shaped exactly like a real ScanResult so the reuse bars, override
 * table and per-component coverage all render as they would in Figma.
 */
export function mockScanData() {
  const usage = new Map<string, number>();
  const add = (name: string, count: number) => {
    const id = variableIdByName(name);
    if (id) usage.set(id, count);
  };

  add('action/color-action-primary-default', 34);
  add('content/color-content-default', 28);
  add('surface/color-surface-default', 22);
  add('border/color-border-default', 19);
  add('spacing/global-spacing-8', 17);
  add('spacing/global-spacing-16', 15);
  add('action/color-action-primary-hover', 11);
  add('radius/global-radius-L', 9);
  add('content/color-content-secondary', 7);
  add('status/color-status-negative', 4);

  return {
    usageByVariableId: usage,
    overrides: [
      {
        area: 'global-button / type=primary',
        literal: '#007BBE',
        replacement: 'var(--color-brand-50)',
        details: '3 occurrences (fills) — exact match to an existing token',
        occurrences: 3,
      },
      {
        area: 'card-panel / header',
        literal: '#0F2D52',
        replacement: 'var(--color-brand-80)',
        details: '2 occurrences (fills) — exact match to an existing token',
        occurrences: 2,
      },
      {
        area: 'form-field / helper text',
        literal: '#6A6F7B',
        replacement: 'var(--color-gray-50)',
        details: '2 occurrences (fills) — near match (ΔE 0.4) — likely the same intent',
        occurrences: 2,
      },
      {
        area: 'tab-bar / active indicator',
        literal: '#1B7F4C',
        replacement: '(no token within tolerance)',
        details: '1 occurrence (strokes) — nearest token is ΔE 22.7 away — this is a genuinely new color',
        occurrences: 1,
      },
      {
        area: 'Paint style: Overlay scrim',
        literal: '#000000',
        replacement: 'var(--color-gray-100)',
        details: '1 occurrence (fills)',
        severity: 'info' as const,
        occurrences: 1,
      },
    ],
    components: [
      { name: 'global-button', modeCoverage: { Light: true, Dark: true }, colorTokenCount: 6, literalCount: 0 },
      { name: 'global-input', modeCoverage: { Light: true, Dark: true }, colorTokenCount: 5, literalCount: 0 },
      { name: 'global-badge', modeCoverage: { Light: true, Dark: true }, colorTokenCount: 4, literalCount: 0 },
      {
        name: 'card-panel',
        modeCoverage: { Light: true, Dark: false },
        colorTokenCount: 4,
        literalCount: 2,
        reason: '2 hardcoded color literals cannot follow a theme change.',
      },
      {
        name: 'tab-bar',
        modeCoverage: { Light: true, Dark: false },
        colorTokenCount: 3,
        literalCount: 1,
        reason: '1 hardcoded color literal cannot follow a theme change.',
      },
      { name: 'global-tooltip', modeCoverage: { Light: true, Dark: true }, colorTokenCount: 3, literalCount: 0 },
    ],
    stats: { pages: 4, nodes: 12_418, truncated: false },
  };
}
