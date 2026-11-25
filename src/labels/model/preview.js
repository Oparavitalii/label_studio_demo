// What an element SHOWS - on the canvas, on a printed page, and to the tape
// measure that decides how big its box is.
//
// Canvas.jsx, PrintSheet.jsx and editorStore.js each used to answer that
// question themselves, and the three answers were only accidentally the same.
// The store's answer was the one that was wrong: it measured the FIRST value
// of a number range, so a 1..100 element got a box sized for `1` and printed
// `10` as a "1" with a "0" underneath it. One definition, three callers.

import { fitCandidates, numberText } from './counter.js';
import { fitRows, rowAt } from './dataset.js';
import { applyRowTokens, applyToken } from './tokens.js';

// The content of one page.
//
// Three sources, in a fixed order and each with its own owner:
//   - a `number` element prints its OWN counter value, clamped to its last
//     entry once its range runs out;
//   - everything else resolves `{n}` from `driving`, the longest sequence on
//     the label, which is also what set the page count, so the token and the
//     number of pages can never disagree;
//   - `{Column}` then resolves from this page's row of the imported file.
export function resolveContent(el, index = 0, driving = [], dataset = null) {
  if (!el) return '';

  let content;
  if (el.type === 'number') {
    content = numberText(el, index);
  } else {
    const value = driving[index];
    content = value === undefined ? el.content : applyToken(el.content, value);
  }

  const row = rowAt(dataset, index);
  return row ? applyRowTokens(content, row) : content;
}

// Every string the element's box has to be able to hold, for `fitTextBoxMm`,
// which takes one string or a list of them.
//
// A number element contributes the widest values of its own range. A dataset
// then contributes the widest rows for whichever columns the content names -
// a box fitted to row 1 and filled with row 300 is the same bug as a box
// fitted to `1` and filled with `100`. Both samples are capped, so the worst
// case is a few hundred measurements rather than one per row.
//
// An empty range (start 5, end 1) has no values at all and falls back to what
// the element actually renders in that state, which is an empty string.
export function fitTexts(el, dataset = null) {
  if (!el) return '';

  let bases;
  if (el.type === 'number') {
    const values = fitCandidates(el);
    bases = values.length ? values : [numberText(el, 0)];
  } else {
    bases = [el.content];
  }

  const rows = fitRows(dataset, el.content);
  if (rows.length === 0) return bases.length === 1 ? bases[0] : bases;

  const out = [];
  for (const base of bases) {
    for (const row of rows) out.push(applyRowTokens(base, row));
  }
  return out;
}
