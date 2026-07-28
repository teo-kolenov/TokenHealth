import type { ComponentUsage, DirectOverride, NormalizedInput, Token } from '../analysis/types.ts';
import type { ScanScope } from '../shared/messages.ts';
import { ScanControl } from './yield.ts';
import { rgbaToHex, hexDeltaE } from './color.ts';

/**
 * Document scan: measures token reuse, finds raw color literals, and derives
 * per-component theme coverage.
 *
 * Everything here is optional and cancellable — the variables-only report is
 * already useful, and a whole-document walk on a large file is expensive.
 */

const SCANNABLE_TYPES = [
  'FRAME',
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
  'RECTANGLE',
  'ELLIPSE',
  'VECTOR',
  'POLYGON',
  'STAR',
  'LINE',
  'TEXT',
  'GROUP',
  'SECTION',
] as const;

export interface ScanStats {
  pages: number;
  nodes: number;
  truncated: boolean;
}

export interface ScanResult {
  usageByVariableId: Map<string, number>;
  overrides: DirectOverride[];
  components: ComponentUsage[];
  stats: ScanStats;
}

interface ColorIndexEntry {
  hex: string;
  replacement: string;
}

/** Build a hex -> replacement index from the extracted variables. */
export function buildColorIndex(input: NormalizedInput): ColorIndexEntry[] {
  const entries: ColorIndexEntry[] = [];
  for (const collection of input.collections) {
    for (const group of collection.groups) {
      if (group.type !== 'COLOR') continue;
      for (const token of group.tokens) {
        const values = token.valuesByMode ? Object.values(token.valuesByMode) : [token.value];
        for (const value of values) {
          if (typeof value !== 'string' || !value.startsWith('#')) continue;
          entries.push({
            hex: value.toUpperCase(),
            replacement: token.codeSyntax?.WEB ?? `var(--${token.name})`,
          });
        }
      }
    }
  }
  return entries;
}

/**
 * Suggest the token that should replace a raw literal. An exact match is a
 * clear win; a near match is worth reviewing; a distant color is genuinely new
 * and saying so is more useful than forcing a bad suggestion.
 */
export function suggestReplacement(
  hex: string,
  index: ColorIndexEntry[],
): { replacement: string; note: string } {
  const upper = hex.toUpperCase();
  const exact = index.find((e) => e.hex === upper);
  if (exact) return { replacement: exact.replacement, note: 'exact match to an existing token' };

  let best: { entry: ColorIndexEntry; distance: number } | null = null;
  for (const entry of index) {
    const distance = hexDeltaE(upper, entry.hex);
    if (distance === null) continue;
    if (!best || distance < best.distance) best = { entry, distance };
  }

  if (!best) return { replacement: '(no color tokens to match against)', note: '' };
  if (best.distance <= 2) {
    return { replacement: best.entry.replacement, note: `near match (ΔE ${best.distance.toFixed(1)}) — likely the same intent` };
  }
  if (best.distance <= 10) {
    return { replacement: best.entry.replacement, note: `closest token is ΔE ${best.distance.toFixed(1)} away — review before replacing` };
  }
  return { replacement: '(no token within tolerance)', note: `nearest token is ΔE ${best.distance.toFixed(1)} away — this is a genuinely new color` };
}

/** Nearest meaningful ancestor name, for the "Area" column. */
function areaNameOf(node: BaseNode): string {
  let current: BaseNode | null = node;
  let fallback = node.name;
  while (current) {
    if (current.type === 'COMPONENT_SET' || current.type === 'COMPONENT') return current.name;
    if (current.type === 'PAGE') return `Page: ${current.name}`;
    if (current.type === 'SECTION' || (current.type === 'FRAME' && current.parent?.type === 'PAGE')) {
      fallback = current.name;
    }
    current = current.parent;
  }
  return fallback;
}

function isInsideInstance(node: BaseNode): boolean {
  let current: BaseNode | null = node.parent;
  while (current) {
    if (current.type === 'INSTANCE') return true;
    current = current.parent;
  }
  return false;
}

function collectBoundIds(node: SceneNode, into: (id: string) => void): void {
  const bound = (node as SceneNode & { boundVariables?: Record<string, unknown> }).boundVariables;
  if (!bound) return;
  for (const value of Object.values(bound)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const id = (entry as { id?: string })?.id;
        if (id) into(id);
      }
    } else {
      const id = (value as { id?: string })?.id;
      if (id) into(id);
    }
  }
}

export interface ScanOptions {
  scope: ScanScope;
  maxNodes: number;
  input: NormalizedInput;
  control: ScanControl;
}

export async function scanDocument(options: ScanOptions): Promise<ScanResult> {
  const { scope, maxNodes, input, control } = options;

  const usageByVariableId = new Map<string, number>();
  const literalTally = new Map<string, { area: string; count: number; kinds: Set<string> }>();
  const componentColors = new Map<string, { variableIds: Set<string>; literals: number }>();

  const stats: ScanStats = { pages: 0, nodes: 0, truncated: false };
  if (scope === 'none') return { usageByVariableId, overrides: [], components: [], stats };

  // Large win on files with many component instances.
  figma.skipInvisibleInstanceChildren = true;

  let nodes: SceneNode[] = [];
  if (scope === 'selection') {
    const selection = figma.currentPage.selection;
    nodes = selection.flatMap((node) =>
      'findAllWithCriteria' in node
        ? [node, ...(node as FrameNode).findAllWithCriteria({ types: SCANNABLE_TYPES as unknown as NodeType[] })]
        : [node],
    );
    stats.pages = 1;
  } else if (scope === 'page') {
    nodes = figma.currentPage.findAllWithCriteria({ types: SCANNABLE_TYPES as unknown as NodeType[] });
    stats.pages = 1;
  } else {
    await figma.loadAllPagesAsync();
    const pages = figma.root.children as PageNode[];
    stats.pages = pages.length;
    for (const page of pages) {
      await control.flush('scan', 0, pages.length, `Indexing ${page.name}`);
      nodes = nodes.concat(page.findAllWithCriteria({ types: SCANNABLE_TYPES as unknown as NodeType[] }));
      if (nodes.length > maxNodes) {
        stats.truncated = true;
        nodes = nodes.slice(0, maxNodes);
        break;
      }
    }
  }

  if (nodes.length > maxNodes) {
    stats.truncated = true;
    nodes = nodes.slice(0, maxNodes);
  }

  const colorIndex = buildColorIndex(input);
  const total = nodes.length;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    stats.nodes++;
    await control.tick('scan', i, total, `Scanning ${node.name || node.type}`);

    const insideInstance = isInsideInstance(node);
    const area = areaNameOf(node);

    // Track the owning component so mode coverage can be derived later.
    let componentEntry: { variableIds: Set<string>; literals: number } | undefined;
    if (!insideInstance) {
      let owner: BaseNode | null = node;
      while (owner && owner.type !== 'COMPONENT' && owner.type !== 'COMPONENT_SET') owner = owner.parent;
      if (owner) {
        componentEntry = componentColors.get(owner.name);
        if (!componentEntry) {
          componentEntry = { variableIds: new Set(), literals: 0 };
          componentColors.set(owner.name, componentEntry);
        }
      }
    }

    const record = (id: string) => {
      usageByVariableId.set(id, (usageByVariableId.get(id) ?? 0) + 1);
      componentEntry?.variableIds.add(id);
    };

    if (insideInstance) {
      // Counting bindings inside every instance would turn "most reused token"
      // into a popularity contest between screens. Instances are credited once
      // via their main component below.
      continue;
    }

    collectBoundIds(node, record);

    if (node.type === 'INSTANCE') {
      try {
        const main = await node.getMainComponentAsync();
        if (main) collectBoundIds(main, record);
      } catch {
        /* a detached or unavailable main component is not fatal */
      }
      continue;
    }

    // Per-paint bindings are the authoritative source for color.
    for (const key of ['fills', 'strokes'] as const) {
      const paints = (node as SceneNode & Record<string, unknown>)[key];
      if (!paints || paints === figma.mixed || !Array.isArray(paints)) continue;

      for (const paint of paints as Paint[]) {
        if (paint.type !== 'SOLID' || paint.visible === false) continue;
        const boundColor = (paint as SolidPaint & { boundVariables?: { color?: { id: string } } }).boundVariables?.color;
        if (boundColor?.id) {
          record(boundColor.id);
          continue;
        }

        const hex = rgbaToHex({ ...paint.color, a: paint.opacity ?? 1 });
        const tallyKey = `${hex}|${area}`;
        const existing = literalTally.get(tallyKey);
        if (existing) {
          existing.count++;
          existing.kinds.add(key);
        } else {
          literalTally.set(tallyKey, { area, count: 1, kinds: new Set([key]) });
        }
        if (componentEntry) componentEntry.literals++;
      }
    }
  }

  /* --- Raw literals -> override rows ------------------------------- */
  const overrides: DirectOverride[] = [];
  for (const [key, tally] of literalTally) {
    const hex = key.split('|')[0];
    const { replacement, note } = suggestReplacement(hex, colorIndex);
    // Pure white and black are usually scaffolding rather than a theming bug.
    // They stay in the table but do not count as failures.
    const informational = hex === '#FFFFFF' || hex === '#000000';
    overrides.push({
      area: tally.area,
      literal: hex,
      replacement,
      details:
        `${tally.count} occurrence${tally.count === 1 ? '' : 's'} (${[...tally.kinds].join(', ')})` +
        (note ? ` — ${note}` : ''),
      severity: informational ? 'info' : undefined,
      occurrences: tally.count,
    });
  }
  overrides.sort((a, b) => (b.occurrences ?? 0) - (a.occurrences ?? 0));

  /* --- Per-component theme coverage -------------------------------- */
  const components = deriveModeCoverage(input, componentColors);

  return { usageByVariableId, overrides, components, stats };
}

/**
 * A component is theme-complete when every color variable it consumes has a real
 * value in each theme mode — and when it contains no raw literal, since a
 * hardcoded hex cannot respond to a theme change at all.
 */
function deriveModeCoverage(
  input: NormalizedInput,
  componentColors: Map<string, { variableIds: Set<string>; literals: number }>,
): ComponentUsage[] {
  const themeCollections = input.collections.filter((c) => c.themeAxis);
  if (themeCollections.length === 0) return [];

  const themeModes = [...new Set(themeCollections.flatMap((c) => c.modes ?? []))];
  const tokensById = new Map<string, Token>();
  for (const collection of input.collections) {
    if (!collection.themeAxis) continue;
    for (const group of collection.groups) {
      if (group.type !== 'COLOR') continue;
      for (const token of group.tokens) {
        if (token.figmaVariableId) tokensById.set(token.figmaVariableId, token);
      }
    }
  }

  const out: ComponentUsage[] = [];
  for (const [name, usage] of componentColors) {
    const colorTokens = [...usage.variableIds].map((id) => tokensById.get(id)).filter((t): t is Token => !!t);
    // A component with no color usage is not a dark-mode failure.
    if (colorTokens.length === 0 && usage.literals === 0) continue;

    const modeCoverage: Record<string, boolean> = {};
    for (const mode of themeModes) {
      const allResolve = colorTokens.every((token) => {
        const value = token.valuesByMode?.[mode];
        return value !== null && value !== undefined && !token.aliasBroken;
      });
      modeCoverage[mode] = allResolve && usage.literals === 0;
    }

    out.push({
      name,
      modeCoverage,
      tokens: colorTokens.map((t) => t.name),
      colorTokenCount: colorTokens.length,
      literalCount: usage.literals,
      reason:
        usage.literals > 0
          ? `${usage.literals} hardcoded color literal${usage.literals === 1 ? '' : 's'} cannot follow a theme change.`
          : undefined,
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Fold scan results back into the normalized input the analyzer consumes. */
export function applyScanResult(input: NormalizedInput, scan: ScanResult, scope: ScanScope): NormalizedInput {
  for (const collection of input.collections) {
    for (const group of collection.groups) {
      for (const token of group.tokens) {
        if (!token.figmaVariableId) continue;
        const count = scan.usageByVariableId.get(token.figmaVariableId);
        if (count) token.usageCount = count;
      }
    }
  }

  input.components = scan.components;
  input.directCssOverrides = scan.overrides;
  input.meta.scanScope = scope;
  input.meta.scannedNodes = scan.stats.nodes;
  input.meta.scanTruncated = scan.stats.truncated || undefined;
  return input;
}
