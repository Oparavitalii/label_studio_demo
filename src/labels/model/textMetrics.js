// Type size, in the unit the rest of this model already speaks.
//
// Font size is authored as the HEIGHT OF A CAPITAL LETTER in millimetres.
// That is what a label spec means by "3mm text" and what someone checks with
// a ruler; the typographic em size is about 1.4x taller than its capitals and
// would make the number on screen disagree with the number on the label.
// The em size still exists - CSS needs it - but it is derived here and never
// stored.
//
// The unit chain matters and is the same one that bit this project twice.
// The model speaks millimetres; CSS resolves 1mm to 96/25.4 px and 1pt to
// 96/72 px. PX_PER_MM (8) in units.js is a SCREEN zoom constant and belongs
// to neither - using it here would size boxes correctly on the canvas and
// wrongly on paper, which is the class of bug that clipped a barcode to 15 of
// its 31 bars in run 1 and made canvas text 2.1167x too small in run 4.

export const MM_PER_PT = 25.4 / 72; // 1pt = 1/72in, 1mm = 1/25.4in
export const MM_PER_CSS_PX = 25.4 / 96; // CSS fixes 1in = 96px
export const CSS_PX_PER_MM = 96 / 25.4;

// Matches the line-height ElementView renders text at. If one changes the
// other must, or the box stops matching what it contains.
export const TEXT_LINE_HEIGHT = 1.15;

// A hair of breathing room on each side, so a descender or an italic's
// overhang is not clipped by a box that fits the glyphs exactly.
export const TEXT_PADDING_MM = 0.4;

// A font's cap height as a fraction of its em size. Inter sits at ~0.727;
// this is the fallback used when there is no DOM to measure with (Node,
// vitest) so the maths resolves to something sane rather than to NaN.
export const NOMINAL_CAP_RATIO = 0.72;

// Bounds are in cap-mm too: 0.3mm is finer than a 300dpi thermal head can
// resolve, and 40mm is twice the height of the default label.
export const CAP_MM_MIN = 0.3;
export const CAP_MM_MAX = 40;
export const DEFAULT_CAP_MM = 2.5;

const round1 = (n) => Math.round(n * 10) / 10;

let sharedContext;

function context2d() {
  if (typeof document === 'undefined') return null;
  if (!sharedContext) {
    sharedContext = document.createElement('canvas').getContext('2d');
  }
  return sharedContext ?? null;
}

// Returns null - never a guess - when there is no DOM to measure with, so a
// caller can tell "no measurement available" apart from "zero wide".
export function measureTextWidthPx(text, cssFont) {
  const ctx = context2d();
  if (!ctx) return null;
  ctx.font = cssFont;
  return ctx.measureText(text).width;
}

// Measured once per family and cached: this is a font metric, not a value
// that changes between calls, and measuring it on every keystroke would be
// wasteful for a number that never moves.
const capRatioCache = new Map();

export function capRatioFor(fontFamily = 'Inter') {
  if (capRatioCache.has(fontFamily)) return capRatioCache.get(fontFamily);

  const ctx = context2d();
  let ratio = NOMINAL_CAP_RATIO;
  if (ctx) {
    // A capital H at a known size: its ink top above the baseline IS the cap
    // height. Measuring the real font beats assuming a ratio, and it keeps
    // "3mm" honest across families whose capitals differ.
    const probePx = 100;
    ctx.font = `${probePx}px ${fontFamily}`;
    const m = ctx.measureText('H');
    const ascent = m.actualBoundingBoxAscent;
    if (Number.isFinite(ascent) && ascent > 0) {
      const measured = ascent / probePx;
      // Guard against a font that failed to load and fell back to something
      // wild: anything outside this band is not a Latin cap height.
      if (measured > 0.45 && measured < 0.95) ratio = measured;
    }
  }

  capRatioCache.set(fontFamily, ratio);
  return ratio;
}

// The em size CSS needs, from the cap height the owner authored.
export function emMmFromCapMm(
  capMm,
  fontFamily = 'Inter',
  capRatio = capRatioFor,
) {
  const cap = Number(capMm);
  if (!(cap > 0)) return null;
  return cap / capRatio(fontFamily);
}

// The reverse, used once: to migrate a template saved when this field was a
// point size into the cap height that renders identically.
export function capMmFromPt(pt, fontFamily = 'Inter', capRatio = capRatioFor) {
  const points = Number(pt);
  if (!(points > 0)) return null;
  return round1(points * MM_PER_PT * capRatio(fontFamily));
}

// The box, in mm, that exactly holds `displayText` at this element's size.
// `displayText` is passed in rather than read off the element because a
// number element renders its resolved values, not its raw {n} template - and
// it may be an ARRAY of them, in which case the box holds every one. Returns
// null when the text cannot be measured, and the caller then leaves the
// current box alone rather than shrinking it to nothing.
export function fitTextBoxMm(
  el,
  displayText,
  measure = measureTextWidthPx,
  capRatio = capRatioFor,
) {
  if (!el) return null;

  const family = el.fontFamily ?? 'Inter';
  const emMm = emMmFromCapMm(el.fontCapMm, family, capRatio);
  if (emMm === null) return null;

  const font = `${emMm * CSS_PX_PER_MM}px ${family}`;
  // One string, or a LIST of the strings this element could show. A number
  // element hands in every value its range will print, because the box has to
  // hold the widest of them - not just the first, which is how a 1..100 run
  // wrapped "10" onto two lines. The height comes from whichever candidate
  // needs the most lines.
  const candidates = Array.isArray(displayText)
    ? displayText.length
      ? displayText
      : ['']
    : [displayText];

  let widestPx = 0;
  let mostLines = 1;
  for (const candidate of candidates) {
    const lines = String(candidate ?? '').split('\n');
    if (lines.length > mostLines) mostLines = lines.length;
    for (const line of lines) {
      const w = measure(line, font);
      if (w === null || w === undefined || Number.isNaN(w)) return null;
      if (w > widestPx) widestPx = w;
    }
  }

  return {
    wMm: round1(widestPx * MM_PER_CSS_PX + TEXT_PADDING_MM * 2),
    hMm: round1(mostLines * emMm * TEXT_LINE_HEIGHT + TEXT_PADDING_MM * 2),
  };
}
