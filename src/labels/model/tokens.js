// Text, QR and barcode content can carry a {n} token that gets substituted
// per label at print time, and - once a spreadsheet has been imported -
// {ColumnName} tokens that get substituted from that page's row.
//
// Two substituters, one syntax, and they are deliberately separate: {n} comes
// from the counter and exists on every label, {Column} comes from the data and
// exists only while a file is loaded. Folding them into one function would
// mean a column called "n" could silently take over every counter on the
// label.

import { lookup } from './dataset.js';

const TOKEN_RE = /\{([^{}]+)\}/g;

export function applyToken(content, value) {
  if (typeof content !== 'string') return content;
  return content.split('{n}').join(String(value));
}

// {ColumnName} -> that row's value. The name is trimmed and matched without
// case, so a header typed "Order No" answers to "{order no}" and to
// "{ Order No }".
//
// An UNKNOWN token is left exactly as written. That is the deliberate choice:
// a mistyped {Kod} prints as "{Kod}" and is caught by the eye on the first
// label, where blanking it would print a label that looks finished and is
// missing its code. `{n}` is passed through untouched for the same reason it
// is excluded everywhere else - it belongs to the counter.
export function applyRowTokens(content, row) {
  if (typeof content !== 'string' || !row) return content;

  return content.replace(TOKEN_RE, (match, name) => {
    const column = String(name).trim();
    if (!column || column.toLowerCase() === 'n') return match;
    const value = lookup(row, column);
    return value === undefined ? match : String(value ?? '');
  });
}
