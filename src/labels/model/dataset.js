// A dataset is a spreadsheet the operator dropped on the editor: a list of
// column names and a list of rows. It prints one label per row, with
// {ColumnName} in any text / QR / barcode / matrix content resolved from that
// row - exactly the way {n} already resolves from the counter.
//
// This module is PURE. It parses, normalises and answers questions about a
// dataset; it never touches the DOM, the store or the network. `.xlsx` is
// parsed by the server (Server/index.js, POST /api/import) with the ExcelJS
// already installed for the report - `.csv` is parsed here, because it needs
// no library at all and then still works with the server down.

// A ceiling with a reason: 5,000 labels at EUR 0.5 a piece is EUR 2,500 of
// stock in one press of a button, and a spreadsheet longer than that is
// almost always the wrong file rather than a very large job. Both parse
// entry points REFUSE a longer file with a message; the slice in
// normaliseDataset is the structural backstop behind them, not the policy.
export const MAX_DATASET_ROWS = 5000;

// Delimiters a CSV in this trade actually arrives with. A Central-European
// Excel writes `;`, an English one `,`, an export from a database often a
// tab. Guessing beats forcing the operator to know which one they have.
const DELIMITERS = [',', ';', '\t', '|'];

// Sniffing reads the head of the file, not all of it: the delimiter is
// decided by the header row, and parsing a 5,000-row file four times to find
// out is work for nothing.
const SNIFF_CHARS = 4096;

// The token syntax, shared with tokens.js. `{n}` belongs to the counter and
// is never a column.
const TOKEN_RE = /\{([^{}]+)\}/g;

// How many rows the auto-fit box is measured against. The box has to hold
// the LONGEST value the column will show, and finding that needs no DOM -
// only the widest handful are then actually measured. See fitRows.
export const FIT_ROW_SAMPLE = 8;

function isRow(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function rowCount(dataset) {
  return Array.isArray(dataset?.rows) ? dataset.rows.length : 0;
}

export function hasRows(dataset) {
  return rowCount(dataset) > 0;
}

// The row printed on page `index`. It CLAMPS to the last row rather than
// going blank, which is the same rule valueAt already applies to a counter
// whose range runs out - "longest wins, shorter holds its last value".
export function rowAt(dataset, index) {
  const rows = dataset?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const i = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return rows[Math.min(i, rows.length - 1)];
}

// The column names a piece of content refers to, in the order written.
// `{n}` is excluded: it is the counter's, and a column called "n" would
// quietly hijack every counter on the label.
export function tokenColumns(content) {
  if (typeof content !== 'string') return [];
  const out = [];
  for (const match of content.matchAll(TOKEN_RE)) {
    const name = match[1].trim();
    if (name && name.toLowerCase() !== 'n' && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

// The rows worth MEASURING for the auto-fit box.
//
// A box fitted to row 1 and then filled with row 300 is the imported-data
// version of the bug that printed "10" as a 1 with a 0 underneath it. Fitting
// against all 5,000 rows on every keystroke is not affordable, so the rows
// are first ranked by the plain character length of the columns this content
// actually uses - no DOM, no font, just String.length - and only the longest
// few are handed to the measurer. A proportional font can still make a
// shorter string wider, which is why it is the longest FEW and not the
// longest one.
export function fitRows(dataset, content, cap = FIT_ROW_SAMPLE) {
  const rows = dataset?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Only tokens that name a REAL column can vary between rows. A {Kod} that
  // matches nothing prints the same string on every label, so measuring it
  // once per row would be the same answer eight times over.
  const known = new Set(
    (Array.isArray(dataset.columns) ? dataset.columns : []).map((column) =>
      String(column).trim().toLowerCase(),
    ),
  );
  const columns = tokenColumns(content).filter((column) =>
    known.has(column.trim().toLowerCase()),
  );
  if (columns.length === 0) return [];

  const scored = rows.map((row) => {
    let length = 0;
    for (const column of columns) {
      const value = lookup(row, column);
      if (value !== undefined) length += String(value).length;
    }
    return { row, length };
  });

  scored.sort((a, b) => b.length - a.length);
  return scored.slice(0, Math.max(1, cap)).map((entry) => entry.row);
}

// Column lookup is trimmed and case-insensitive, because a header typed
// "Order No" and a token typed "{order no}" mean the same column to everyone
// except a strict equality check.
export function lookup(row, column) {
  if (!isRow(row)) return undefined;
  const wanted = String(column ?? '')
    .trim()
    .toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.trim().toLowerCase() === wanted) return row[key];
  }
  return undefined;
}

// Header cells are not to be trusted: a spreadsheet can carry blanks, repeats
// and numbers. Every column ends up with a name that is unique and non-empty,
// so a token always exists for it and two columns never fight over one token.
export function normaliseColumns(input) {
  const raw = Array.isArray(input) ? input : [];
  const out = [];
  raw.forEach((value, index) => {
    let name = String(value ?? '').trim();
    if (!name) name = `Column ${index + 1}`;
    if (out.some((taken) => taken.toLowerCase() === name.toLowerCase())) {
      let n = 2;
      while (
        out.some(
          (taken) => taken.toLowerCase() === `${name} ${n}`.toLowerCase(),
        )
      ) {
        n += 1;
      }
      name = `${name} ${n}`;
    }
    out.push(name);
  });
  return out;
}

// Turns anything parse-shaped into the one dataset shape the store, the print
// sheet and the print job all speak. Returns null - never a half-dataset -
// when there is nothing usable, so a caller can say "that file had no rows"
// instead of showing an empty panel that looks like it worked.
export function normaliseDataset(input) {
  if (!input) return null;

  const columns = normaliseColumns(input.columns);
  const rawRows = Array.isArray(input.rows) ? input.rows : [];
  if (columns.length === 0 || rawRows.length === 0) return null;

  const rows = [];
  for (const raw of rawRows.slice(0, MAX_DATASET_ROWS)) {
    if (!isRow(raw)) continue;
    const row = {};
    for (const column of columns) {
      const value = lookup(raw, column);
      row[column] = value === undefined || value === null ? '' : String(value);
    }
    rows.push(row);
  }
  if (rows.length === 0) return null;

  return {
    name: String(input.name ?? '').trim() || 'data',
    columns,
    rows,
  };
}

// --- CSV -------------------------------------------------------------------

// RFC-4180 as it is actually met in the wild: quoted fields, doubled quotes
// inside them, CRLF or LF, and a delimiter that is whatever this locale's
// Excel felt like writing.
function splitRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  row.push(field);
  rows.push(row);

  // A trailing newline leaves one empty row behind, and a spreadsheet saved
  // with blank lines in the middle leaves more. None of them is a label.
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

export function sniffDelimiter(text) {
  const head = text.slice(0, SNIFF_CHARS);
  let best = DELIMITERS[0];
  let bestColumns = 0;

  for (const delimiter of DELIMITERS) {
    const rows = splitRows(head, delimiter);
    const columns = rows.length ? rows[0].length : 0;
    if (columns > bestColumns) {
      best = delimiter;
      bestColumns = columns;
    }
  }

  return best;
}

// A dependency-free CSV reader. Returns the raw `{ columns, rows }` shape;
// normaliseDataset is what turns it into a dataset, so the CSV path and the
// server's .xlsx path cannot produce two different shapes.
export function parseCsv(text) {
  // A BOM is invisible and would otherwise become part of the first column's
  // name, so `{Code}` would silently never match.
  const clean = String(text ?? '').replace(/^\uFEFF/, '');
  if (!clean.trim()) return { columns: [], rows: [] };

  const delimiter = sniffDelimiter(clean);
  const table = splitRows(clean, delimiter);
  if (table.length === 0) return { columns: [], rows: [] };

  const columns = normaliseColumns(table[0].map((cell) => cell.trim()));
  const rows = table.slice(1).map((cells) => {
    const row = {};
    columns.forEach((column, index) => {
      row[column] = (cells[index] ?? '').trim();
    });
    return row;
  });

  return { columns, rows };
}
