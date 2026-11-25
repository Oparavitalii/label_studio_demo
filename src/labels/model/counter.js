// The counter is a pure sequence function: it turns a numeric range into
// the list of label strings printed one-per-page. It is TOTAL - any
// invalid input (bad range, non-integer bounds, zero step) resolves to an
// empty sequence instead of throwing, so callers never need a try/catch.

import { applyToken } from './tokens.js';

function padNumber(n, pad) {
  const negative = n < 0;
  const abs = Math.abs(n);
  let digits = String(abs);
  if (Number.isInteger(pad) && pad > 0) {
    digits = digits.padStart(pad, '0');
  }
  return negative ? `-${digits}` : digits;
}

export function buildSequence({
  enabled,
  start,
  end,
  step,
  pad,
  prefix = '',
  suffix = '',
} = {}) {
  if (!enabled) return [];
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    !Number.isInteger(step) ||
    step === 0
  ) {
    return [];
  }

  const values = [];
  if (step > 0) {
    for (let n = start; n <= end; n += step) {
      values.push(n);
    }
  } else {
    for (let n = start; n >= end; n += step) {
      values.push(n);
    }
  }

  return values.map((n) => `${prefix}${padNumber(n, pad)}${suffix}`);
}

export function countLabels(counter) {
  return buildSequence(counter).length;
}

// --- counting per element -------------------------------------------------
//
// Counting used to belong to the document: one global counter, one sequence.
// It now belongs to `number` elements, so these four functions answer the two
// questions the print sheet actually asks - HOW MANY pages, and WHAT does this
// element show on page N.
//
// Everything above this line is unchanged and still passes its 41 tests:
// `buildSequence` is the maths, and only its owner moved.

// What a number element actually SHOWS. Its `content` is a template - the
// default is just '{n}' - so a number is a text element whose token is filled
// from its own sequence. Canvas passes index 0 and the print sheet passes the
// page index, which is what keeps the editor WYSIWYG: both call this.
export function numberText(el, index = 0) {
  const value = valueAt(el, index);
  if (value === null) return '';
  return applyToken(el?.content ?? '{n}', value);
}

// A number element has no `enabled` flag - it exists, therefore it counts.
// The flag was a property of the global panel, which is gone.
function sequenceOf(el) {
  return buildSequence({ ...(el?.counter ?? {}), enabled: true });
}

// The strings a number element's box has to be wide enough to hold.
//
// Measuring only the FIRST value is what put "1" above "0" on a 1..100 run:
// the box was fitted to `1`, and `10` then had nowhere to go but a second
// line. Only the LONGEST values can be the widest - prefix, suffix and pad
// are constant across a sequence, and no font draws a digit narrower than no
// digit at all - so the sample is every entry of maximal length. Ties inside
// that set are real (111 and 888 are the same length and not the same width),
// so all of them are measured, up to a cap: a 1..100000 range must not stall
// the editor on every keystroke.
export const FIT_SAMPLE_CAP = 64;

export function fitCandidates(el, cap = FIT_SAMPLE_CAP) {
  const seq = sequenceOf(el);
  if (seq.length === 0) return [];

  let longest = 0;
  for (const value of seq) {
    if (value.length > longest) longest = value.length;
  }

  const template = el?.content ?? '{n}';
  const out = [];
  for (const value of seq) {
    if (value.length !== longest) continue;
    out.push(applyToken(template, value));
    if (out.length >= cap) break;
  }
  return out;
}

export function numberElements(elements) {
  return (Array.isArray(elements) ? elements : []).filter(
    (el) => el && el.type === 'number',
  );
}

// The print run is the LONGEST number element's sequence OR the imported
// file's row count, whichever asks for more pages, and never below 1. No
// number element and no file - or every range empty - still prints one label.
//
// `rowCount` is the second argument rather than a second function because
// this is the ONE number the page list, the print panel's total and the
// headless render's `expectedPages` all read. Two functions would be two
// answers, and the one that disagrees makes the server wait out its whole
// timeout on a print that was ready.
export function pageCount(elements, rowCount = 0) {
  const lengths = numberElements(elements).map((el) => sequenceOf(el).length);
  const rows = Number.isFinite(rowCount)
    ? Math.max(0, Math.trunc(rowCount))
    : 0;
  return Math.max(1, rows, ...lengths, 0);
}

// "Longest wins, shorter holds its last value": an element whose own range
// runs out clamps to its final entry rather than going blank or repeating.
export function valueAt(el, index) {
  const seq = sequenceOf(el);
  if (seq.length === 0) return null;
  return seq[Math.min(index, seq.length - 1)];
}

// What `{n}` resolves against, in text / qr / barcode content. It is the
// longest sequence - the same one that sets the page count - so the number
// of pages and the value substituted into them can never disagree. Ties are
// broken by element order.
export function drivingSequence(elements) {
  let best = [];
  for (const el of numberElements(elements)) {
    const seq = sequenceOf(el);
    if (seq.length > best.length) best = seq;
  }
  return best;
}
