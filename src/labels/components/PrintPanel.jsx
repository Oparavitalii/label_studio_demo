// The print panel: pick the printer, set the copies, press Print.
//
// A browser cannot choose a printer from JavaScript - window.print() opens
// the OS dialog and the operator picks by hand every single run - so the
// destination is chosen here and the job goes out through the Node server
// (Server/print.js), which renders the document to PDF in headless Chrome
// and hands that PDF to the Windows spooler.
//
// THE PANEL IS HONEST ABOUT THE SERVER.
// Running Vite without the backend is a normal state during development, and
// a print button that silently does nothing in that state is worse than no
// button at all. If /api/printers cannot be reached the panel SAYS SO and
// offers the browser dialog instead, which still works because PrintSheet is
// mounted either way.
//
// It serves both pages from one component. The Creator drives it through its
// own Print button; Production drives it through `ref`, because there the
// batch has to be created (and its serial numbers allocated) BEFORE there is
// anything to print, and only the Production page knows how to do that.
import { useCallback, useEffect, useImperativeHandle, useState } from 'react';

import '../styles/print-panel.css';

const PRINTER_KEY = 'labelstudio.print.printer';

// A sane ceiling, matching the server's. A typo of 1000 in a copies box is a
// whole roll of stock at EUR 0.5 a label.
const COPIES_MAX = 100;

// A destination whose port prompts for a filename cannot run unattended: the
// job stops on a Save dialog nobody is watching.
const PROMPTING_PORTS = ['PORTPROMPT:'];

function readRememberedPrinter() {
  try {
    return window.localStorage.getItem(PRINTER_KEY) || '';
  } catch {
    // Storage is disabled or full. Remembering is a convenience, never a
    // requirement - fall through to the system default.
    return '';
  }
}

function rememberPrinter(name) {
  try {
    window.localStorage.setItem(PRINTER_KEY, name);
  } catch {
    // See above.
  }
}

function clampCopies(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, COPIES_MAX);
}

async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('The print server is not reachable. Is it running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export default function PrintPanel({
  ref,
  pages = 1,
  getJob,
  onBrowserPrint,
  onPrinted,
  primaryLabel = 'Print',
  browserLabel = 'Browser dialog',
  disabled = false,
  title = 'Print',
}) {
  const [printers, setPrinters] = useState([]);
  const [printer, setPrinter] = useState('');
  const [copies, setCopies] = useState('1');
  // loading -> ok | empty | down. `down` is the one that changes what the
  // panel offers; the other two only change what it says.
  const [probe, setProbe] = useState('loading');
  const [probeNote, setProbeNote] = useState('');
  // idle -> submitting -> done | error. Never optimistic: `done` is set from
  // the server's own answer, not from having sent the request.
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  // Demo mode only: the server's virtual printer renders the job to a PDF and
  // returns its URL instead of sending it to a spooler.
  const [pdfUrl, setPdfUrl] = useState('');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/printers');
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const data = await res.json();
        if (cancelled) return;

        const list = Array.isArray(data.printers) ? data.printers : [];
        setPrinters(list);
        setProbeNote(data.error || '');
        if (list.length === 0) {
          setProbe('empty');
          return;
        }
        setProbe('ok');

        // Last used wins, but only if it still exists - a printer that was
        // unplugged since the last run must not stay silently selected.
        const remembered = readRememberedPrinter();
        const systemDefault = list.find((p) => p.isDefault)?.name;
        setPrinter(
          list.some((p) => p.name === remembered)
            ? remembered
            : (systemDefault ?? list[0].name),
        );
      } catch (e) {
        if (cancelled) return;
        setProbe('down');
        setProbeNote(e.message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const copiesN = clampCopies(copies);
  const basePages = Math.max(0, Math.trunc(Number(pages)) || 0);
  const total = basePages * copiesN;
  const selected = printers.find((p) => p.name === printer) ?? null;
  const prompts = selected ? PROMPTING_PORTS.includes(selected.port) : false;
  const canServerPrint = probe === 'ok' && Boolean(printer);
  const submitting = status === 'submitting';

  const choosePrinter = (event) => {
    const name = event.target.value;
    setPrinter(name);
    rememberPrinter(name);
    setStatus('idle');
    setMessage('');
  };

  // The one path that actually prints. `override` lets a host page hand in a
  // job it built itself (Production, which must create the batch first);
  // without one the panel asks `getJob` for the live document.
  const submit = useCallback(
    async (override) => {
      const base = override ?? (typeof getJob === 'function' ? getJob() : null);
      if (!base) {
        setStatus('error');
        setMessage('There is nothing to print yet.');
        return { ok: false, error: 'There is nothing to print yet.' };
      }
      if (!printer) {
        setStatus('error');
        setMessage('Pick a printer first.');
        return { ok: false, error: 'Pick a printer first.' };
      }

      setStatus('submitting');
      setMessage('');
      setPdfUrl('');
      try {
        // Two steps on purpose: the document travels to the server FIRST,
        // because the headless Chrome that renders it starts empty and has
        // no way to reach into this browser's state.
        const { jobId } = await postJson('/api/print/jobs', {
          ...base,
          copies: copiesN,
        });
        const result = await postJson('/api/print', {
          jobId,
          printer,
          copies: copiesN,
        });
        if (!result.submitted) {
          throw new Error(
            result.error || 'The printer did not accept the job.',
          );
        }
        setStatus('done');
        if (result.demo && result.pdfUrl) {
          setPdfUrl(result.pdfUrl);
          setMessage(
            `Demo printer: ${result.pages ?? total} page(s) rendered to PDF by headless Chrome. No hardware involved.`,
          );
        } else {
          setMessage(
            `Sent ${result.pages ?? total} page(s) to ${printer}. Check that the labels actually came out.`,
          );
        }
        onPrinted?.(result);
        return { ok: true, result };
      } catch (e) {
        setStatus('error');
        setMessage(e.message);
        return { ok: false, error: e.message };
      }
    },
    [copiesN, getJob, onPrinted, printer, total],
  );

  useImperativeHandle(
    ref,
    () => ({ submit, canServerPrint, printer, copies: copiesN }),
    [submit, canServerPrint, printer, copiesN],
  );

  const browserPrint = () => {
    setStatus('idle');
    setMessage('');
    if (onBrowserPrint) onBrowserPrint();
    else window.print();
  };

  return (
    <section className='lbl-print-panel'>
      <h2 className='lbl-panel__title'>{title}</h2>

      {probe === 'down' ? (
        <p className='lbl-print-panel__note lbl-print-panel__note--alert'>
          No print server. {probeNote} Choosing a printer needs the app server
          (npm run server); until it is running, only the browser print dialog
          is available.
        </p>
      ) : (
        <label className='lbl-print-panel__field'>
          <span className='lbl-field__label'>Printer</span>
          <select
            className='lbl-select'
            value={printer}
            onChange={choosePrinter}
            disabled={probe !== 'ok' || submitting}
          >
            {probe === 'loading' && <option value=''>Loading printers…</option>}
            {probe === 'empty' && <option value=''>No printers found</option>}
            {printers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      {selected && (
        <p className='lbl-print-panel__note'>
          {selected.port} · {selected.status}
        </p>
      )}
      {prompts && (
        <p className='lbl-print-panel__note lbl-print-panel__note--alert'>
          This destination asks for a filename, so the job stops on a dialog
          instead of printing.
        </p>
      )}
      {probe === 'ok' && probeNote && (
        <p className='lbl-print-panel__note'>{probeNote}</p>
      )}

      <label className='lbl-print-panel__field'>
        <span className='lbl-field__label'>Copies</span>
        <input
          className='lbl-input'
          type='number'
          min='1'
          max={COPIES_MAX}
          value={copies}
          onChange={(event) => {
            setCopies(event.target.value);
            setStatus('idle');
            setMessage('');
          }}
          disabled={submitting}
        />
      </label>

      <p className='lbl-print-panel__total'>
        {basePages} page{basePages === 1 ? '' : 's'} × {copiesN} = {total} label
        {total === 1 ? '' : 's'}
      </p>

      <div className='lbl-print-panel__actions'>
        {primaryLabel !== null && (
          <button
            type='button'
            className='lbl-btn lbl-btn--primary'
            onClick={() => submit()}
            disabled={disabled || submitting || !canServerPrint}
          >
            {submitting ? 'Printing…' : primaryLabel}
          </button>
        )}
        {/* Hidden where the host page already falls back on its own
            (Production does, inside its own delivery path) - a button that
            would print a blank sheet is worse than no button. */}
        {browserLabel !== null && (
          <button
            type='button'
            className='lbl-btn'
            onClick={browserPrint}
            disabled={submitting}
          >
            {browserLabel}
          </button>
        )}
      </div>

      {message && (
        <p
          className={
            status === 'error'
              ? 'lbl-print-panel__note lbl-print-panel__note--alert'
              : 'lbl-print-panel__note lbl-print-panel__note--ok'
          }
          role='status'
        >
          {message}
          {pdfUrl && status === 'done' && (
            <>
              {' '}
              <a href={pdfUrl} target='_blank' rel='noreferrer'>
                Open the PDF
              </a>
            </>
          )}
        </p>
      )}
    </section>
  );
}
