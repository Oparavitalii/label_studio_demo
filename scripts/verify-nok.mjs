#!/usr/bin/env node
// Evidence for the NOK label (the customer's Logistics Supplier Manual, section 5).
//
// It does not read the source for intent. It starts the real server against a
// THROWAWAY database, posts a real NOK run, renders it through the real print
// pipeline into a real PDF, and then inspects the bytes that came out.
//
// Usage: node scripts/verify-nok.mjs
//
// What it asserts, as JSON to stdout:
//   1. the server derives the NOK code by the manual's rule — 001-002-000101R
//      becomes 901-002-000101R — and refuses a code that does not start with 9;
//   2. the Data Matrix content is /CODE/1/CODE_GRADE, exactly the manual's
//      /901-002-000101R/1/901-002-000101R_B shape, with no whitespace;
//   3. the rendered PDF has quantity x repeats pages, each 70 x 50 mm, and no
//      blank content stream;
//   4. the printed page carries the grade serial, the 9-code and the order
//      number, and carries NO "REMAN" — the word a NOK label exists to deny;
//   5. THE MACHINE SERIAL COUNTERS DO NOT MOVE. This is the one that matters:
//      a NOK part has no serial, and a NOK run that consumed one would burn a
//      number that is already promised to a remanufactured part.
// Exits non-zero if any assertion fails.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedDemo } from './demo_seed.mjs';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const EVIDENCE_DIR = path.join(PROJECT_ROOT, '.verify_out', 'NOK');

const PORT = 5187;
const BASE = `http://localhost:${PORT}`;
const PT_PER_MM = 72 / 25.4;
const MEDIA_BOX_TOLERANCE_PT = 2;

const failures = [];
function check(name, ok, detail) {
  if (!ok) failures.push({ name, detail });
  return { name, ok, detail };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitForServer(timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return true;
    } catch {
      // Not listening yet — the server is still opening its database.
    }
    await delay(200);
  }
  throw new Error(`Server did not come up on ${BASE} within ${timeoutMs} ms.`);
}

// Every Flate-compressed stream in the file, inflated.
function inflatedStreams(buffer) {
  const streams = [];
  let blankStreams = 0;
  let i = 0;
  for (;;) {
    const start = buffer.indexOf('stream', i);
    if (start === -1) break;
    let s = start + 'stream'.length;
    if (buffer[s] === 0x0d) s += 1;
    if (buffer[s] === 0x0a) s += 1;
    const end = buffer.indexOf('endstream', s);
    if (end === -1) break;
    const raw = buffer.subarray(s, end);
    if (raw.length === 0) blankStreams += 1;
    try {
      streams.push(zlib.inflateSync(raw).toString('latin1'));
    } catch {
      // Not a Flate stream (an image XObject, say). Nothing to read here.
    }
    i = end + 'endstream'.length;
  }
  return { streams, blankStreams };
}

// Chrome does NOT write readable strings into the page. It subsets the font and
// emits glyph ids — "INJ CR DELPHI" is written `<002C> Tj <0031> Tj <002D> Tj`
// and so on. Reading those as text requires the font's own ToUnicode CMap,
// which Chrome also embeds; without it an assertion about what is printed on
// the label would silently pass on an empty string, which is precisely the
// blank-label failure this check exists to catch.
function toUnicodeMap(streams) {
  const map = new Map();
  const hexToStr = (hex) =>
    (hex.match(/.{4}/g) || [])
      .map((h) => String.fromCharCode(parseInt(h, 16)))
      .join('');

  for (const s of streams) {
    for (const block of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(
        /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
      )) {
        map.set(parseInt(pair[1], 16), hexToStr(pair[2]));
      }
    }
    for (const block of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      // <lo> <hi> <dstStart>
      for (const r of block[1].matchAll(
        /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
      )) {
        const lo = parseInt(r[1], 16);
        const hi = parseInt(r[2], 16);
        const dst = parseInt(r[3], 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          map.set(c, String.fromCharCode(dst + (c - lo)));
        }
      }
      // <lo> <hi> [ <d1> <d2> ... ]
      for (const r of block[1].matchAll(
        /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g,
      )) {
        const lo = parseInt(r[1], 16);
        const items = [...r[3].matchAll(/<([0-9a-fA-F]+)>/g)];
        items.forEach((it, k) => map.set(lo + k, hexToStr(it[1])));
      }
    }
  }
  return map;
}

// The text actually drawn on the pages, decoded through that CMap.
function pdfText(buffer) {
  const { streams, blankStreams } = inflatedStreams(buffer);
  const cmap = toUnicodeMap(streams);
  const decodeHex = (hex) =>
    (hex.match(/.{4}/g) || [])
      .map((h) => {
        const code = parseInt(h, 16);
        return cmap.has(code) ? cmap.get(code) : '';
      })
      .join('');

  const out = [];
  for (const s of streams) {
    // Chrome emits one Tj per glyph with a Td between them, so a run of them is
    // one visual line. Join consecutive glyphs and break on ET (end of text).
    for (const textObj of s.matchAll(/BT([\s\S]*?)ET/g)) {
      let line = '';
      for (const t of textObj[1].matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) {
        line += decodeHex(t[1]);
      }
      // Literal-string form, in case a future Chrome stops subsetting.
      for (const t of textObj[1].matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
        line += t[1].replace(/\\([()\\])/g, '$1');
      }
      if (line) out.push(line);
    }
  }
  return { text: out.join('\n'), blankStreams, glyphsMapped: cmap.size };
}

function mediaBoxes(buffer) {
  const s = buffer.toString('latin1');
  return [
    ...s.matchAll(
      /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/g,
    ),
  ].map((m) => ({
    w: Number(m[3]) - Number(m[1]),
    h: Number(m[4]) - Number(m[2]),
  }));
}

let server = null;
let dataDir = null;

async function main() {
  // A THROWAWAY database. The live one holds the serial counter, and an
  // automated session has already deleted seven real batches out of it once —
  // see the comment on dataDir in Server/index.js. Never point this at Data/.
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'label-nok-'));

  server = spawn(
    process.execPath,
    [path.join(PROJECT_ROOT, 'Server', 'index.js')],
    {
      env: {
        ...process.env,
        LABEL_DATA_DIR: dataDir,
        LABEL_PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  await waitForServer();
  // The public copy seeds the throwaway database with the invented demo data.
  await seedDemo(BASE);

  const results = [];

  // ---- a catalogue product from the demo seed -------------------------------
  const before = await api('/api/state');
  const product =
    before.data.products.find((p) => p.customerCode === '001-002-000101R') ||
    before.data.products[0];
  if (!product) throw new Error('No products in the database to test with.');
  const serialsBefore = JSON.stringify(before.data.lastSerials);

  // ---- 1. the 0 -> 9 rule, derived server-side -----------------------------
  const created = await api('/api/nok-batches', {
    method: 'POST',
    body: {
      productId: product.id,
      orderNumber: 'T7',
      grade: 'A',
      quantity: 3,
      repeats: 2,
    },
  });
  const batch = created.data.batch;
  results.push(
    check(
      'nok code derives 0 -> 9 from the product',
      batch?.nokCode === `9${product.customerCode.slice(1)}`,
      `${product.customerCode} -> ${batch?.nokCode}`,
    ),
  );
  results.push(
    check(
      'product name drops REMAN',
      typeof batch?.productName === 'string' &&
        !/REMAN/i.test(batch.productName),
      `${product.name} -> ${batch?.productName}`,
    ),
  );

  // ---- 2. the Data Matrix content -----------------------------------------
  const expectedMatrix = `/${batch.nokCode}/1/${batch.nokCode}_A`;
  results.push(
    check(
      'matrix is /CODE/1/CODE_GRADE',
      batch.matrix === expectedMatrix,
      `${batch.matrix} (expected ${expectedMatrix})`,
    ),
  );
  results.push(
    check('matrix has no whitespace', !/\s/.test(batch.matrix), batch.matrix),
  );

  // A code that was never converted must be refused, not corrected: printing
  // the remanufactured part's code on a scrap part is the exact confusion the
  // manual's section 5 exists to prevent.
  const refused = await api('/api/nok-batches', {
    method: 'POST',
    body: {
      orderNumber: 'T7',
      grade: 'B',
      nokCode: product.customerCode,
      productName: 'INJ CR DELPHI',
      producerNumber: product.producerNumber,
      quantity: 1,
      repeats: 1,
    },
  });
  results.push(
    check(
      'an unconverted code (still starting with 0) is refused',
      refused.status === 400 &&
        /must start with 9/.test(refused.data.error || ''),
      `HTTP ${refused.status}: ${refused.data.error}`,
    ),
  );

  const badGrade = await api('/api/nok-batches', {
    method: 'POST',
    body: {
      productId: product.id,
      orderNumber: 'T7',
      grade: 'Z',
      quantity: 1,
      repeats: 1,
    },
  });
  results.push(
    check(
      'a grade outside A/B/C/N is refused',
      badGrade.status === 400,
      `HTTP ${badGrade.status}: ${badGrade.data.error}`,
    ),
  );

  // ---- 3 + 4. the real printed PDF ----------------------------------------
  const job = await api('/api/print/jobs', {
    method: 'POST',
    body: { kind: 'nok', nokBatchId: batch.id },
  });
  results.push(
    check(
      'the print server accepts a nok job',
      Boolean(job.data.jobId),
      JSON.stringify(job.data),
    ),
  );

  const printed = await api('/api/print', {
    method: 'POST',
    body: { jobId: job.data.jobId, printer: 'EVIDENCE_DRY_RUN', dryRun: true },
  });
  results.push(
    check(
      'the job renders',
      Boolean(printed.data.pdfPath),
      printed.data.error || JSON.stringify(printed.data).slice(0, 200),
    ),
  );

  await mkdir(EVIDENCE_DIR, { recursive: true });
  let pdfSummary = null;
  if (printed.data.pdfPath) {
    const buffer = await readFile(printed.data.pdfPath);
    await writeFile(path.join(EVIDENCE_DIR, 'nok_T7_gradeA_3x2.pdf'), buffer);

    const expectPages = batch.quantity * batch.repeats;
    results.push(
      check(
        'page count is quantity x repeats',
        printed.data.pages === expectPages,
        `${printed.data.pages} pages (expected ${expectPages})`,
      ),
    );

    const boxes = mediaBoxes(buffer);
    const wrong = boxes.filter(
      (b) =>
        Math.abs(b.w - 70 * PT_PER_MM) > MEDIA_BOX_TOLERANCE_PT ||
        Math.abs(b.h - 50 * PT_PER_MM) > MEDIA_BOX_TOLERANCE_PT,
    );
    results.push(
      check(
        'every page is 70 x 50 mm',
        boxes.length > 0 && wrong.length === 0,
        `${boxes.length} MediaBox entries, ${wrong.length} off-size: ${JSON.stringify(boxes[0])}`,
      ),
    );

    const { text, blankStreams, glyphsMapped } = pdfText(buffer);
    results.push(
      check(
        'no blank content stream',
        blankStreams === 0,
        `${blankStreams} empty streams`,
      ),
    );
    // Guard the guard: an extractor that returns nothing would make every
    // "is X printed?" assertion below pass by never finding anything to
    // contradict, which is exactly how a blank label ships.
    results.push(
      check(
        'text was extracted from the PDF at all',
        text.trim().length > 0 && glyphsMapped > 0,
        `${text.length} chars, ${glyphsMapped} glyphs mapped`,
      ),
    );
    results.push(
      check(
        'the grade serial is printed',
        text.includes(`${batch.nokCode}_A`),
        `looking for ${batch.nokCode}_A`,
      ),
    );
    results.push(
      check(
        'the 9-code is printed',
        text.includes(batch.nokCode),
        batch.nokCode,
      ),
    );
    results.push(
      check('the order number is printed', text.includes('T7'), 'T7'),
    );
    results.push(
      check(
        'the word REMAN is NOT printed',
        !/REMAN/i.test(text),
        'a NOK label must not claim the part was remanufactured',
      ),
    );
    pdfSummary = {
      pages: printed.data.pages,
      domPages: printed.data.domPages,
      mediaBoxMm: boxes[0]
        ? {
            w: +(boxes[0].w / PT_PER_MM).toFixed(2),
            h: +(boxes[0].h / PT_PER_MM).toFixed(2),
          }
        : null,
      textSample: text.split('\n').slice(0, 12),
    };
  }

  // ---- 5. the serial counters did not move --------------------------------
  const after = await api('/api/state');
  results.push(
    check(
      'machine serial counters unchanged by the NOK run',
      JSON.stringify(after.data.lastSerials) === serialsBefore,
      `before ${serialsBefore} / after ${JSON.stringify(after.data.lastSerials)}`,
    ),
  );
  const okBatches = await api('/api/batches?limit=200');
  results.push(
    check(
      'no OK batch was created',
      okBatches.data.batches.every((b) => b.orderNumber !== 'T7'),
      `${okBatches.data.batches.length} OK batches, none for order T7`,
    ),
  );

  // ---- the Excel report carries a NOK sheet --------------------------------
  const report = await fetch(`${BASE}/api/report.xlsx`);
  const xlsx = Buffer.from(await report.arrayBuffer());
  await writeFile(path.join(EVIDENCE_DIR, 'report_with_nok.xlsx'), xlsx);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx);
  const sheet = wb.getWorksheet('NOK');
  const row = sheet?.getRow(2);
  results.push(
    check(
      'report.xlsx has a NOK sheet with the run on it',
      Boolean(sheet) && row?.getCell(3).value === batch.nokCode,
      sheet
        ? `row 2: order ${row?.getCell(2).value}, code ${row?.getCell(3).value}, grade ${row?.getCell(4).value}, serial ${row?.getCell(5).value}`
        : `sheets: ${wb.worksheets.map((w) => w.name).join(', ')}`,
    ),
  );

  const summary = {
    ok: failures.length === 0,
    checks: results,
    failures,
    batch,
    pdf: pdfSummary,
    evidenceDir: EVIDENCE_DIR,
    throwawayDataDir: dataDir,
  };
  await writeFile(
    path.join(EVIDENCE_DIR, 'result.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    console.error(
      `\n${failures.length} check(s) FAILED.\n${serverLog.slice(-2000)}`,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(`verify-nok failed: ${e.stack || e.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) server.kill();
    if (dataDir)
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
