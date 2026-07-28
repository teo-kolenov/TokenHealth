import type { CanvasSummary } from '../shared/messages.ts';

/**
 * The plugin's only write operation, and only on an explicit user action.
 *
 * Everything else in this plugin is strictly read-only, which is what makes it
 * safe to run against a production library. This draws a summary frame so the
 * result can live in the file and be shared with the team.
 */

const FONT_REGULAR: FontName = { family: 'Roboto', style: 'Regular' };
const FONT_MEDIUM: FontName = { family: 'Roboto', style: 'Medium' };
const FALLBACK_REGULAR: FontName = { family: 'Inter', style: 'Regular' };
const FALLBACK_MEDIUM: FontName = { family: 'Inter', style: 'Medium' };

const GRAY_0: RGB = { r: 1, g: 1, b: 1 };
const GRAY_10: RGB = { r: 0.9412, g: 0.949, b: 0.9569 };
const GRAY_50: RGB = { r: 0.4157, g: 0.4353, b: 0.4863 };
const GRAY_80: RGB = { r: 0.1882, g: 0.1961, b: 0.2157 };
const BRAND_80: RGB = { r: 0.0588, g: 0.1765, b: 0.3216 };

const STATUS_COLORS: Record<string, RGB> = {
  ok: { r: 0.2627, g: 0.6118, b: 0.0431 },
  warn: { r: 0.9608, g: 0.4588, b: 0.0157 },
  fail: { r: 0.8784, g: 0.0118, b: 0.1216 },
  muted: GRAY_50,
};

async function loadFonts(): Promise<{ regular: FontName; medium: FontName }> {
  try {
    await Promise.all([figma.loadFontAsync(FONT_REGULAR), figma.loadFontAsync(FONT_MEDIUM)]);
    return { regular: FONT_REGULAR, medium: FONT_MEDIUM };
  } catch {
    // Roboto is not guaranteed to be available; Inter ships with Figma.
    await Promise.all([figma.loadFontAsync(FALLBACK_REGULAR), figma.loadFontAsync(FALLBACK_MEDIUM)]);
    return { regular: FALLBACK_REGULAR, medium: FALLBACK_MEDIUM };
  }
}

function text(content: string, font: FontName, size: number, color: RGB): TextNode {
  const node = figma.createText();
  node.fontName = font;
  node.characters = content;
  node.fontSize = size;
  node.fills = [{ type: 'SOLID', color }];
  return node;
}

export async function insertSummaryFrame(summary: CanvasSummary): Promise<FrameNode> {
  const fonts = await loadFonts();

  const frame = figma.createFrame();
  frame.name = `Token Health — ${summary.projectName}`;
  frame.layoutMode = 'VERTICAL';
  frame.primaryAxisSizingMode = 'AUTO';
  frame.counterAxisSizingMode = 'FIXED';
  frame.resize(720, 100);
  frame.itemSpacing = 24;
  frame.paddingTop = 32;
  frame.paddingBottom = 32;
  frame.paddingLeft = 32;
  frame.paddingRight = 32;
  frame.cornerRadius = 16;
  frame.fills = [{ type: 'SOLID', color: GRAY_0 }];

  /* --- Header ------------------------------------------------------ */
  const header = figma.createFrame();
  header.layoutMode = 'VERTICAL';
  header.primaryAxisSizingMode = 'AUTO';
  header.counterAxisSizingMode = 'AUTO';
  header.itemSpacing = 6;
  header.fills = [];
  header.appendChild(text(`Token Health Analysis`, fonts.medium, 24, GRAY_80));
  header.appendChild(text(`${summary.projectName} · ${summary.generatedAt}`, fonts.regular, 13, GRAY_50));
  frame.appendChild(header);

  /* --- Score ------------------------------------------------------- */
  const scoreRow = figma.createFrame();
  scoreRow.layoutMode = 'HORIZONTAL';
  scoreRow.primaryAxisSizingMode = 'AUTO';
  scoreRow.counterAxisSizingMode = 'AUTO';
  scoreRow.counterAxisAlignItems = 'CENTER';
  scoreRow.itemSpacing = 16;
  scoreRow.paddingTop = 16;
  scoreRow.paddingBottom = 16;
  scoreRow.paddingLeft = 20;
  scoreRow.paddingRight = 20;
  scoreRow.cornerRadius = 12;
  scoreRow.fills = [{ type: 'SOLID', color: GRAY_10 }];

  const [r, g, b] = summary.scoreColor;
  scoreRow.appendChild(text(`${summary.score}%`, fonts.medium, 40, { r, g, b }));
  const scoreLabel = figma.createFrame();
  scoreLabel.layoutMode = 'VERTICAL';
  scoreLabel.primaryAxisSizingMode = 'AUTO';
  scoreLabel.counterAxisSizingMode = 'AUTO';
  scoreLabel.itemSpacing = 2;
  scoreLabel.fills = [];
  scoreLabel.appendChild(text('Overall health', fonts.medium, 14, GRAY_80));
  scoreLabel.appendChild(text(summary.scoreLabel, fonts.regular, 12, GRAY_50));
  scoreRow.appendChild(scoreLabel);
  frame.appendChild(scoreRow);

  /* --- Stats ------------------------------------------------------- */
  const stats = figma.createFrame();
  stats.layoutMode = 'VERTICAL';
  stats.primaryAxisSizingMode = 'AUTO';
  stats.counterAxisSizingMode = 'FIXED';
  stats.layoutAlign = 'STRETCH';
  stats.itemSpacing = 8;
  stats.fills = [];

  for (const stat of summary.stats) {
    const row = figma.createFrame();
    row.layoutMode = 'HORIZONTAL';
    row.primaryAxisSizingMode = 'FIXED';
    row.counterAxisSizingMode = 'AUTO';
    row.layoutAlign = 'STRETCH';
    row.counterAxisAlignItems = 'CENTER';
    row.primaryAxisAlignItems = 'SPACE_BETWEEN';
    row.itemSpacing = 12;
    row.paddingTop = 10;
    row.paddingBottom = 10;
    row.paddingLeft = 12;
    row.paddingRight = 12;
    row.cornerRadius = 8;
    row.fills = [{ type: 'SOLID', color: GRAY_10 }];

    row.appendChild(text(stat.label, fonts.regular, 13, GRAY_50));
    row.appendChild(text(stat.value, fonts.medium, 14, STATUS_COLORS[stat.status] ?? GRAY_80));
    stats.appendChild(row);
  }
  frame.appendChild(stats);

  /* --- Findings ---------------------------------------------------- */
  if (summary.findings.length > 0) {
    const findings = figma.createFrame();
    findings.layoutMode = 'VERTICAL';
    findings.primaryAxisSizingMode = 'AUTO';
    findings.counterAxisSizingMode = 'FIXED';
    findings.layoutAlign = 'STRETCH';
    findings.itemSpacing = 6;
    findings.fills = [];
    findings.appendChild(text('Key findings', fonts.medium, 13, GRAY_80));
    for (const finding of summary.findings.slice(0, 6)) {
      const line = text(`•  ${finding}`, fonts.regular, 12, GRAY_50);
      line.layoutAlign = 'STRETCH';
      line.textAutoResize = 'HEIGHT';
      findings.appendChild(line);
    }
    frame.appendChild(findings);
  }

  const footer = text('Generated by the Token Health Analysis plugin', fonts.regular, 11, GRAY_50);
  footer.layoutAlign = 'STRETCH';
  frame.appendChild(footer);

  // Accent bar so the frame reads as a report at a glance.
  const accent = figma.createRectangle();
  accent.resize(720, 6);
  accent.fills = [{ type: 'SOLID', color: BRAND_80 }];
  accent.name = 'accent';
  frame.insertChild(0, accent);
  accent.layoutAlign = 'STRETCH';

  const { x, y } = figma.viewport.center;
  frame.x = Math.round(x - frame.width / 2);
  frame.y = Math.round(y - frame.height / 2);

  figma.currentPage.appendChild(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);
  return frame;
}
