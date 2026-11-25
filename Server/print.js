// Label Studio — the printing subsystem (T-06).
//
// WHY THIS EXISTS AT ALL
// A browser cannot choose a printer from JavaScript. window.print() opens
// the OS dialog and the operator picks the destination by hand, every time,
// for every run. The owner asked for a real print panel — pick the printer,
// set the copies, press Print — so the choice has to be made somewhere that
// can actually talk to the Windows spooler. That is this file.
//
// THE SHAPE OF THE PROBLEM
// The document the operator is looking at lives in the browser: a zustand
// store in the Creator, a batch row in Production. The server renders the
// PDF with a FRESH headless Chrome, which has none of that. So the document
// travels to the server first:
//
//   POST /api/print/jobs   -> the payload is parked in memory, returns a jobId
//   GET  /api/print/jobs/:id -> the headless render reads it back
//   POST /api/print        -> headless Chrome opens /print/<jobId>, prints it
//                             to PDF, and the PDF is handed to the spooler
//
// Jobs are transient RENDER PAYLOADS, not records. They live in a Map with a
// cap and a TTL and are NEVER written to the SQLite database — the database
// is the print log, and a job that was rendered but never physically printed
// would be a lie in that log.
//
// WHY NOT ZPL
// The owner explicitly declined generating native ZPL. The Zebra is driven
// through its Windows driver like any other printer, so exactly one render
// path serves every destination and the label that comes out of the Zebra is
// the same artwork that comes out of a PDF.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// A job is a render payload with a few minutes of useful life, not a record.
// The cap is what stops a page that submits on every keystroke from turning
// the server into a memory leak; the TTL is what stops a forgotten job from
// pinning a whole creator document (elements can carry image data URLs).
const JOB_TTL_MS = 15 * 60 * 1000;
const JOB_CAP = 64;

// Every wait has a ceiling. A broken job — a stale dist without the /print
// route, an unencodable Data Matrix, a document that never finishes painting
// — must fail with a readable message, never hang the request.
const CHROME_START_TIMEOUT_MS = 20000;
const PAGE_LOAD_TIMEOUT_MS = 20000;
const PRINT_READY_TIMEOUT_MS = 25000;
const POWERSHELL_TIMEOUT_MS = 20000;
const SUBMIT_TIMEOUT_MS = 60000;

// Rendered PDFs are kept on disk so a submitted job can be re-sent by hand
// and so a dryRun leaves real evidence. They are pruned by age, never by the
// request that made them — deleting a PDF while the shell verb is still
// handing it to Acrobat is how a print job silently becomes a blank page.
const PDF_DIR = path.join(os.tmpdir(), 'label-studio-print');
const PDF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const COPIES_MAX = 100;

// DEMO MODE (public copy). With DEMO_MODE=1 the server offers ONE virtual
// printer instead of asking PowerShell for the Windows printer list, and a job
// sent to it stops after the real headless-Chrome render: the PDF is served
// back to the browser instead of being handed to a spooler. Everything up to
// that point - job store, validation, the /print render target, the PDF page
// count - is the production path, so the demo shows exactly what a Zebra would
// have received.
const DEMO_MODE = process.env.DEMO_MODE === '1';
const DEMO_PRINTER = {
  name: 'Demo PDF printer (no hardware)',
  port: 'DEMO:',
  status: 'Normal',
  isDefault: true,
};
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampCopies(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, COPIES_MAX);
}

// PowerShell double-quoted strings interpolate `$` and treat a backtick as
// the escape character. Printer names and temp paths are attacker-adjacent
// only in theory, but a name containing `$` would silently become a
// different string, and a silently different printer is a wrong label.
function psQuote(value) {
  return `"${String(value).replace(/[`"$]/g, (char) => `\`${char}`)}"`;
}

function ensurePdfDir() {
  mkdirSync(PDF_DIR, { recursive: true });
}

function prunePdfs() {
  try {
    const now = Date.now();
    for (const name of readdirSync(PDF_DIR)) {
      if (!name.endsWith('.pdf')) continue;
      const file = path.join(PDF_DIR, name);
      try {
        if (now - statSync(file).mtimeMs > PDF_MAX_AGE_MS) unlinkSync(file);
      } catch {
        // The file is locked by a reader or already gone. Pruning is
        // best-effort by design and must never fail a print.
      }
    }
  } catch {
    // The temp directory is unreadable. Nothing here is load-bearing.
  }
}

// Chrome writes the PDF page tree as one or more `/Count n` entries; the last
// one is the root. Same recipe scripts/verify-print.mjs already uses to prove
// the print pipeline — one parser for the whole project, not two.
function pdfPageCount(buffer) {
  const text = buffer.toString('latin1');
  const matches = [...text.matchAll(/\/Count\s+(\d+)/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

// ---------------------------------------------------------------------------
// The job store
// ---------------------------------------------------------------------------

const jobs = new Map();

function pruneJobs() {
  const now = Date.now();
  for (const [id, entry] of jobs) {
    if (now - entry.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
  // Map iterates in insertion order, so the first key is always the oldest.
  while (jobs.size > JOB_CAP) {
    const oldest = jobs.keys().next().value;
    if (oldest === undefined) break;
    jobs.delete(oldest);
  }
}

// The imported spreadsheet, validated at the door like everything else on a
// job. It is re-checked here rather than trusted from the browser because
// this route is also reachable by anything that can POST, and a `rows` that
// is not an array of objects would fail inside the headless Chrome, where it
// looks like a render bug rather than a bad request.
//
// Deliberately NOT shared with src/labels/model/dataset.js: the shipped
// package is dist/ + Server/ with no src/ in it (see the project README), so
// a server that imported the model would not start on the operator's machine.
// The two are kept in step by the dataset tests on both sides.
const DATASET_ROW_CAP = 5000;

function normaliseDataset(input) {
  if (!input) return { dataset: null };

  const columns = Array.isArray(input.columns)
    ? input.columns.map((c) => String(c ?? '')).filter((c) => c.trim() !== '')
    : [];
  const rows = Array.isArray(input.rows) ? input.rows : [];

  if (columns.length === 0 || rows.length === 0) {
    return { error: 'A dataset needs a columns array and at least one row.' };
  }
  if (rows.length > DATASET_ROW_CAP) {
    return {
      error: `A dataset is capped at ${DATASET_ROW_CAP} rows; this one has ${rows.length}.`,
    };
  }

  const clean = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return {
        error: 'Every dataset row has to be an object of column values.',
      };
    }
    const out = {};
    for (const column of columns) {
      const value = row[column];
      out[column] = value === undefined || value === null ? '' : String(value);
    }
    clean.push(out);
  }

  return {
    dataset: {
      name: String(input.name ?? '').trim() || 'data',
      columns,
      rows: clean,
    },
  };
}

// The payload is a discriminated union so ONE route serves both pages.
// Validation happens here, at the door, rather than in the headless render —
// a malformed job that only fails inside Chrome looks like a render bug.
function normaliseJob(body) {
  const kind = String(body?.kind ?? '');
  const copies = clampCopies(body?.copies);

  if (kind === 'creator') {
    const label = body?.label;
    const w = Number(label?.w);
    const h = Number(label?.h);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return { error: 'A creator job needs label { w, h } in millimetres.' };
    }
    if (!Array.isArray(body?.elements)) {
      return { error: 'A creator job needs an elements array.' };
    }
    const { dataset, error } = normaliseDataset(body?.dataset);
    if (error) return { error };
    return {
      job: {
        kind: 'creator',
        label: { w, h },
        elements: body.elements,
        dataset,
        copies,
      },
    };
  }

  if (kind === 'production') {
    const batchId = Number(body?.batchId);
    if (!Number.isInteger(batchId) || batchId < 1) {
      return { error: 'A production job needs a numeric batchId.' };
    }
    return { job: { kind: 'production', batchId, copies } };
  }

  // NOK — a not-remanufactured run. Carries its own id because nok_batches is a
  // separate table; a plain `batchId` here would silently render the OK batch
  // that happens to share the number.
  if (kind === 'nok') {
    const nokBatchId = Number(body?.nokBatchId);
    if (!Number.isInteger(nokBatchId) || nokBatchId < 1) {
      return { error: 'A NOK job needs a numeric nokBatchId.' };
    }
    return { job: { kind: 'nok', nokBatchId, copies } };
  }

  return {
    error: `Unknown job kind "${kind}" — expected "creator", "production" or "nok".`,
  };
}

// ---------------------------------------------------------------------------
// PowerShell
// ---------------------------------------------------------------------------

// PowerShell serialises its own error stream as CLIXML the moment stderr is
// redirected, so a one-line failure arrives as 900 characters of XML. The
// print scripts below write their errors with [Console]::Error.WriteLine to
// avoid it entirely; this is the safety net for anything that still slips
// through, because the error text ends up in front of an operator.
function cleanPowerShellError(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('#< CLIXML')) return raw;
  const lines = [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) =>
    m[1]
      .replace(/_x000D_/g, '')
      .replace(/_x000A_/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim(),
  );
  const first = lines.find(Boolean);
  return first || raw.slice(0, 300);
}

// -EncodedCommand takes UTF-16LE base64, which means the script reaches
// PowerShell BYTE FOR BYTE — no argv quoting layer between Node and the
// shell to mangle the embedded double quotes around a printer name. That is
// the whole reason it is used here rather than -Command.
function runPowerShell(script, { timeoutMs = POWERSHELL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { windowsHide: true },
      );
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: '', error: e.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish({
        ok: false,
        stdout,
        stderr,
        error: `PowerShell timed out after ${timeoutMs} ms.`,
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (e) =>
      finish({ ok: false, stdout, stderr, error: e.message }),
    );
    child.on('close', (code) =>
      finish({
        ok: code === 0,
        stdout,
        stderr,
        error:
          code === 0
            ? null
            : cleanPowerShellError(stderr) ||
              `PowerShell exited with code ${code}.`,
      }),
    );
  });
}

// The exact command the card specifies. Kept as a named constant so the
// string in the code and the string in the evidence are provably the same.
const LIST_PRINTERS_COMMAND =
  'Get-Printer | Select-Object Name,PortName,PrinterStatus,Shared | ConvertTo-Json';

// Get-Printer has no "is this the default" column — that lives on the older
// WMI class. It is queried separately and best-effort: a machine where this
// fails still gets a usable printer list, it just has no pre-selection.
const DEFAULT_PRINTER_COMMAND =
  '(Get-CimInstance -ClassName Win32_Printer -Filter "Default = True" | Select-Object -First 1).Name';

// Get-Printer's PrinterStatus is the MSFT_Printer enum. ConvertTo-Json emits
// it as a number, so the number is mapped back to the word the operator sees
// in the Windows printer list.
const PRINTER_STATUS = {
  0: 'Normal',
  1: 'Paused',
  2: 'Error',
  3: 'Pending deletion',
  4: 'Paper jam',
  5: 'Paper out',
  6: 'Manual feed',
  7: 'Paper problem',
  8: 'Offline',
  9: 'IO active',
  10: 'Busy',
  11: 'Printing',
  12: 'Output bin full',
  13: 'Not available',
  14: 'Waiting',
  15: 'Processing',
  16: 'Initializing',
  17: 'Warming up',
  18: 'Toner low',
  19: 'No toner',
  20: 'Page punt',
  21: 'User intervention required',
  22: 'Out of memory',
  23: 'Door open',
  24: 'Server unknown',
  25: 'Power save',
};

function statusText(value) {
  if (typeof value === 'string') return value;
  return PRINTER_STATUS[value] ?? String(value ?? 'Unknown');
}

// ---------------------------------------------------------------------------
// How a PDF is handed to a printer
//
// The intended command is the shell verb:
//
//   Start-Process -FilePath "<pdf>" -Verb PrintTo -ArgumentList "<printer>"
//
// It works only if the .pdf association actually resolves a `printto` verb.
// ON THIS MACHINE IT DOES NOT, and the reason is worth writing down because
// it is invisible from the registry key everyone checks first:
//
//   HKCR\.pdf                            -> Acrobat.Document.DC   (has printto)
//   HKCU\...\FileExts\.pdf\UserChoice    -> MSEdgePDF             (open, runas only)
//
// The per-user UserChoice WINS, so ShellExecute resolves `printto` against
// MSEdgePDF, finds nothing, and fails with ERROR_NO_ASSOCIATION (0x80070483).
// Verified with AssocQueryString(ASSOCSTR_COMMAND, ".pdf", "printto").
//
// So the verb is probed first and used when it is genuinely available; when
// it is not, the command line that the verb WOULD have run is read straight
// out of the registry and invoked directly. That is not a workaround around
// Windows - it is exactly what Windows does, minus the association lookup
// that this machine's UserChoice breaks. Which of the two ran is reported on
// every response as `method`, so nothing about it is hidden.
const RESOLVE_PRINTTO_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
function Get-PrintToCommand([string]$progId) {
  if (-not $progId) { return $null }
  $v = (Get-ItemProperty -Path ("Registry::HKEY_CLASSES_ROOT\\" + $progId + "\\shell\\printto\\command")).'(default)'
  if ($v) { return $v }
  return $null
}
$userChoice = (Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice').ProgId
$defaultProgId = (Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\\.pdf').'(default)'
$openWith = @()
$ow = Get-Item 'Registry::HKEY_CLASSES_ROOT\\.pdf\\OpenWithProgids'
if ($ow) { $openWith = @($ow.GetValueNames() | Where-Object { $_ }) }
$effective = $userChoice
if (-not $effective) { $effective = $defaultProgId }
$shellVerb = [bool](Get-PrintToCommand $effective)
$fallbackProgId = $null
$fallbackCommand = $null
foreach ($p in @($defaultProgId) + $openWith) {
  $c = Get-PrintToCommand $p
  if ($c) { $fallbackProgId = $p; $fallbackCommand = $c; break }
}
[pscustomobject]@{
  userChoice = $userChoice
  defaultProgId = $defaultProgId
  effectiveProgId = $effective
  shellVerb = $shellVerb
  printToProgId = $fallbackProgId
  printToCommand = $fallbackCommand
} | ConvertTo-Json -Compress
`;

// Split a registered shell command line into its exe and argument tokens,
// respecting the quotes Windows itself put there.
function splitCommandLine(line) {
  const tokens = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const ch of String(line)) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

// Acrobat registers `"...\Acrobat.exe"  /t "%1" "%2" "%3" "%4"` - file,
// printer, driver, port. Only the first two are known here; the shell leaves
// the rest empty, and passing empty strings to Acrobat is what makes it fall
// back to the printer's own driver and port. Dropping them entirely is the
// same thing and is easier to read in the returned command string.
function buildProgIdCommand(commandLine, pdfPath, printer) {
  const tokens = splitCommandLine(commandLine);
  if (tokens.length === 0) return null;
  const exe = tokens[0];
  const args = [];
  for (const token of tokens.slice(1)) {
    if (token === '%3' || token === '%4') continue;
    if (token === '%1') args.push(psQuote(pdfPath));
    else if (token === '%2') args.push(psQuote(printer));
    else args.push(/\s/.test(token) ? psQuote(token) : token);
  }
  return `& ${psQuote(exe)} ${args.join(' ')}`;
}

async function resolvePrintCommand(pdfPath, printer) {
  const shellVerbCommand = `Start-Process -FilePath ${psQuote(pdfPath)} -Verb PrintTo -ArgumentList ${psQuote(printer)}`;

  const probe = await runPowerShell(RESOLVE_PRINTTO_SCRIPT);
  let info = null;
  if (probe.ok && probe.stdout.trim()) {
    try {
      info = JSON.parse(probe.stdout);
    } catch {
      info = null;
    }
  }

  // No answer at all: use the documented command and let it report its own
  // failure rather than inventing a reason to refuse.
  if (!info) {
    return {
      command: shellVerbCommand,
      method: 'shell-verb',
      association: { probe: probe.error || 'could not be read' },
    };
  }

  const association = {
    userChoice: info.userChoice || null,
    defaultProgId: info.defaultProgId || null,
    effectiveProgId: info.effectiveProgId || null,
    printToProgId: info.printToProgId || null,
    shellVerbAvailable: Boolean(info.shellVerb),
  };

  if (info.shellVerb) {
    return { command: shellVerbCommand, method: 'shell-verb', association };
  }

  const direct = info.printToCommand
    ? buildProgIdCommand(info.printToCommand, pdfPath, printer)
    : null;
  if (direct) {
    return { command: direct, method: 'progid-command', association };
  }

  return {
    command: shellVerbCommand,
    method: 'shell-verb',
    association,
    warning:
      'No .pdf handler on this machine registers a printto command. The print will fail until a PDF reader that does (Adobe Acrobat) is set as the .pdf handler.',
  };
}

// ---------------------------------------------------------------------------
// Headless Chrome over the raw DevTools protocol
//
// Same approach as scripts/verify-print.mjs, deliberately: Chrome is already
// on this machine and already drives the print gate, so adding puppeteer
// would be a second way to do a thing this project already does one way.
// ---------------------------------------------------------------------------

// Playwright's own Chromium, if it is installed (npx playwright install
// chromium). Lets the demo render PDFs on a machine without Google Chrome.
function playwrightChromiumCandidates() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);
  const out = [];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = readdirSync(root)
        .filter((d) => /^chromium-d+$/.test(d))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const dir of dirs) {
      out.push(
        path.join(root, dir, 'chrome-win64', 'chrome.exe'),
        path.join(root, dir, 'chrome-win', 'chrome.exe'),
        path.join(root, dir, 'chrome-linux64', 'chrome'),
        path.join(root, dir, 'chrome-linux', 'chrome'),
        path.join(
          root,
          dir,
          'chrome-mac',
          'Chromium.app',
          'Contents',
          'MacOS',
          'Chromium',
        ),
      );
    }
  }
  return out;
}

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    ...playwrightChromiumCandidates(),
  ].filter(Boolean);

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      'Could not find Chrome. Set CHROME_PATH to chrome.exe and restart the server.',
    );
  }
  return found;
}

async function waitForDevToolsPort(userDataDir, timeoutMs) {
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

async function waitForDevToolsHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // Not up yet; keep polling until the deadline.
    }
    await delay(100);
  }
  throw new Error('Chrome DevTools did not answer in time.');
}

// `--remote-debugging-port=0` lets Chrome pick its own free port and write it
// to the profile directory, which removes the race of picking a port here and
// hoping Chrome still wins it a moment later.
async function launchChrome() {
  const chromePath = resolveChromePath();
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), 'label-studio-print-'),
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
    { stdio: 'ignore', windowsHide: true },
  );
  try {
    const port = await waitForDevToolsPort(
      userDataDir,
      CHROME_START_TIMEOUT_MS,
    );
    await waitForDevToolsHttp(port, CHROME_START_TIMEOUT_MS);
    return { proc, userDataDir, port };
  } catch (e) {
    await killProcessTree(proc);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
    return;
  }
  proc.kill();
}

async function openTab(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
  });
  if (!res.ok) {
    throw new Error(`Could not open a Chrome tab (HTTP ${res.status}).`);
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
        () => reject(new Error('Chrome DevTools WebSocket failed to connect.')),
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
      if (listeners)
        for (const listener of [...listeners]) listener(message.params);
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

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
    try {
      this.ws.close();
    } catch {
      // Already closing.
    }
  }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
}

// The render target sets data-print-ready on <html> once its tree is painted
// AND every code image has decoded. A marker beats a sleep because a Data
// Matrix that has not decoded yet prints as a white square, and a white
// square on a customer label costs EUR 0.5 a piece. The timeout is what keeps
// a broken job from hanging the server.
const PRINT_STATE_EXPRESSION = `(() => {
  const html = document.documentElement;
  return {
    ready: html.getAttribute('data-print-ready') === 'true',
    error: html.getAttribute('data-print-error') || null,
    pages: document.querySelectorAll('.print-root .label-page').length,
    hasRoot: document.querySelector('.print-root') !== null,
  };
})()`;

async function waitForPrintReady(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(client, PRINT_STATE_EXPRESSION);
    if (last?.error) throw new Error(last.error);
    if (last?.ready) return last;
    await delay(50);
  }
  const detail = last
    ? `print root present: ${last.hasRoot}, label pages: ${last.pages}`
    : 'the page never answered';
  throw new Error(
    `The print page never reported ready within ${timeoutMs} ms (${detail}). ` +
      'If the /print route is missing, run "npm run build" — the server renders the BUILT app from dist/.',
  );
}

// Renders http://localhost:<appPort>/print/<jobId> to PDF and always tears
// its own Chrome down, success or failure.
async function renderJobPdf(jobId, appPort) {
  const chrome = await launchChrome();
  try {
    const tab = await openTab(chrome.port);
    const client = await CdpClient.connect(tab.webSocketDebuggerUrl);
    try {
      await client.send('Page.enable');
      await client.send('Runtime.enable');
      const loaded = client.once('Page.loadEventFired');
      await client.send('Page.navigate', {
        url: `http://localhost:${appPort}/print/${jobId}`,
      });
      await Promise.race([loaded, delay(PAGE_LOAD_TIMEOUT_MS)]);
      const state = await waitForPrintReady(client, PRINT_READY_TIMEOUT_MS);
      // preferCSSPageSize is what makes the runtime `@page { size: Wmm Hmm }`
      // the physical media, so a 70x20 label is a 70x20 page and not a 70x20
      // drawing centred on A4.
      const result = await client.send('Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,
        marginTop: 0,
        marginBottom: 0,
        marginLeft: 0,
        marginRight: 0,
      });
      return {
        buffer: Buffer.from(result.data, 'base64'),
        domPages: state.pages,
      };
    } finally {
      client.close();
      await closeTab(chrome.port, tab.id);
    }
  } finally {
    await killProcessTree(chrome.proc);
    await delay(200);
    await rm(chrome.userDataDir, { recursive: true, force: true }).catch(
      async () => {
        await delay(500);
        await rm(chrome.userDataDir, { recursive: true, force: true }).catch(
          () => {},
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function createPrintRouter({ port }) {
  const router = express.Router();

  // A creator job carries the whole document, and an image element carries a
  // base64 data URL, so the default 100 kb JSON limit is far too small. This
  // parser is scoped to the print routes ALONE — the rest of the API keeps
  // the server's own body limit exactly as it was.
  const jobBody = express.json({ limit: '32mb' });
  const smallBody = express.json({ limit: '256kb' });

  // --- printers ------------------------------------------------------------
  router.get('/api/printers', async (req, res) => {
    if (DEMO_MODE) {
      return res.json({
        printers: [DEMO_PRINTER],
        defaultPrinter: DEMO_PRINTER.name,
        error: null,
      });
    }
    const listed = await runPowerShell(LIST_PRINTERS_COMMAND);
    if (!listed.ok) {
      // A PowerShell failure is a degraded panel, never a dead server: the
      // UI needs to be able to say "no printer list" and offer the browser
      // dialog instead.
      return res.json({
        printers: [],
        defaultPrinter: null,
        error: `Could not list printers: ${listed.error}`,
      });
    }

    let parsed;
    try {
      parsed = listed.stdout.trim() ? JSON.parse(listed.stdout) : [];
    } catch (e) {
      return res.json({
        printers: [],
        defaultPrinter: null,
        error: `Could not read the printer list: ${e.message}`,
      });
    }

    // ConvertTo-Json emits a bare OBJECT when exactly one printer exists and
    // an ARRAY otherwise. Both shapes are real; both are handled.
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);

    const defaultQuery = await runPowerShell(DEFAULT_PRINTER_COMMAND);
    const defaultPrinter = defaultQuery.ok ? defaultQuery.stdout.trim() : '';

    res.json({
      printers: rows.map((row) => ({
        name: String(row.Name ?? ''),
        port: String(row.PortName ?? ''),
        status: statusText(row.PrinterStatus),
        isDefault: Boolean(defaultPrinter) && row.Name === defaultPrinter,
      })),
      defaultPrinter: defaultPrinter || null,
      error: defaultQuery.ok
        ? null
        : `Printers listed, but the default could not be determined: ${defaultQuery.error}`,
    });
  });

  // --- jobs ----------------------------------------------------------------
  router.post('/api/print/jobs', jobBody, (req, res) => {
    const { job, error } = normaliseJob(req.body);
    if (error) return res.status(400).json({ error });

    pruneJobs();
    const jobId = randomUUID();
    jobs.set(jobId, { payload: job, createdAt: Date.now() });
    res.json({ jobId });
  });

  router.get('/api/print/jobs/:id', (req, res) => {
    pruneJobs();
    const entry = jobs.get(String(req.params.id));
    if (!entry) {
      return res.status(404).json({
        error: 'Print job not found — it expired or was never created.',
      });
    }
    res.json(entry.payload);
  });

  // --- demo: the rendered PDF ------------------------------------------------
  router.get('/api/print/pdf/:id', (req, res) => {
    const id = String(req.params.id);
    if (!DEMO_MODE || !UUID_RE.test(id)) {
      return res.status(404).json({ error: 'Not found.' });
    }
    let file = null;
    try {
      file = readdirSync(PDF_DIR).find((name) => name.endsWith(`_${id}.pdf`));
    } catch {
      file = null;
    }
    if (!file) return res.status(404).json({ error: 'PDF not found.' });
    res.type('application/pdf');
    res.sendFile(path.join(PDF_DIR, file));
  });

  // --- print ---------------------------------------------------------------
  router.post('/api/print', smallBody, async (req, res) => {
    const jobId = String(req.body?.jobId ?? '');
    const printer = String(req.body?.printer ?? '').trim();
    const dryRun = Boolean(req.body?.dryRun);

    pruneJobs();
    const entry = jobs.get(jobId);
    if (!entry) {
      return res.status(404).json({
        jobId,
        pdfPath: null,
        pages: null,
        submitted: false,
        command: null,
        error: 'Print job not found — it expired or was never created.',
      });
    }
    if (!printer) {
      return res.status(400).json({
        jobId,
        pdfPath: null,
        pages: null,
        submitted: false,
        command: null,
        error: 'Pick a printer first.',
      });
    }

    // The stored payload is the single source of truth for how many pages get
    // rendered. A `copies` in this request re-stamps it BEFORE the render, so
    // the PDF and the number reported back can never disagree.
    if (req.body?.copies != null) {
      entry.payload = {
        ...entry.payload,
        copies: clampCopies(req.body.copies),
      };
    }

    let rendered;
    try {
      rendered = await renderJobPdf(jobId, port);
    } catch (e) {
      return res.status(500).json({
        jobId,
        pdfPath: null,
        pages: null,
        submitted: false,
        command: null,
        error: `Render failed: ${e.message}`,
      });
    }

    ensurePdfDir();
    prunePdfs();
    const pdfPath = path.join(PDF_DIR, `${entry.payload.kind}_${jobId}.pdf`);
    try {
      await writeFile(pdfPath, rendered.buffer);
    } catch (e) {
      return res.status(500).json({
        jobId,
        pdfPath: null,
        pages: null,
        submitted: false,
        command: null,
        error: `Could not write the PDF: ${e.message}`,
      });
    }

    const pages = pdfPageCount(rendered.buffer);
    const resolved = await resolvePrintCommand(pdfPath, printer);
    const { command, method, association } = resolved;

    // Demo printer: the render above was real, the spooler is not. The PDF is
    // served back so the operator can see the exact pages a printer would get.
    if (DEMO_MODE && printer === DEMO_PRINTER.name) {
      return res.json({
        jobId,
        pdfPath,
        pdfUrl: `/api/print/pdf/${jobId}`,
        pages,
        domPages: rendered.domPages,
        submitted: true,
        demo: true,
        command: null,
        method: 'demo-pdf',
        error: null,
      });
    }

    // dryRun renders for real and stops one step short of the spooler. It is
    // what automated evidence uses, so the PDF it leaves behind is a real
    // rendered document and the command it returns is the real command —
    // just not executed.
    if (dryRun) {
      return res.json({
        jobId,
        pdfPath,
        pages,
        domPages: rendered.domPages,
        submitted: false,
        dryRun: true,
        command,
        method,
        association,
        error: resolved.warning ?? null,
      });
    }

    // The error is written with [Console]::Error.WriteLine rather than left
    // to PowerShell's own error stream, which serialises to CLIXML the moment
    // stderr is redirected. This message goes in front of an operator.
    const run = await runPowerShell(
      `$ErrorActionPreference = 'Stop'
try { ${command} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
      { timeoutMs: SUBMIT_TIMEOUT_MS },
    );

    // `submitted` means the handler was invoked WITHOUT ERROR. It does not
    // mean paper came out: the PDF handler owns the spooler from here, and
    // the shell-verb form is asynchronous on top of that. The operator
    // confirming the run is the only proof of a physical print, which is
    // exactly why Production keeps its "did all labels print?" step.
    res.json({
      jobId,
      pdfPath,
      pages,
      domPages: rendered.domPages,
      submitted: run.ok,
      command,
      method,
      association,
      error: run.ok ? (resolved.warning ?? null) : run.error,
    });
  });

  return router;
}

export default createPrintRouter;
