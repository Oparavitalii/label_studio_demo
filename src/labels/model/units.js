// Millimetres are the model's only unit. Pixels exist solely for on-screen
// display, so printing needs no conversion: the same mm number that
// positions an element on screen positions it on the printed page.

export const PX_PER_MM = 8;

// The standard label. A new document opens at this size and it is the first
// entry in the Preset list; every other size is a deliberate choice away from
// it. Changed from 70 x 20 on 29.08.2026 (run 5, R-02) - 70 x 20 is still a
// preset, and a template saved at that size still opens at it.
export const DEFAULT_LABEL = { w: 60, h: 20 };

export function mmToPx(mm, zoom = 1) {
  return mm * PX_PER_MM * zoom;
}

export function pxToMm(px, zoom = 1) {
  return px / (PX_PER_MM * zoom);
}
