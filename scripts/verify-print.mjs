#!/usr/bin/env node
// Verifies F-01 (print.css + PrintSheet.jsx) by actually printing the app,
// not by reading its source for intent. It drives an already-running dev
// server through headless Chrome via the raw DevTools protocol (no
// puppeteer/playwright dependency - Chrome itself is already on this
// machine) and inspects the resulting PDF bytes.
//
// Usage: node scripts/verify-print.mjs [appUrl]
//   appUrl defaults to http://localhost:5311/creator
//
// Three scenarios are printed, each in its own fresh tab (so each starts
// from the store's real initial state):
//   1. no number element, default 60x20mm -> expect exactly 1 page.
//   2. a number element with a 1..5 range  -> expect exactly 5 pages.
//   3. two number elements 1..3 and 10..20 -> expect exactly 11 pages.
//   4. label size driven to the 100x50mm preset -> expect the physical
//      MediaBox to move to 100x50mm.
//
// From those three PDFs this asserts, as JSON to stdout:
//   1. printed page count equals the number of .label-page elements in
//      the document, for both the 1-page and 5-page cases.
//   2. the MediaBox equals the label size in points, at the 60x20mm
//      standard label AND after switching to the 100x50mm preset.
//   3. no blank pages: zero `/Length 0` content streams across all three
//      printed PDFs.
// Exits non-zero if any assertion fails.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const EVIDENCE_DIR = path.join(PROJECT_ROOT, '.verify_out', 'F-01');

// /labels still redirects here, but /creator is the real route the editor
// lives on - the gate should print the page it is actually testing.
const APP_URL = process.argv[2] || 'http://localhost:5311/creator';

const PT_PER_MM = 72 / 25.4;
// Small tolerance for Chrome's own internal mm->pt rounding, not a stand-in
// for a correctness check - see the MediaBox assertions below.
const MEDIA_BOX_TOLERANCE_PT = 2;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeTo(actual, expected, tolerance) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
}

// ---------------------------------------------------------------------------
// Chrome discovery + process lifecycle
// ---------------------------------------------------------------------------

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      'Could not locate a Chrome/Chromium executable. Set CHROME_PATH to its full path.',
    );
  }
  return found;
}

async function waitForDevToolsPort(userDataDir, timeoutMs = 15000) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const raw = await readFile(portFile, 'utf8');
      const port = Number(raw.split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await delay(100);
  }
  throw new Error('Chrome did not write a DevToolsActivePort file in time.');
}

async function waitForDevToolsHttp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // DevTools HTTP endpoint is not up yet; keep polling.
    }
    await delay(100);
  }
  throw new Error('Chrome DevTools HTTP endpoint did not respond in time.');
}

// `--remote-debugging-port=0` asks Chrome to pick its own free port and
// write it to `<user-data-dir>/DevToolsActivePort` - avoiding the race
// condition of picking a "free" port ourselves and hoping Chrome still
// wins it a moment later.
async function launchChrome() {
  const chromePath = resolveChromePath();
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), 'label-studio-print-check-'),
  );

  const proc = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const port = await waitForDevToolsPort(userDataDir);
  await waitForDevToolsHttp(port);

  return { proc, userDataDir, port };
}

async function killProcessTree(proc) {
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
    return;
  }
  proc.kill();
}

// ---------------------------------------------------------------------------
// Minimal Chrome DevTools Protocol client (native WebSocket + fetch only)
// ---------------------------------------------------------------------------

async function openTab(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
  });
  if (!res.ok) {
    throw new Error(`Failed to open a DevTools tab (HTTP ${res.status}).`);
  }
  return res.json();
}

async function closeTab(port, id) {
  await fetch(`http://127.0.0.1:${port}/json/close/${id}`, {
    method: 'PUT',
  }).catch(() => {});
}

class CdpClient {
  constructor(webSocketUrl) {
    this.ws = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
    this.ws.addEventListener('message', (event) => this.handleMessage(event));
  }

  static async connect(webSocketUrl) {
    const client = new CdpClient(webSocketUrl);
    await new Promise((resolve, reject) => {
      client.ws.addEventListener('open', () => resolve(), { once: true });
      client.ws.addEventListener(
        'error',
        () => reject(new Error('CDP WebSocket connection failed.')),
        { once: true },
      );
    });
    return client;
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      const listeners = this.eventListeners.get(message.method);
      if (listeners) {
        for (const listener of [...listeners]) listener(message.params);
      }
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Resolves the next time `method` fires, then stops listening.
  once(method) {
    return new Promise((resolve) => {
      const listener = (params) => {
        const remaining = (this.eventListeners.get(method) ?? []).filter(
          (candidate) => candidate !== listener,
        );
        this.eventListeners.set(method, remaining);
        resolve(params);
      };
      this.eventListeners.set(method, [
        ...(this.eventListeners.get(method) ?? []),
        listener,
      ]);
    });
  }

  close() {
    this.ws.close();
  }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    // Adding a number element and then editing its range needs two React
    // renders, so the drive script resolves a promise rather than returning
    // synchronously. Without this the page count is read before the element
    // exists and the 5-page assertion fails for the wrong reason.
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const detail =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text;
    throw new Error(`Runtime.evaluate failed: ${detail}`);
  }
  return result.result.value;
}

async function waitForCondition(
  client,
  expression,
  { timeoutMs = 4000, intervalMs = 50 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(client, expression);
    if (last) return last;
    await delay(intervalMs);
  }
  throw new Error(
    `Timed out waiting for: ${expression} (last value: ${JSON.stringify(last)})`,
  );
}

async function navigateAndWaitForLoad(client, url) {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  const loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url });
  await loaded;
  // The load event fires on the empty index.html shell; give React a beat
  // to mount PrintSheet's portal before anything queries it.
  await waitForCondition(
    client,
    `document.querySelector('.print-root') !== null`,
  );
}

async function printToPdf(client) {
  const result = await client.send('Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true,
    marginTop: 0,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
  });
  return Buffer.from(result.data, 'base64');
}

async function withTab(port, run) {
  const tab = await openTab(port);
  const client = await CdpClient.connect(tab.webSocketDebuggerUrl);
  try {
    return await run(client);
  } finally {
    client.close();
    await closeTab(port, tab.id);
  }
}

// ---------------------------------------------------------------------------
// PDF inspection (raw text scan, per the project's own print-testing recipe)
// ---------------------------------------------------------------------------

function parsePdf(buffer) {
  const text = buffer.toString('latin1');

  const countMatches = [...text.matchAll(/\/Count\s+(\d+)/g)];
  const pageCount = countMatches.length
    ? Number(countMatches[countMatches.length - 1][1])
    : null;

  const mediaBoxMatch = text.match(
    /\/MediaBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/,
  );
  const mediaBox = mediaBoxMatch
    ? {
        widthPt: Number(mediaBoxMatch[3]) - Number(mediaBoxMatch[1]),
        heightPt: Number(mediaBoxMatch[4]) - Number(mediaBoxMatch[2]),
      }
    : null;

  const blankStreamCount = (text.match(/\/Length\s+0(?!\d)/g) || []).length;

  return { pageCount, mediaBox, blankStreamCount };
}

// ---------------------------------------------------------------------------
// DOM drivers - real user-shaped interactions against the running app,
// dispatched through native property setters so React's controlled inputs
// pick them up exactly as a real click/keystroke would.
// ---------------------------------------------------------------------------

const FIELD_HELPERS = `
  function __nativeSetter(prototypeName, propertyName) {
    return Object.getOwnPropertyDescriptor(
      window[prototypeName].prototype,
      propertyName,
    ).set;
  }
  function __findFieldControl(labelText) {
    const label = Array.from(document.querySelectorAll('label')).find(
      (candidate) => {
        const span = candidate.querySelector('span');
        return span && span.textContent.trim() === labelText;
      },
    );
    if (!label) throw new Error('Field not found: ' + labelText);
    return label.querySelector('input, select');
  }
  function __findButtonByText(text) {
    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent.trim() === text,
    );
    if (!button) throw new Error('Button not found: ' + text);
    return button;
  }
  // The add-element controls are palette TILES in the left rail now, not
  // "+ Text"/"+ Number" toolbar buttons. Keying off data-el-type means the
  // wording under an icon can change without breaking the print gate; the
  // old text lookup stays as a fallback so this still drives a build from
  // before the palette landed.
  function __findAddButton(type) {
    const tile = document.querySelector('[data-el-type="' + type + '"]');
    if (tile) return tile;
    const legacy = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === '+ ' + type[0].toUpperCase() + type.slice(1),
    );
    if (!legacy) throw new Error('Add button not found: ' + type);
    return legacy;
  }
`;

// Adds one real Text element (the palette's Text tile) so every printed
// label carries actual visible content. Without this, a fresh document has
// zero elements and every label-page is a genuinely empty box - its content
// stream legitimately has zero drawing operations, which would make the
// "no blank pages" assertion meaningless (it could not tell an empty-by-
// design page apart from an extra blank page pushed by leftover chrome).
const DRIVE_ADD_TEXT_ELEMENT = `
(function () {
  ${FIELD_HELPERS}
  __findAddButton('text').click();
  return true;
})();
`;

// Counting now lives on a `number` ELEMENT, not on a document-level panel -
// there is no "Enable counter" checkbox to tick any more. Adding a number
// element IS enabling counting, and its range lives in the Properties panel
// while it is selected, which it is immediately after being added.
const DRIVE_COUNTER_TO_FIVE = `
(function () {
  ${FIELD_HELPERS}
  const addNumber = __findAddButton('number');
  addNumber.click();

  return new Promise((resolve) => {
    setTimeout(() => {
      const endInput = __findFieldControl('End');
      __nativeSetter('HTMLInputElement', 'value').call(endInput, '5');
      endInput.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => resolve(true), 150);
    }, 250);
  });
})();
`;

const DRIVE_TWO_NUMBERS = `
(function () {
  ${FIELD_HELPERS}
  const addNumber = __findAddButton('number');

  const setField = (labelText, value) => {
    const input = __findFieldControl(labelText);
    __nativeSetter('HTMLInputElement', 'value').call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  return new Promise((resolve) => {
    addNumber.click();
    setTimeout(() => {
      setField('End', 3);
      setTimeout(() => {
        addNumber.click();
        setTimeout(() => {
          setField('Start', 10);
          setField('End', 20);
          setTimeout(() => resolve(true), 250);
        }, 300);
      }, 250);
    }, 300);
  });
})();
`;

// R-03. A number element whose range reaches three digits. The bug this
// scenario exists for printed "10" as a 1 with a 0 underneath it, because the
// box was measured against the FIRST value of the range and never again.
const DRIVE_NUMBER_TO_100 = `
(function () {
  ${FIELD_HELPERS}
  __findAddButton('number').click();

  return new Promise((resolve) => {
    setTimeout(() => {
      const endInput = __findFieldControl('End');
      __nativeSetter('HTMLInputElement', 'value').call(endInput, '100');
      endInput.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => resolve(true), 300);
    }, 300);
  });
})();
`;

const DRIVE_PRESET_TO_100X50 = `
(function () {
  ${FIELD_HELPERS}
  const presetSelect = __findFieldControl('Preset');
  __nativeSetter('HTMLSelectElement', 'value').call(presetSelect, '100x50');
  presetSelect.dispatchEvent(new Event('change', { bubbles: true }));

  return true;
})();
`;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// Every scenario waits for a real Text element to actually render inside
// the print root before printing - see DRIVE_ADD_TEXT_ELEMENT above.
async function waitForTextElementRendered(client) {
  await waitForCondition(
    client,
    `(document.querySelector('.print-root .label-page')?.textContent || '').includes('Text')`,
  );
}

async function scenarioCounterOff(port) {
  return withTab(port, async (client) => {
    await navigateAndWaitForLoad(client, APP_URL);
    await evaluate(client, DRIVE_ADD_TEXT_ELEMENT);
    await waitForTextElementRendered(client);
    const labelPageCount = await evaluate(
      client,
      `document.querySelectorAll('.print-root .label-page').length`,
    );
    const pdfBuffer = await printToPdf(client);
    return { labelPageCount, pdfBuffer };
  });
}

async function scenarioFiveValueCounter(port) {
  return withTab(port, async (client) => {
    await navigateAndWaitForLoad(client, APP_URL);
    await evaluate(client, DRIVE_ADD_TEXT_ELEMENT);
    await waitForTextElementRendered(client);
    await evaluate(client, DRIVE_COUNTER_TO_FIVE);
    await waitForCondition(
      client,
      `document.querySelectorAll('.print-root .label-page').length === 5`,
    );
    const labelPageCount = await evaluate(
      client,
      `document.querySelectorAll('.print-root .label-page').length`,
    );
    const pdfBuffer = await printToPdf(client);
    return { labelPageCount, pdfBuffer };
  });
}

async function scenarioTwoNumbers(port) {
  return withTab(port, async (client) => {
    await navigateAndWaitForLoad(client, APP_URL);
    await evaluate(client, DRIVE_TWO_NUMBERS);
    await waitForCondition(
      client,
      `document.querySelectorAll('.print-root .label-page').length === 11`,
    );
    const labelPageCount = await evaluate(
      client,
      `document.querySelectorAll('.print-root .label-page').length`,
    );
    // The LAST page must show the short element holding its final value (3)
    // beside the long one at its end (20). Page count alone cannot tell an
    // inverted clamp from a correct one.
    const lastPageText = await evaluate(
      client,
      `(() => {
        const page = [...document.querySelectorAll('.print-root .label-page')].pop();
        if (!page) return [];
        return [...page.children].map((c) => c.textContent.trim()).filter(Boolean);
      })()`,
    );
    const pdfBuffer = await printToPdf(client);
    return { labelPageCount, lastPageText, pdfBuffer };
  });
}

async function scenarioResizedLabel(port) {
  return withTab(port, async (client) => {
    await navigateAndWaitForLoad(client, APP_URL);
    await evaluate(client, DRIVE_ADD_TEXT_ELEMENT);
    await waitForTextElementRendered(client);
    await evaluate(client, DRIVE_PRESET_TO_100X50);
    await waitForCondition(
      client,
      `document.querySelector('.print-root .label-page').style.width === '100mm'`,
    );
    const labelPageCount = await evaluate(
      client,
      `document.querySelectorAll('.print-root .label-page').length`,
    );
    const pdfBuffer = await printToPdf(client);
    return { labelPageCount, pdfBuffer };
  });
}

// R-03, on paper rather than in a unit test.
//
// The measurement runs under EMULATED PRINT MEDIA. `.print-root` is
// display:none on screen, and getClientRects() inside a display:none subtree
// returns nothing at all - so measuring the on-screen DOM would report "no
// line boxes" whether the number wrapped or not. Emulating print media makes
// the print tree the visible layout, which is the layout that reaches the
// Zebra.
async function scenarioWideNumber(port) {
  return withTab(port, async (client) => {
    await navigateAndWaitForLoad(client, APP_URL);
    await evaluate(client, DRIVE_ADD_TEXT_ELEMENT);
    await waitForTextElementRendered(client);
    await evaluate(client, DRIVE_NUMBER_TO_100);
    await waitForCondition(
      client,
      `document.querySelectorAll('.print-root .label-page').length === 100`,
    );

    await client.send('Emulation.setEmulatedMedia', { media: 'print' });
    const lastValue = await evaluate(
      client,
      `(function () {
        const page = [...document.querySelectorAll('.print-root .label-page')].pop();
        const nodes = [...page.querySelectorAll('*')].filter(
          (n) =>
            n.childNodes.length === 1 &&
            n.firstChild.nodeType === 3 &&
            n.textContent.trim() === '100',
        );
        if (!nodes.length) return { found: false };
        const node = nodes[nodes.length - 1];
        const range = document.createRange();
        range.selectNodeContents(node);
        const style = getComputedStyle(node);
        return {
          found: true,
          text: node.textContent,
          lineBoxes: range.getClientRects().length,
          whiteSpace: style.whiteSpace,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        };
      })()`,
    );
    await client.send('Emulation.setEmulatedMedia', { media: '' });

    const labelPageCount = await evaluate(
      client,
      `document.querySelectorAll('.print-root .label-page').length`,
    );
    const pdfBuffer = await printToPdf(client);
    return { labelPageCount, lastValue, pdfBuffer };
  });
}

// R-04 to R-07. The imported spreadsheet, printed through the SERVER path -
// a job posted to /api/print/jobs and rendered at /print/:jobId, which is the
// route the headless Chrome that drives the real printer uses. Nothing about
// the editor is involved, which is the point: this proves the data survives
// the trip to the server and back.
async function scenarioDataRows(port) {
  const origin = new URL(APP_URL).origin;
  const dataset = {
    name: 'orders.csv',
    columns: ['Code', 'Name'],
    rows: [
      { Code: 'A-1', Name: 'Filtr' },
      { Code: 'A-2', Name: 'Pompa wodna' },
      { Code: 'A-3', Name: 'Alternator kompletny' },
    ],
  };
  const job = {
    kind: 'creator',
    label: { w: 60, h: 20 },
    elements: [
      {
        id: 'data-1',
        type: 'text',
        content: '{Code}',
        xMm: 2,
        yMm: 2,
        wMm: 40,
        hMm: 8,
        z: 0,
        rot: 0,
        fontFamily: 'Inter',
        fontCapMm: 3,
        align: 'left',
        fill: '#000000',
      },
    ],
    dataset,
  };

  const res = await fetch(`${origin}/api/print/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  });
  const { jobId, error } = await res.json();
  if (!jobId) throw new Error(`print job was refused: ${error || res.status}`);

  return withTab(port, async (client) => {
    await navigateAndWaitForLoad(client, `${origin}/print/${jobId}`);
    // The render target sets this attribute when it is genuinely finished -
    // the same marker the print server waits for.
    await waitForCondition(
      client,
      `document.documentElement.getAttribute('data-print-ready') === 'true'`,
    );
    const labelPageCount = await evaluate(
      client,
      `document.querySelectorAll('.print-root .label-page').length`,
    );
    const pageTexts = await evaluate(
      client,
      `[...document.querySelectorAll('.print-root .label-page')].map((p) => p.textContent.trim())`,
    );
    const pdfBuffer = await printToPdf(client);
    return { labelPageCount, pageTexts, pdfBuffer };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });

  const { proc, userDataDir, port } = await launchChrome();

  try {
    const single = await scenarioCounterOff(port);
    const five = await scenarioFiveValueCounter(port);
    const two = await scenarioTwoNumbers(port);
    const resized = await scenarioResizedLabel(port);
    const wide = await scenarioWideNumber(port);
    const data = await scenarioDataRows(port);

    await writeFile(
      path.join(EVIDENCE_DIR, 'single_label.pdf'),
      single.pdfBuffer,
    );
    await writeFile(path.join(EVIDENCE_DIR, 'five_labels.pdf'), five.pdfBuffer);
    await writeFile(path.join(EVIDENCE_DIR, 'two_numbers.pdf'), two.pdfBuffer);
    await writeFile(
      path.join(EVIDENCE_DIR, 'number_1_to_100.pdf'),
      wide.pdfBuffer,
    );
    await writeFile(path.join(EVIDENCE_DIR, 'data_rows.pdf'), data.pdfBuffer);
    await writeFile(
      path.join(EVIDENCE_DIR, 'resized_100x50.pdf'),
      resized.pdfBuffer,
    );

    const wideInfo = parsePdf(wide.pdfBuffer);
    const dataInfo = parsePdf(data.pdfBuffer);
    const singleInfo = parsePdf(single.pdfBuffer);
    const fiveInfo = parsePdf(five.pdfBuffer);
    const twoInfo = parsePdf(two.pdfBuffer);
    const resizedInfo = parsePdf(resized.pdfBuffer);

    // The standard label became 60 x 20 mm in run 5 (R-02). This gate is
    // what proves the change reached the PHYSICAL page and not just the
    // preset list.
    const expected60mmPt = 60 * PT_PER_MM;
    const expected20mmPt = 20 * PT_PER_MM;
    const expected100mmPt = 100 * PT_PER_MM;
    const expected50mmPt = 50 * PT_PER_MM;

    const assertions = [
      {
        name: 'counter OFF prints exactly one page, matching the one .label-page element in the document',
        pass:
          single.labelPageCount === 1 &&
          singleInfo.pageCount === single.labelPageCount &&
          singleInfo.pageCount === 1,
        detail: {
          labelPageElementCount: single.labelPageCount,
          printedPageCount: singleInfo.pageCount,
        },
      },
      {
        name: 'a 5-value counter prints exactly five pages, matching the five .label-page elements in the document',
        pass:
          five.labelPageCount === 5 &&
          fiveInfo.pageCount === five.labelPageCount &&
          fiveInfo.pageCount === 5,
        detail: {
          labelPageElementCount: five.labelPageCount,
          printedPageCount: fiveInfo.pageCount,
        },
      },
      {
        name: 'two number elements (1..3 and 10..20) print eleven pages - the LONGEST range wins - and the last page still shows the short element holding its final value',
        pass:
          two.labelPageCount === 11 &&
          twoInfo.pageCount === 11 &&
          Array.isArray(two.lastPageText) &&
          two.lastPageText.includes('3') &&
          two.lastPageText.includes('20'),
        detail: {
          labelPageElementCount: two.labelPageCount,
          printedPageCount: twoInfo.pageCount,
          lastPageElementTexts: two.lastPageText,
          note: 'page count alone cannot distinguish a correct clamp from an inverted one - the last page text is what makes this assertion able to fail',
        },
      },
      {
        name: 'the standard 60x20mm label prints with a MediaBox matching 60x20mm in points',
        pass:
          singleInfo.mediaBox !== null &&
          closeTo(
            singleInfo.mediaBox.widthPt,
            expected60mmPt,
            MEDIA_BOX_TOLERANCE_PT,
          ) &&
          closeTo(
            singleInfo.mediaBox.heightPt,
            expected20mmPt,
            MEDIA_BOX_TOLERANCE_PT,
          ),
        detail: {
          mediaBoxPt: singleInfo.mediaBox,
          expectedWidthPt: expected60mmPt,
          expectedHeightPt: expected20mmPt,
          toleranceMediaBoxPt: MEDIA_BOX_TOLERANCE_PT,
        },
      },
      {
        name: 'switching to the 100x50mm preset moves the physical MediaBox to 100x50mm in points',
        pass:
          resizedInfo.mediaBox !== null &&
          closeTo(
            resizedInfo.mediaBox.widthPt,
            expected100mmPt,
            MEDIA_BOX_TOLERANCE_PT,
          ) &&
          closeTo(
            resizedInfo.mediaBox.heightPt,
            expected50mmPt,
            MEDIA_BOX_TOLERANCE_PT,
          ),
        detail: {
          mediaBoxPt: resizedInfo.mediaBox,
          expectedWidthPt: expected100mmPt,
          expectedHeightPt: expected50mmPt,
          toleranceMediaBoxPt: MEDIA_BOX_TOLERANCE_PT,
        },
      },
      {
        name: 'a 1..100 number prints 100 pages and its last value sits on ONE line - the "1 above 0" fault',
        pass:
          wide.labelPageCount === 100 &&
          wideInfo.pageCount === 100 &&
          wide.lastValue?.found === true &&
          wide.lastValue.text === '100' &&
          wide.lastValue.lineBoxes === 1 &&
          wide.lastValue.whiteSpace === 'pre' &&
          wide.lastValue.scrollWidth <= wide.lastValue.clientWidth,
        detail: {
          labelPageElementCount: wide.labelPageCount,
          printedPageCount: wideInfo.pageCount,
          lastValue: wide.lastValue,
          note: 'measured under emulated print media, because .print-root is display:none on screen and getClientRects() would report nothing at all there. lineBoxes === 1 is the wrap; scrollWidth <= clientWidth is the clip that a no-wrap rule alone would have caused instead',
        },
      },
      {
        name: 'a 3-row imported file prints 3 pages, one per row, with each row own value - through the SERVER job route',
        pass:
          data.labelPageCount === 3 &&
          dataInfo.pageCount === 3 &&
          Array.isArray(data.pageTexts) &&
          data.pageTexts.join('|') === 'A-1|A-2|A-3',
        detail: {
          labelPageElementCount: data.labelPageCount,
          printedPageCount: dataInfo.pageCount,
          pageTexts: data.pageTexts,
          note: 'posted to /api/print/jobs and rendered at /print/:jobId - the route the real printer path uses, so this also proves the dataset survives the trip to the server',
        },
      },
      {
        name: 'no blank pages: zero /Length 0 content streams across all four printed PDFs',
        pass:
          singleInfo.blankStreamCount === 0 &&
          fiveInfo.blankStreamCount === 0 &&
          twoInfo.blankStreamCount === 0 &&
          resizedInfo.blankStreamCount === 0,
        detail: {
          singleLabelBlankStreamCount: singleInfo.blankStreamCount,
          fiveLabelBlankStreamCount: fiveInfo.blankStreamCount,
          twoNumbersBlankStreamCount: twoInfo.blankStreamCount,
          resizedLabelBlankStreamCount: resizedInfo.blankStreamCount,
        },
      },
    ];

    const ok = assertions.every((assertion) => assertion.pass);

    const summary = {
      ok,
      appUrl: APP_URL,
      pdfs: {
        singleLabel: path.relative(
          PROJECT_ROOT,
          path.join(EVIDENCE_DIR, 'single_label.pdf'),
        ),
        fiveLabels: path.relative(
          PROJECT_ROOT,
          path.join(EVIDENCE_DIR, 'five_labels.pdf'),
        ),
        resized100x50: path.relative(
          PROJECT_ROOT,
          path.join(EVIDENCE_DIR, 'resized_100x50.pdf'),
        ),
      },
      assertions,
    };

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    await killProcessTree(proc);
    // Windows can hold the profile directory's file handles open for a
    // moment after the process tree is killed; a short wait plus one retry
    // keeps this from leaving an orphaned temp dir behind on every run.
    await delay(300);
    await rm(userDataDir, { recursive: true, force: true }).catch(async () => {
      await delay(500);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    });
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message || String(err)}\n`);
  process.exitCode = 1;
});
