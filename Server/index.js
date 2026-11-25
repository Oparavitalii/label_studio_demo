// Label Studio — backend
// Express + node:sqlite (built-in, no native deps) + ExcelJS report.
// Serves the built frontend from ../dist on the same port.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import ExcelJS from 'exceljs';
import express from 'express';

import {
  AUTO_SN_WIDTH,
  DEFAULT_SUPPLIER_CODE,
  MACHINE_RANGES,
  NOK_GRADES,
  cellText,
  nokCodeOf,
  nokMatrixOf,
  nokNameOf,
  okMatrixOf,
  parseSerialInput,
  snOf,
} from './label_rules.js';
import { createPrintRouter } from './print.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 5180 is the port the packaged app, Start.bat and the README all name, so it
// stays the default and nothing an operator does changes. LABEL_PORT exists
// for the same reason LABEL_DATA_DIR does: an automated check must be able to
// start its OWN server rather than talk to the live one on 5180 by accident.
const PORT = Number(process.env.LABEL_PORT) || 5180;

// ---------- database ----------
// Defaults to the live Data/ beside this file - identical to the behaviour this
// server has always had. LABEL_DATA_DIR exists so an automated check can point
// the whole app at a throwaway copy instead.
//
// This is not hypothetical caution. During this migration seven batches were
// deleted out of the live database by an automated browser session sweeping the
// Production page, and MAX(serial) rolled back from 100020 to 100011 - which
// re-issues serials that have already been printed and stuck on parts. The
// deletion route did exactly what it is written to do; the mistake was letting a
// test session reach production data at all.
const dataDir = process.env.LABEL_DATA_DIR
  ? path.resolve(process.env.LABEL_DATA_DIR)
  : path.join(__dirname, '..', 'Data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'Label_Data.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id              INTEGER PRIMARY KEY,
    producer_number TEXT NOT NULL UNIQUE,
    customer_code    TEXT NOT NULL,
    name            TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS batches (
    id              INTEGER PRIMARY KEY,
    order_number    TEXT NOT NULL,
    product_id      INTEGER NOT NULL REFERENCES products(id),
    machine         INTEGER NOT NULL,
    quantity        INTEGER NOT NULL,
    repeats         INTEGER NOT NULL,
    supplier_code   TEXT NOT NULL,
    customer_code    TEXT,
    product_name    TEXT,
    producer_number TEXT,
    printed_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS labels (
    id       INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    serial   INTEGER NOT NULL,
    matrix   TEXT NOT NULL
  );

  -- NOK labels — parts that were NOT remanufactured, the customer's supplier manual section 5.
  --
  -- A SEPARATE table, deliberately not a "kind" column on batches, for two
  -- reasons that both cost money when ignored:
  --
  --  1. A NOK label HAS NO SERIAL NUMBER. Its serial field is replaced by
  --     "<9-code>_<GRADE>". labels.serial is NOT NULL and every serial query in
  --     this file (lastSerialForMachine, the range checks, the Excel export)
  --     reads that table directly. A NOK row living there would either need a
  --     fake serial - which the counter would then hand out as if it were
  --     printed - or a nullable column that every one of those queries has to
  --     remember to filter. Serial integrity is the one thing in this app that
  --     puts already-printed numbers back into circulation when it breaks.
  --
  --  2. One row per BATCH, not per label. Every label in a NOK run is
  --     byte-identical: there is no serial to vary, so quantity is a column.
  CREATE TABLE IF NOT EXISTS nok_batches (
    id              INTEGER PRIMARY KEY,
    order_number    TEXT NOT NULL,
    product_id      INTEGER REFERENCES products(id),
    grade           TEXT NOT NULL,
    quantity        INTEGER NOT NULL,
    repeats         INTEGER NOT NULL,
    supplier_code   TEXT NOT NULL,
    nok_code        TEXT NOT NULL,
    product_name    TEXT NOT NULL,
    producer_number TEXT NOT NULL,
    matrix          TEXT NOT NULL,
    voided          INTEGER NOT NULL DEFAULT 0,
    printed_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

// Serials may repeat now (the user reprints damaged labels under the same SN),
// so drop the historical UNIQUE constraint on labels.serial. It lives in a
// unique autoindex — if one is still present, rebuild the table without it.
const hasUniqueSerial =
  db
    .prepare(
      `SELECT COUNT(*) AS c FROM pragma_index_list('labels') WHERE origin = 'u'`,
    )
    .get().c > 0;
if (hasUniqueSerial) {
  db.exec(`
    BEGIN;
    CREATE TABLE labels_migrated (
      id       INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES batches(id),
      serial   INTEGER NOT NULL,
      matrix   TEXT NOT NULL
    );
    INSERT INTO labels_migrated (id, batch_id, serial, matrix)
      SELECT id, batch_id, serial, matrix FROM labels;
    DROP TABLE labels;
    ALTER TABLE labels_migrated RENAME TO labels;
    COMMIT;
  `);
}

// Product data is snapshotted into each batch at creation, so history, reprints
// and reports always show what was physically printed even if the product is
// edited later. The ALTERs migrate databases created before these columns existed.
//
// `serial_prefix` / `serial_width` describe the SHAPE of a batch's serials.
// The defaults ('' and 6) are exactly the automatic six-digit format, so every
// batch printed before manual formats existed reads back byte-identical.
for (const col of [
  'customer_code TEXT',
  'product_name TEXT',
  'producer_number TEXT',
  'voided INTEGER NOT NULL DEFAULT 0',
  "serial_prefix TEXT NOT NULL DEFAULT ''",
  'serial_width INTEGER NOT NULL DEFAULT 6',
]) {
  try {
    db.exec(`ALTER TABLE batches ADD COLUMN ${col}`);
  } catch {
    // Column already exists — this migration has run before. Nothing to do.
  }
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

// The counter reads the AUTOMATIC serial space only: plain six-digit serials
// inside the machine's range. A manual SN printed in that same shape (an
// operator typing 150000) still counts — that is the documented behaviour and
// the reason the range warning exists. A differently shaped one does not:
// "0150000" prints seven characters and is a different serial from 150000,
// so letting its stored 150000 move machine 1's counter would hand out the
// wrong next number.
function lastSerialForMachine(machine) {
  const { lo, hi } = MACHINE_RANGES[machine];
  const row = db
    .prepare(
      `SELECT MAX(l.serial) AS m
       FROM labels l JOIN batches b ON b.id = l.batch_id
       WHERE b.serial_prefix = '' AND b.serial_width = ?
         AND l.serial BETWEEN ? AND ?`,
    )
    .get(AUTO_SN_WIDTH, lo, hi);
  return row && row.m ? row.m : null;
}

function productById(id) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!p) return null;
  return {
    id: p.id,
    producerNumber: p.producer_number,
    customerCode: p.customer_code,
    name: p.name,
  };
}

function batchPayload(batchId) {
  const b = db
    .prepare(
      `SELECT b.*,
              COALESCE(b.producer_number, p.producer_number) AS snap_producer,
              COALESCE(b.customer_code, p.customer_code) AS snap_code,
              COALESCE(b.product_name, p.name) AS snap_name
       FROM batches b JOIN products p ON p.id = b.product_id
       WHERE b.id = ?`,
    )
    .get(batchId);
  if (!b) return null;
  // `sn` is the printed serial - what goes on the label, in the Data Matrix and
  // in the report. `serial` stays the raw number, because the reprint selection
  // and every ORDER BY still key on it.
  const prefix = b.serial_prefix ?? '';
  const width = b.serial_width ?? AUTO_SN_WIDTH;
  const labels = db
    .prepare(
      'SELECT serial, matrix FROM labels WHERE batch_id = ? ORDER BY serial',
    )
    .all(batchId)
    .map((l) => ({
      serial: l.serial,
      sn: snOf(prefix, width, l.serial),
      matrix: l.matrix,
    }));
  return {
    id: b.id,
    orderNumber: b.order_number,
    machine: b.machine,
    quantity: b.quantity,
    repeats: b.repeats,
    supplierCode: b.supplier_code,
    serialPrefix: prefix,
    serialWidth: width,
    printedAt: b.printed_at,
    voided: Boolean(b.voided),
    product: {
      id: b.product_id,
      producerNumber: b.snap_producer,
      customerCode: b.snap_code,
      name: b.snap_name,
    },
    labels,
  };
}

function nokBatchPayload(id) {
  const b = db.prepare('SELECT * FROM nok_batches WHERE id = ?').get(id);
  if (!b) return null;
  return {
    id: b.id,
    orderNumber: b.order_number,
    grade: b.grade,
    quantity: b.quantity,
    repeats: b.repeats,
    supplierCode: b.supplier_code,
    nokCode: b.nok_code,
    productName: b.product_name,
    producerNumber: b.producer_number,
    matrix: b.matrix,
    voided: Boolean(b.voided),
    printedAt: b.printed_at,
  };
}

// ---------- app ----------
const app = express();

// Printing (T-06). Mounted BEFORE express.json() on purpose: a creator print
// job carries the WHOLE document, and an image element is a base64 data URL,
// so /api/print/jobs brings its own 32 MB body parser (Server/print.js).
// Every other route still gets the default 100 kb limit on the line below —
// body-parser skips a request whose body is already read, so the two never
// fight. Non-print paths fall straight through this router untouched.
app.use(createPrintRouter({ port: PORT }));

app.use(express.json());

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

app.get('/api/state', (req, res) => {
  const supplierCode = getSetting('supplier_code', DEFAULT_SUPPLIER_CODE);
  const products = db
    .prepare('SELECT * FROM products ORDER BY name, producer_number')
    .all()
    .map((p) => ({
      id: p.id,
      producerNumber: p.producer_number,
      customerCode: p.customer_code,
      name: p.name,
    }));
  const lastSerials = {
    1: lastSerialForMachine(1),
    2: lastSerialForMachine(2),
  };
  const remaining = {};
  for (const m of [1, 2]) {
    const { lo, hi } = MACHINE_RANGES[m];
    remaining[m] = hi - (lastSerials[m] ?? lo - 1);
  }
  res.json({
    supplierCode,
    supplierCodeIsDefault: supplierCode === DEFAULT_SUPPLIER_CODE,
    products,
    lastSerials,
    remaining,
    // The grade letters and their meanings come from here so the label, the
    // Data Matrix and the picker in the UI cannot drift apart.
    nokGrades: NOK_GRADES,
  });
});

// ---------- spreadsheet import ----------
//
// Reads an .xlsx into the { columns, rows } shape the label editor's dataset
// speaks. It runs HERE rather than in the browser because ExcelJS is already
// installed on this side for /api/report.xlsx, and a second copy of it in the
// bundle would cost about a megabyte to do the same job. `.csv` never reaches
// this route - the browser parses that itself, which is what keeps CSV import
// working when this server is not running.
//
// The route brings its OWN body parser for the same reason the print router
// does: everything after `express.json()` above is capped at 100 kb, and a
// perfectly ordinary workbook is bigger than that.
const IMPORT_ROW_CAP = 5000;

app.post(
  '/api/import',
  express.raw({ type: '*/*', limit: '16mb' }),
  async (req, res) => {
    const name = String(req.query?.name ?? '').trim() || 'data.xlsx';
    if (/\.xls$/i.test(name)) {
      return fail(
        res,
        400,
        'The old .xls format cannot be read. Save the sheet as .xlsx or .csv.',
      );
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return fail(res, 400, 'No file was received.');
    }

    let sheet;
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.body);
      // Sheet 1. A multi-sheet workbook is a real thing and picking one for
      // the operator is a guess either way; the first is the one they were
      // looking at when they saved it.
      sheet = wb.worksheets[0];
    } catch {
      return fail(
        res,
        400,
        `${name} could not be read as an Excel workbook. Save it as .xlsx or .csv and try again.`,
      );
    }

    if (!sheet || sheet.rowCount < 2) {
      return fail(
        res,
        400,
        'No rows found. The first row has to be the column names, with at least one row under it.',
      );
    }

    const header = sheet.getRow(1);
    const width = Math.max(1, header.cellCount);
    const columns = [];
    for (let c = 1; c <= width; c += 1) {
      columns.push(cellText(header.getCell(c).value).trim());
    }
    // A blank trailing column is formatting, not data. Blanks in the MIDDLE
    // are kept, because dropping them would shift every column after them
    // onto the wrong header.
    while (columns.length && columns[columns.length - 1] === '') columns.pop();
    if (columns.length === 0) {
      return fail(res, 400, 'The first row is empty, so there are no columns.');
    }
    columns.forEach((value, i) => {
      if (!value) columns[i] = `Column ${i + 1}`;
    });

    const rows = [];
    for (let r = 2; r <= sheet.rowCount; r += 1) {
      const row = sheet.getRow(r);
      const out = {};
      let empty = true;
      columns.forEach((column, i) => {
        const text = cellText(row.getCell(i + 1).value).trim();
        if (text !== '') empty = false;
        out[column] = text;
      });
      // A spreadsheet is full of blank spacer rows and none of them is a
      // label. Printing one would waste stock and shift every serial after it.
      if (empty) continue;
      if (rows.length >= IMPORT_ROW_CAP) {
        return fail(
          res,
          400,
          `More than ${IMPORT_ROW_CAP} rows. Split the file and print it in parts.`,
        );
      }
      rows.push(out);
    }

    if (rows.length === 0) {
      return fail(res, 400, 'The sheet has column names but no data rows.');
    }

    res.json({ name, columns, rows });
  },
);

app.put('/api/settings', (req, res) => {
  const supplierCode = String(req.body?.supplierCode ?? '').trim();
  if (!supplierCode) {
    return fail(res, 400, 'Supplier code is required.');
  }
  setSetting('supplier_code', supplierCode);
  res.json({ ok: true, supplierCode });
});

app.post('/api/products', (req, res) => {
  const producerNumber = String(req.body?.producerNumber ?? '')
    .trim()
    .toUpperCase();
  const customerCode = String(req.body?.customerCode ?? '')
    .trim()
    .toUpperCase();
  const name = String(req.body?.name ?? '')
    .trim()
    .toUpperCase();

  if (!producerNumber || /\s/.test(producerNumber)) {
    return fail(res, 400, 'Producer number is required, without spaces.');
  }
  // Any code format is accepted; spaces are the only hard ban — the Data
  // Matrix content "/CODE/QTY/SN" must not contain whitespace per the customer's manual.
  if (!customerCode || /\s/.test(customerCode)) {
    return fail(res, 400, 'Customer code is required, without spaces.');
  }
  if (!name) {
    return fail(res, 400, 'Product name is required.');
  }

  const existing = db
    .prepare('SELECT * FROM products WHERE producer_number = ?')
    .get(producerNumber);
  if (existing) {
    db.prepare(
      'UPDATE products SET customer_code = ?, name = ? WHERE id = ?',
    ).run(customerCode, name, existing.id);
    return res.json({ product: productById(existing.id), updated: true });
  }
  const info = db
    .prepare(
      'INSERT INTO products (producer_number, customer_code, name) VALUES (?, ?, ?)',
    )
    .run(producerNumber, customerCode, name);
  res.json({
    product: productById(Number(info.lastInsertRowid)),
    updated: false,
  });
});

app.post('/api/batches', (req, res) => {
  const productId = Number(req.body?.productId);
  const orderNumber = String(req.body?.orderNumber ?? '').trim();
  const machine = Number(req.body?.machine);
  const quantity = Number(req.body?.quantity);
  const repeats = Number(req.body?.repeats);
  // Accepts "S00001" as well as 1 / "000001" - an older client that still sends
  // a plain number keeps working, because the parser stringifies first.
  const parsedStart = parseSerialInput(req.body?.startSerial);
  const manual = parsedStart && !parsedStart.error ? parsedStart : null;
  const startSerial = manual ? manual.serial : null;
  const serialPrefix = manual ? manual.prefix : '';
  const serialWidth = manual ? manual.width : AUTO_SN_WIDTH;

  const product = Number.isInteger(productId) ? productById(productId) : null;
  if (!product) return fail(res, 400, 'Select a product.');
  if (!orderNumber || /\s/.test(orderNumber)) {
    return fail(res, 400, 'Order number is required, without spaces.');
  }
  if (!MACHINE_RANGES[machine])
    return fail(res, 400, 'Machine must be 1 or 2.');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
    return fail(res, 400, 'Quantity must be between 1 and 500.');
  }
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) {
    return fail(res, 400, 'Repeats must be between 1 and 10.');
  }

  const supplierCode = getSetting('supplier_code', DEFAULT_SUPPLIER_CODE);
  const { lo, hi } = MACHINE_RANGES[machine];

  // Manual serials are free of the machine ranges — any SN the operator typed
  // works, in whatever shape they typed it.
  if (parsedStart?.error) return fail(res, 400, parsedStart.error);
  // Nothing to count up: "SPARE" carries no digits, so a second label would
  // have to be an exact duplicate of the first. That is a decision for the
  // operator, not a silent default.
  if (manual && manual.width === 0 && quantity > 1) {
    return fail(
      res,
      400,
      `Manual SN "${manual.prefix}" has no number to count up — it can only print 1 piece. Add digits (for example ${manual.prefix}01) to print ${quantity}.`,
    );
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const last = lastSerialForMachine(machine);
    const first = startSerial ?? (last ? last + 1 : lo);

    // The ceiling is the widest number that fits the digit run the operator
    // typed: 999999 for six digits, 99 for AB09's two.
    if (manual && manual.width > 0 && first + quantity - 1 > manual.max) {
      db.exec('ROLLBACK');
      return fail(
        res,
        409,
        `Serials would run past ${snOf(serialPrefix, serialWidth, manual.max)} (start ${snOf(serialPrefix, serialWidth, first)}, quantity ${quantity}). Reduce the quantity, or start from a wider number.`,
      );
    }
    if (startSerial === null && first + quantity - 1 > hi) {
      const left = hi - first + 1;
      db.exec('ROLLBACK');
      return fail(
        res,
        409,
        left > 0
          ? `Only ${left} serial number(s) left on machine ${machine} — requested ${quantity}. Reduce the quantity.`
          : `Serial range for machine ${machine} is completely used up (last: ${last}).`,
      );
    }
    // Manual serials may deliberately repeat already-printed ones (reprints of
    // damaged labels) — duplicates are allowed, so no clash check here.
    const info = db
      .prepare(
        `INSERT INTO batches (order_number, product_id, machine, quantity, repeats, supplier_code,
                              customer_code, product_name, producer_number,
                              serial_prefix, serial_width)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        orderNumber,
        productId,
        machine,
        quantity,
        repeats,
        supplierCode,
        product.customerCode,
        product.name,
        product.producerNumber,
        serialPrefix,
        serialWidth,
      );
    const batchId = Number(info.lastInsertRowid);

    const insertLabel = db.prepare(
      'INSERT INTO labels (batch_id, serial, matrix) VALUES (?, ?, ?)',
    );
    for (let i = 0; i < quantity; i++) {
      const serial = first + i;
      // The Data Matrix carries the SN exactly as it is printed above it. A
      // matrix that said 000001 under a label reading S00001 would be two
      // different serial numbers on one physical part.
      const matrix = okMatrixOf(
        product.customerCode,
        snOf(serialPrefix, serialWidth, serial),
      );
      if (/\s/.test(matrix))
        throw new Error(`Matrix contains whitespace: ${matrix}`);
      insertLabel.run(batchId, serial, matrix);
    }
    db.exec('COMMIT');
    res.json({ batch: batchPayload(batchId) });
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction was open to roll back. Swallow it so the original
      // failure below is what the caller sees.
    }
    fail(res, 500, `Failed to create batch: ${e.message}`);
  }
});

app.get('/api/batches', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  const rows = db
    .prepare(
      `SELECT b.id, b.order_number, b.machine, b.quantity, b.repeats, b.printed_at, b.voided,
              b.serial_prefix, b.serial_width,
              COALESCE(b.producer_number, p.producer_number) AS snap_producer,
              COALESCE(b.customer_code, p.customer_code) AS snap_code,
              COALESCE(b.product_name, p.name) AS snap_name,
              MIN(l.serial) AS serial_from, MAX(l.serial) AS serial_to
       FROM batches b
       JOIN products p ON p.id = b.product_id
       JOIN labels l ON l.batch_id = b.id
       GROUP BY b.id
       ORDER BY b.id DESC
       LIMIT ?`,
    )
    .all(limit);
  res.json({
    batches: rows.map((r) => ({
      id: r.id,
      orderNumber: r.order_number,
      machine: r.machine,
      quantity: r.quantity,
      repeats: r.repeats,
      printedAt: r.printed_at,
      voided: Boolean(r.voided),
      product: {
        producerNumber: r.snap_producer,
        customerCode: r.snap_code,
        name: r.snap_name,
      },
      serialFrom: r.serial_from,
      serialTo: r.serial_to,
      snFrom: snOf(
        r.serial_prefix ?? '',
        r.serial_width ?? AUTO_SN_WIDTH,
        r.serial_from,
      ),
      snTo: snOf(
        r.serial_prefix ?? '',
        r.serial_width ?? AUTO_SN_WIDTH,
        r.serial_to,
      ),
    })),
  });
});

app.get('/api/batches/:id', (req, res) => {
  const payload = batchPayload(Number(req.params.id));
  if (!payload) return fail(res, 404, 'Batch not found.');
  res.json({ batch: payload });
});

// Void = exclude from the Excel report (kept on its "Voided" sheet).
// Serials stay consumed forever — voiding never frees them for reuse.
app.post('/api/batches/:id/void', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM batches WHERE id = ?').get(id);
  if (!exists) return fail(res, 404, 'Batch not found.');
  db.prepare('UPDATE batches SET voided = ? WHERE id = ?').run(
    req.body?.voided ? 1 : 0,
    id,
  );
  res.json({ batch: batchPayload(id) });
});

// Permanent removal — unlike voiding, the batch disappears from history and
// every report sheet, and its serials become the automatic counter's again.
app.delete('/api/batches/:id', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM batches WHERE id = ?').get(id);
  if (!exists) return fail(res, 404, 'Batch not found.');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM labels WHERE batch_id = ?').run(id);
    db.prepare('DELETE FROM batches WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction was open to roll back. Swallow it so the original
      // failure below is what the caller sees.
    }
    return fail(res, 500, `Failed to delete batch: ${e.message}`);
  }
  res.json({ ok: true });
});

// ---------- NOK batches ----------
// The whole NOK path, kept apart from the OK routes above on purpose: nothing
// here reads or writes `labels`, so no NOK request can move a machine counter.

app.get('/api/nok-batches', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  const rows = db
    .prepare('SELECT * FROM nok_batches ORDER BY id DESC LIMIT ?')
    .all(limit);
  res.json({ batches: rows.map((r) => nokBatchPayload(r.id)) });
});

app.get('/api/nok-batches/:id', (req, res) => {
  const payload = nokBatchPayload(Number(req.params.id));
  if (!payload) return fail(res, 404, 'NOK batch not found.');
  res.json({ batch: payload });
});

app.post('/api/nok-batches', (req, res) => {
  const orderNumber = String(req.body?.orderNumber ?? '').trim();
  const grade = String(req.body?.grade ?? '')
    .trim()
    .toUpperCase();
  const productId =
    req.body?.productId == null || req.body.productId === ''
      ? null
      : Number(req.body.productId);
  // The 0 -> 9 rule lives HERE, on the server, and the tab merely pre-fills the
  // field with the same answer. A caller that sends a productId and no nokCode
  // — the print check does exactly that — gets the code derived rather than a
  // validation error, so there is one authority for what a NOK code is and it
  // is not the browser.
  const linked =
    productId !== null && Number.isInteger(productId)
      ? productById(productId)
      : null;
  const submittedCode = String(req.body?.nokCode ?? '')
    .trim()
    .toUpperCase();
  const nokCode =
    submittedCode ||
    (linked ? nokCodeOf(linked.customerCode).toUpperCase() : '');
  const submittedName = String(req.body?.productName ?? '')
    .trim()
    .toUpperCase();
  const productName =
    submittedName || (linked ? nokNameOf(linked.name).toUpperCase() : '');
  const submittedProducer = String(req.body?.producerNumber ?? '')
    .trim()
    .toUpperCase();
  const producerNumber =
    submittedProducer || (linked ? linked.producerNumber.toUpperCase() : '');
  const quantity = Number(req.body?.quantity);
  const repeats = Number(req.body?.repeats);

  if (!orderNumber || /\s/.test(orderNumber)) {
    return fail(res, 400, 'Order number is required, without spaces.');
  }
  if (!Object.prototype.hasOwnProperty.call(NOK_GRADES, grade)) {
    return fail(
      res,
      400,
      `Grade must be one of ${Object.keys(NOK_GRADES).join(', ')}.`,
    );
  }
  // Same rule as the OK code: any format is accepted, whitespace never is,
  // because the Data Matrix content must not contain a space per the customer's manual.
  if (!nokCode || /\s/.test(nokCode)) {
    return fail(res, 400, 'NOK code is required, without spaces.');
  }
  // A NOK code that does not start with 9 is almost certainly the OK code that
  // was never converted, and that prints a repaired-part code on a scrap part.
  // Refused rather than corrected: the field is editable, so the operator can
  // put in whatever the customer actually sent, but not by accident.
  if (!nokCode.startsWith('9')) {
    return fail(
      res,
      400,
      `NOK code must start with 9 — the customer code with its first digit changed from 0 to 9 (got "${nokCode}").`,
    );
  }
  if (!productName) {
    return fail(res, 400, 'Product name is required.');
  }
  if (!producerNumber || /\s/.test(producerNumber)) {
    return fail(res, 400, 'Producer number is required, without spaces.');
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
    return fail(res, 400, 'Quantity must be between 1 and 500.');
  }
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) {
    return fail(res, 400, 'Repeats must be between 1 and 10.');
  }

  const supplierCode = getSetting('supplier_code', DEFAULT_SUPPLIER_CODE);
  const matrix = nokMatrixOf(nokCode, grade);
  if (/\s/.test(matrix)) {
    return fail(res, 400, `Matrix contains whitespace: ${matrix}`);
  }

  const info = db
    .prepare(
      `INSERT INTO nok_batches (order_number, product_id, grade, quantity, repeats,
                                supplier_code, nok_code, product_name, producer_number, matrix)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      orderNumber,
      Number.isInteger(productId) ? productId : null,
      grade,
      quantity,
      repeats,
      supplierCode,
      nokCode,
      productName,
      producerNumber,
      matrix,
    );
  res.json({ batch: nokBatchPayload(Number(info.lastInsertRowid)) });
});

app.post('/api/nok-batches/:id/void', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM nok_batches WHERE id = ?').get(id);
  if (!exists) return fail(res, 404, 'NOK batch not found.');
  db.prepare('UPDATE nok_batches SET voided = ? WHERE id = ?').run(
    req.body?.voided ? 1 : 0,
    id,
  );
  res.json({ batch: nokBatchPayload(id) });
});

app.delete('/api/nok-batches/:id', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM nok_batches WHERE id = ?').get(id);
  if (!exists) return fail(res, 404, 'NOK batch not found.');
  db.prepare('DELETE FROM nok_batches WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/report.xlsx', async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    wb.created = new Date();

    const labelRows = db
      .prepare(
        `SELECT b.printed_at, b.order_number, b.machine,
                COALESCE(b.customer_code, p.customer_code) AS customer_code,
                COALESCE(b.product_name, p.name) AS name,
                COALESCE(b.producer_number, p.producer_number) AS producer_number,
                b.serial_prefix, b.serial_width, l.serial, l.matrix
         FROM labels l
         JOIN batches b ON b.id = l.batch_id
         JOIN products p ON p.id = b.product_id
         WHERE b.voided = 0
         ORDER BY l.serial`,
      )
      .all();

    const wsLabels = wb.addWorksheet('Labels');
    wsLabels.columns = [
      { header: 'Date', key: 'date', width: 18 },
      { header: 'Order', key: 'order', width: 14 },
      { header: 'Customer code', key: 'code', width: 18 },
      { header: 'Product name', key: 'name', width: 28 },
      { header: 'Producer number', key: 'producer', width: 18 },
      { header: 'Serial', key: 'serial', width: 10 },
      { header: 'Machine', key: 'machine', width: 9 },
      { header: 'Barcode content', key: 'matrix', width: 28 },
    ];
    labelRows.forEach((r) =>
      wsLabels.addRow({
        date: r.printed_at,
        order: r.order_number,
        code: r.customer_code,
        name: r.name,
        producer: r.producer_number,
        serial: snOf(
          r.serial_prefix ?? '',
          r.serial_width ?? AUTO_SN_WIDTH,
          r.serial,
        ),
        machine: r.machine,
        matrix: r.matrix,
      }),
    );
    wsLabels.getRow(1).font = { bold: true };
    wsLabels.autoFilter = 'A1:H1';

    const batchQuery = (voided) =>
      db
        .prepare(
          `SELECT b.printed_at, b.order_number, b.machine, b.quantity, b.repeats,
                  b.serial_prefix, b.serial_width,
                  COALESCE(b.customer_code, p.customer_code) AS customer_code,
                  COALESCE(b.product_name, p.name) AS name,
                  MIN(l.serial) AS serial_from, MAX(l.serial) AS serial_to
           FROM batches b
           JOIN products p ON p.id = b.product_id
           JOIN labels l ON l.batch_id = b.id
           WHERE b.voided = ?
           GROUP BY b.id
           ORDER BY b.id`,
        )
        .all(voided);
    const batchRows = batchQuery(0);

    const wsOrders = wb.addWorksheet('Orders');
    wsOrders.columns = [
      { header: 'Date', key: 'date', width: 18 },
      { header: 'Order', key: 'order', width: 14 },
      { header: 'Customer code', key: 'code', width: 18 },
      { header: 'Product name', key: 'name', width: 28 },
      { header: 'Pieces', key: 'qty', width: 9 },
      { header: 'Serial from', key: 'from', width: 12 },
      { header: 'Serial to', key: 'to', width: 12 },
      { header: 'Machine', key: 'machine', width: 9 },
    ];
    batchRows.forEach((r) =>
      wsOrders.addRow({
        date: r.printed_at,
        order: r.order_number,
        code: r.customer_code,
        name: r.name,
        qty: r.quantity,
        from: snOf(
          r.serial_prefix ?? '',
          r.serial_width ?? AUTO_SN_WIDTH,
          r.serial_from,
        ),
        to: snOf(
          r.serial_prefix ?? '',
          r.serial_width ?? AUTO_SN_WIDTH,
          r.serial_to,
        ),
        machine: r.machine,
      }),
    );
    wsOrders.getRow(1).font = { bold: true };
    wsOrders.autoFilter = 'A1:H1';

    // Voided batches: excluded from Labels/Orders but listed here so nothing
    // ever silently disappears from the record.
    const wsVoided = wb.addWorksheet('Voided');
    wsVoided.columns = [
      { header: 'Date', key: 'date', width: 18 },
      { header: 'Order', key: 'order', width: 14 },
      { header: 'Customer code', key: 'code', width: 18 },
      { header: 'Product name', key: 'name', width: 28 },
      { header: 'Pieces', key: 'qty', width: 9 },
      { header: 'Serial from', key: 'from', width: 12 },
      { header: 'Serial to', key: 'to', width: 12 },
      { header: 'Machine', key: 'machine', width: 9 },
    ];
    batchQuery(1).forEach((r) =>
      wsVoided.addRow({
        date: r.printed_at,
        order: r.order_number,
        code: r.customer_code,
        name: r.name,
        qty: r.quantity,
        from: snOf(
          r.serial_prefix ?? '',
          r.serial_width ?? AUTO_SN_WIDTH,
          r.serial_from,
        ),
        to: snOf(
          r.serial_prefix ?? '',
          r.serial_width ?? AUTO_SN_WIDTH,
          r.serial_to,
        ),
        machine: r.machine,
      }),
    );
    wsVoided.getRow(1).font = { bold: true };

    // NOK — parts that were not remanufactured. Its own sheet because it has no
    // serial number column at all and mixing it into Labels would put an empty
    // Serial beside real ones. Voided NOK runs stay HERE, flagged, rather than
    // moving to the Voided sheet above: that sheet is shaped around serial
    // ranges and machines, neither of which a NOK run has.
    const nokRows = db.prepare('SELECT * FROM nok_batches ORDER BY id').all();

    const wsNok = wb.addWorksheet('NOK');
    wsNok.columns = [
      { header: 'Date', key: 'date', width: 18 },
      { header: 'Order', key: 'order', width: 14 },
      { header: 'NOK code', key: 'code', width: 18 },
      { header: 'Grade', key: 'grade', width: 7 },
      { header: 'Grade serial number', key: 'gradeSerial', width: 24 },
      { header: 'Product name', key: 'name', width: 28 },
      { header: 'Producer number', key: 'producer', width: 18 },
      { header: 'Pieces', key: 'qty', width: 9 },
      { header: 'Labels printed', key: 'printed', width: 14 },
      { header: 'Barcode content', key: 'matrix', width: 40 },
      { header: 'Voided', key: 'voided', width: 9 },
    ];
    nokRows.forEach((r) =>
      wsNok.addRow({
        date: r.printed_at,
        order: r.order_number,
        code: r.nok_code,
        grade: r.grade,
        gradeSerial: `${r.nok_code}_${r.grade}`,
        name: r.product_name,
        producer: r.producer_number,
        qty: r.quantity,
        printed: r.quantity * r.repeats,
        matrix: r.matrix,
        voided: r.voided ? 'YES' : '',
      }),
    );
    wsNok.getRow(1).font = { bold: true };
    wsNok.autoFilter = 'A1:K1';

    // Build the whole file in memory first — a mid-stream failure can otherwise
    // leave headers half-sent and crash the process on the error response.
    const buffer = await wb.xlsx.writeBuffer();
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Label_Report_${stamp}.xlsx"`,
    );
    res.end(Buffer.from(buffer));
  } catch (e) {
    if (!res.headersSent) fail(res, 500, `Report failed: ${e.message}`);
    else res.destroy();
  }
});

// ---------- backup ----------
// VACUUM INTO produces a single consistent .db file even while the server runs —
// safe to copy anywhere. WAL mode means naively copying Label_Data.db is NOT a
// valid backup (recent data lives in the -wal file).
const backupDir = path.join(dataDir, 'Backups');

function makeBackup(prefix) {
  fs.mkdirSync(backupDir, { recursive: true });
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${String(now.getMilliseconds()).padStart(3, '0')}`;
  const file = path.join(backupDir, `${prefix}_${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

function pruneBackups(prefix, keep) {
  try {
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
      .sort();
    files.slice(0, Math.max(0, files.length - keep)).forEach((f) => {
      try {
        fs.unlinkSync(path.join(backupDir, f));
      } catch {
        // Backup file locked or already gone — pruning is best-effort.
      }
    });
  } catch {
    // Backups directory unreadable — pruning must never break startup.
  }
}

app.get('/api/backup', (req, res) => {
  try {
    const file = makeBackup('Manual');
    res.json({ ok: true, file });
  } catch (e) {
    fail(res, 500, `Backup failed: ${e.message}`);
  }
});

// ---------- static frontend ----------
const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get(/^\/(?!api\/).*/, (req, res) => {
  const indexFile = path.join(distDir, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  res
    .status(503)
    .send(
      'Frontend not built yet. Run "npm run build" in the project root, then reload.',
    );
});

// Safety net: one automatic backup per server start, keep the last 14.
try {
  makeBackup('Auto');
  pruneBackups('Auto', 14);
} catch (e) {
  console.warn(`Startup backup failed: ${e.message}`);
}

const server = app.listen(PORT, () => {
  console.log(`Label Studio server: http://localhost:${PORT}`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(
      `Label Studio is already running — use the browser at http://localhost:${PORT}/`,
    );
    console.log('This window can be closed.');
    process.exit(0);
  }
  throw e;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      db.close();
    } catch {
      // Already closed or mid-statement — we are exiting anyway.
    }
    process.exit(0);
  });
}
