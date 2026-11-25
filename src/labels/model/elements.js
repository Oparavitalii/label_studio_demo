import { nanoid } from 'nanoid';

import { CAP_MM_MAX, CAP_MM_MIN, DEFAULT_CAP_MM } from './textMetrics.js';

// Fields every element carries, regardless of type. Per-type defaults below
// override only what makes sense for that type; the rest stay null so
// generic code (updateElement, the property panel) can treat every element
// the same shape.
const BASE_ELEMENT = {
  xMm: 2,
  yMm: 2,
  rot: 0,
  z: 0,
  content: '',
  fontFamily: null,
  // Type size, authored as the HEIGHT OF A CAPITAL LETTER in millimetres.
  // fontSizePt is the retired point-size field, kept on the base element so a
  // template saved before the switch still parses; loadDoc migrates it.
  fontCapMm: null,
  fontSizePt: null,
  align: null,
  fill: null,
  stroke: null,
  strokeMm: null,
  barcodeFormat: null,
  // Only `number` elements carry one. Everything else counts for nothing.
  counter: null,
};

// Every default box fits inside the 60x20 mm standard label at the default
// xMm/yMm origin of (2, 2): the widest defaults are text and barcode at 40mm,
// which is 42 of the 60 available.
const TYPE_DEFAULTS = {
  text: {
    wMm: 40,
    hMm: 8,
    content: 'Text',
    fontFamily: 'Inter',
    fontCapMm: DEFAULT_CAP_MM,
    align: 'left',
    fill: '#000000',
  },
  image: {
    wMm: 20,
    hMm: 16,
    content: '',
  },
  rect: {
    wMm: 20,
    hMm: 10,
    fill: '#000000',
    stroke: '#000000',
    strokeMm: 0.3,
  },
  line: {
    wMm: 30,
    hMm: 0.5,
    stroke: '#000000',
    strokeMm: 0.3,
  },
  qr: {
    wMm: 14,
    hMm: 14,
    content: '{n}',
  },
  // A number element is a text element that counts. It has no `enabled`
  // flag: it exists, therefore it counts - deleting it is how you stop.
  number: {
    wMm: 25,
    hMm: 8,
    content: '{n}',
    fontFamily: 'Inter',
    fontCapMm: DEFAULT_CAP_MM,
    align: 'left',
    fill: '#000000',
    counter: { start: 1, end: 10, step: 1, pad: 0, prefix: '', suffix: '' },
  },
  barcode: {
    wMm: 40,
    hMm: 12,
    content: '{n}',
    barcodeFormat: 'CODE128',
  },
  // Data Matrix. 15x15 mm is the size the production label already prints
  // (Label_Print/src/Label_70.jsx), so a code added here
  // comes out at the size the scanner in the warehouse is used to. It adds
  // no field of its own: `content` carries the payload exactly as qr does,
  // which is what keeps the Properties panel's inputs controlled.
  matrix: {
    wMm: 15,
    hMm: 15,
    content: '/CODE/1/000001',
    fill: '#000000',
  },
};

// Only these two types draw type, so only these two have a size to scale.
const SIZED_TEXT_TYPES = new Set(['text', 'number']);

// The font size a text box should end up with after being dragged to a new
// height. Type is a VERTICAL measure, so the box's height drives it: a box
// dragged to twice the height carries text at twice the point size, which
// is what "resize the text by pulling its corner" means to anyone who has
// used a label editor.
//
// Width is deliberately ignored. Dragging a box wider gives the same text
// more room to sit in - that is a layout change, not a type change - and
// tying the point size to both axes would make a corner drag scale the
// type by the square of what the eye expects.
export function scaleCapMm(el, nextHMm) {
  if (!el || !SIZED_TEXT_TYPES.has(el.type)) return null;

  const currentH = Number(el.hMm);
  const nextH = Number(nextHMm);
  // A zero or missing height would make the ratio infinite or NaN and write
  // garbage into the model, so refuse rather than guess.
  if (!(currentH > 0) || !(nextH > 0)) return null;

  const current = el.fontCapMm ?? DEFAULT_CAP_MM;
  const scaled = current * (nextH / currentH);
  const clamped = Math.min(CAP_MM_MAX, Math.max(CAP_MM_MIN, scaled));

  // Tenths of a millimetre: finer than a 300dpi head resolves, and it keeps
  // the Properties field readable.
  return Math.round(clamped * 10) / 10;
}

export function createElement(type) {
  const defaults = TYPE_DEFAULTS[type];
  if (!defaults) {
    throw new Error(`createElement: unknown element type "${type}"`);
  }

  return {
    id: nanoid(),
    type,
    ...BASE_ELEMENT,
    ...defaults,
  };
}
