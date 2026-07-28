/**
 * Figma stores color channels as 0..1 floats. The analyzer keys duplicate
 * detection on the string form, so this conversion must be stable and must match
 * the uppercase-hex convention the rest of the pipeline uses.
 */

export interface RGBLike {
  r: number;
  g: number;
  b: number;
  a?: number;
}

function channel(value: number): string {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 255)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
}

/** `#RRGGBB`, or `#RRGGBBAA` when the color is not fully opaque. */
export function rgbaToHex(color: RGBLike): string {
  const alpha = color.a ?? 1;
  const base = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
  // Anything that rounds to FF is opaque for our purposes.
  return alpha >= 0.999 ? base : `${base}${channel(alpha)}`;
}

/** Parse `#RGB`, `#RRGGBB`, or `#RRGGBBAA` into 0..1 channels. */
export function hexToRgba(hex: string): RGBLike | null {
  const cleaned = hex.trim().replace(/^#/, '');
  const expand = cleaned.length === 3 ? cleaned.split('').map((c) => c + c).join('') : cleaned;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(expand)) return null;
  const int = (offset: number) => parseInt(expand.slice(offset, offset + 2), 16) / 255;
  return {
    r: int(0),
    g: int(2),
    b: int(4),
    a: expand.length === 8 ? int(6) : 1,
  };
}

/* ------------------------------------------------------------------ */
/* Perceptual distance — used to suggest the nearest existing token     */
/* ------------------------------------------------------------------ */

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

interface Lab {
  L: number;
  a: number;
  b: number;
}

export function rgbToLab(color: RGBLike): Lab {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);

  // sRGB -> XYZ (D65)
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE76 delta-E. Roughly: <=2 is imperceptible, >10 is a clearly different color. */
export function deltaE(a: RGBLike, b: RGBLike): number {
  const la = rgbToLab(a);
  const lb = rgbToLab(b);
  return Math.sqrt((la.L - lb.L) ** 2 + (la.a - lb.a) ** 2 + (la.b - lb.b) ** 2);
}

export function hexDeltaE(hexA: string, hexB: string): number | null {
  const a = hexToRgba(hexA);
  const b = hexToRgba(hexB);
  if (!a || !b) return null;
  return deltaE(a, b);
}
