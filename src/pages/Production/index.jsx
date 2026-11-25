// Production — the print console, ported from
// Label_Print/src/App.jsx onto this app's shell.
//
// Four things had to change on the way in; everything else is the original,
// because this code prints real serial numbers against a real print log and
// a wrong label costs EUR 0.5 a piece.
//
//  1. App.css is NOT imported. It was a global reset (bare `*`, `body`,
//     `h1`, `h2`, `input`, `select`, `button`) and it would have restyled
//     every control in this app, the label editor included. It is rewritten
//     as production.css with every class namespaced lbl-prod-*.
//
//  2. The print sheet is PORTALED onto document.body as `.print-root`.
//     The host's src/labels/styles/print.css:30-32 declares
//     `@media print { body > * { display: none } }` and wins back only
//     `.print-root`. The original mounted `#print_sheet` inside `#root`, so
//     under this app's print rules `#root` is hidden and no descendant
//     renders a box at all — the naive port prints a BLANK page, and its
//     own `display: block !important` cannot rescue a `display: none`
//     ancestor. The technique here is copied from PrintSheet.jsx, which
//     already learned this: portal to body, wrap each physical label in
//     `.label-page` so print.css's `break-after: page` applies, and emit
//     the `@page` size at runtime instead of hardcoding it in a stylesheet.
//
//  3. The Ctrl+P hijack is registered inside a useEffect that removes it on
//     unmount. As one route among three, a listener left on `window` would
//     break Ctrl+P on the Creator and Templates pages too.
//
//  4. window.confirm() is gone — it appeared five times in the original.
//     A native modal blocks automation and can wedge a browser session, and
//     the headless print check below has to drive this page. Every guard is
//     kept: each of those five actions is still two clicks, never one, via
//     the inline ConfirmPanel.
//  5. It carries TWO tabs. "Remanufactured (OK)" is everything below — the
//     serial-numbered label this page has always printed. "Not remanufactured
//     (NOK)" is Nok_Tab.jsx: the customer's supplier manual section 5, a label with no serial
//     at all. They share this page's chrome (topbar, supplier code, banners,
//     the Ctrl+P guard) and NOTHING else. In particular the NOK tab never
//     touches /api/batches, so it cannot move a machine counter.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import ConfirmPanel from './Confirm_Panel.jsx';
import { labelDate, todayLabelDate } from './dates.js';
import Label_70 from './Label_70.jsx';
import Nok_Tab from './Nok_Tab.jsx';
import PrintPanel from '../../labels/components/PrintPanel.jsx';
import './production.css';

const MACHINES = [1, 2];
const RANGE_START = { 1: 100001, 2: 200001 };
const RANGE_END = { 1: 199999, 2: 299999 };

// TWO KINDS OF SERIAL NUMBER.
//
// AUTOMATIC — six digits, first digit = machine: 100001, 200001. Unchanged.
//
// MANUAL — whatever the operator types, any characters and any length (only
// whitespace is refused — it breaks the Data Matrix), printed exactly as typed. The batch
// counts up by incrementing the TRAILING run of digits inside its own width:
// S00001 -> S00002, AB09 -> AB10. A SN with no digits at all prints once.
//
// A NOK label has no serial number at all, so none of this reaches the NOK
// tab — see Nok_Tab.jsx.
//
// These helpers MIRROR Server/index.js. Copied rather than imported, the way
// labelDate already is between this page and /print: the server owns the real
// rule and re-validates every value this form sends, so the copy here is only
// what the operator sees while typing. Change one, change both.
const AUTO_SN_WIDTH = 6;
// An automatic serial always prints as 6 digits — 1 becomes "000001".
const fmtSN = (n) => String(n).padStart(AUTO_SN_WIDTH, '0');
const snOf = (prefix, width, serial) =>
  width > 0 ? prefix + String(serial).padStart(width, '0') : prefix;

// "S00001" -> { prefix: 'S', width: 5, serial: 1, max: 99999 }. '' -> null.
// Anything else -> { error }.
function parseSerialInput(raw) {
  if (raw == null) return null;
  const text = String(raw).trim().toUpperCase();
  if (!text) return null;
  if (/\s/.test(text)) {
    return { error: 'Manual SN must not contain spaces.' };
  }
  const [, prefix, digits] = /^(.*?)([0-9]*)$/.exec(text);
  const width = digits.length;
  return {
    prefix,
    width,
    serial: width > 0 ? Number(digits) : 0,
    max: width > 0 ? 10 ** width - 1 : 0,
  };
}

// The physical label, and therefore the physical page. 70×50 mm is a customer
// contract, not a preference.
const PAGE_W_MM = 70;
const PAGE_H_MM = 50;

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Server is not reachable. Is the app server running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const EMPTY_NEW_PRODUCT = { customerCode: '', name: '', producerNumber: '' };

// The whole printed document, portaled out of the page and onto document.body
// so print.css's `body > * { display: none }` cannot swallow it — see note 2
// at the top of this file.
//
// The `@page` size is emitted here, at runtime, rather than written into
// production.css. A stylesheet @page is global and cannot vary, and the
// Creator route mounts its own PrintSheet with its own @page for whatever
// label size the editor holds. THIS IS LOAD-BEARING AND INVISIBLE: only one
// route is mounted at a time, so only one @page rule ever exists at a time.
// Two of them in one document would silently fight, and the loser is a
// mis-sized physical label.
//
// EXPORTED because src/pages/Print/index.jsx - the headless render target the
// print server opens in Chrome - has to produce BYTE-IDENTICAL pages to the
// ones this page prints. Re-implementing the sheet there would have been two
// copies of a customer contract that costs EUR 0.5 a piece when it drifts.
//
// `copies` repeats the WHOLE label run, the way a print dialog's copies box
// does, and defaults to 1 so every existing call site is unchanged. It is a
// different thing from the batch's `repeats`, which repeats each label in
// place; both can apply at once.
export function ProductionPrintSheet({ job, copies = 1 }) {
  const runs = Math.max(1, Math.trunc(Number(copies)) || 1);
  const pages = Array.from({ length: runs }, () => job.labels).flat();

  return createPortal(
    <div className='print-root'>
      <style>{`@page { size: ${PAGE_W_MM}mm ${PAGE_H_MM}mm; margin: 0; }`}</style>
      {pages.map((l, i) => (
        <div
          key={`${l.serial}-${i}`}
          className='label-page'
          style={{ width: `${PAGE_W_MM}mm`, height: `${PAGE_H_MM}mm` }}
        >
          <Label_70
            name={job.product.name}
            producerNumber={job.product.producerNumber}
            serial={l.sn ?? fmtSN(l.serial)}
            orderNumber={job.orderNumber}
            customerCode={job.product.customerCode}
            supplierCode={job.supplierCode}
            dateStr={job.dateStr}
            matrix={l.matrix}
          />
        </div>
      ))}
    </div>,
    document.body,
  );
}

export default function Production() {
  const [state, setState] = useState(null);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState({
    productId: '',
    orderNumber: '',
    machine: 1,
    quantity: '',
    repeats: 2,
  });
  const [newProduct, setNewProduct] = useState(null);
  const [printJob, setPrintJob] = useState(null);
  const [confirmPrint, setConfirmPrint] = useState(null); // last job, awaiting "did it print?"
  const [ask, setAsk] = useState(null); // the inline two-step confirmation
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [supplierEdit, setSupplierEdit] = useState(null);
  const [expanded, setExpanded] = useState(null); // { batch, selected:Set, copies }
  const [manualSN, setManualSN] = useState(null); // null = automatic serials
  // 'ok' = remanufactured, serial-numbered. 'nok' = the customer's supplier manual section 5.
  // Only one is mounted at a time, which is what keeps a single @page rule in
  // the document — see the note on ProductionPrintSheet above.
  const [tab, setTab] = useState('ok');
  const printJobRef = useRef(null);
  printJobRef.current = printJob;
  // The print panel's imperative handle: { submit, canServerPrint, copies }.
  // A ref rather than state on purpose - the panel's own re-renders must not
  // re-render this page, which holds the serial-number form.
  const printPanelRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([
        api('/api/state'),
        api('/api/batches?limit=200'),
      ]);
      setState(s);
      setHistory(b.batches);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ONE delivery path for every job this page prints.
  //
  // With the print server up and a printer chosen, the job is rendered
  // server-side and sent straight to that printer - no OS dialog, no picking
  // the Zebra out of a list eighty times a day. Without it (Vite alone, a
  // PowerShell that would not answer, a printer that refused the job) the
  // browser dialog takes over exactly as it did before this card.
  //
  // The fallback is NOT optional politeness. The serial numbers are already
  // allocated and logged by the time this runs, so a print that cannot be
  // delivered must fail LOUDLY and still offer a way out - a silent failure
  // here is a gap in the print log that nobody discovers until the labels
  // are missing from the pallet.
  //
  // Either way the run ends at the same "did all labels print?" confirmation,
  // because an operator looking at the physical labels is the only real proof
  // that anything was printed.
  const deliver = useCallback(async (job) => {
    const panel = printPanelRef.current;
    // `deliveryFailed` is set on a job whose server submit already failed
    // once. Retrying it down the same path would just fail again, so the
    // retry goes to the browser dialog - which still works, because the
    // print sheet is mounted either way.
    if (job.deliveryFailed || !panel?.canServerPrint) {
      setPrintJob(job);
      return;
    }
    const copies = panel.copies ?? 1;
    const outcome = await panel.submit({
      kind: 'production',
      batchId: job.batchId,
    });
    if (outcome.ok) {
      setConfirmPrint({ ...job, copies });
      return;
    }
    // A failed submit is NOT proof that nothing printed. The command hands
    // the PDF to a separate handler, so "the command reported an error" and
    // "no labels came out" are different statements. Reprinting automatically
    // could put a whole run on the floor twice at EUR 0.5 a label, so the job
    // goes to the confirmation the operator already knows, with the real
    // error above it, and THEY decide whether to print again.
    setError(`Print server: ${outcome.error}`);
    setConfirmPrint({ ...job, copies, deliveryFailed: true });
  }, []);

  useEffect(() => {
    // Fires after the print dialog closes — on Print AND on Cancel alike, so
    // the job moves to a "did everything print?" confirmation instead of
    // vanishing. Ignore prints the app didn't start (browser Ctrl+P), or they
    // would wipe a pending confirmation banner.
    const onAfter = () => {
      if (!printJobRef.current) return;
      setConfirmPrint(printJobRef.current);
      setPrintJob(null);
      refresh();
    };
    // Scoped to this route's lifetime on purpose. Ctrl+P on a page whose
    // print sheet is empty prints blank labels, so it is intercepted here —
    // and released again the moment Production unmounts, so Creator and
    // Templates keep their own Ctrl+P.
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        setNotice(
          'Use the PRINT LABELS button to print — Ctrl+P would print blank pages.',
        );
      }
    };
    window.addEventListener('afterprint', onAfter);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('afterprint', onAfter);
      window.removeEventListener('keydown', onKey);
    };
  }, [refresh]);

  useEffect(() => {
    if (!printJob) return;
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, [printJob]);

  const product = useMemo(
    () => state?.products.find((p) => p.id === Number(form.productId)) || null,
    [state, form.productId],
  );

  const lastSerial = state?.lastSerials?.[form.machine] ?? null;
  const nextSerial = lastSerial ? lastSerial + 1 : RANGE_START[form.machine];
  const remaining = state?.remaining?.[form.machine] ?? null;
  const rangeFull = nextSerial > RANGE_END[form.machine];
  // Manual serials are free of the machine ranges — any SN the operator typed
  // works, in whatever shape they typed it.
  const manualParsed = manualSN === null ? null : parseSerialInput(manualSN);
  const manualValid = Boolean(manualParsed && !manualParsed.error);
  const manualValue = manualValid ? manualParsed.serial : null;
  const manualPrefix = manualValid ? manualParsed.prefix : '';
  const manualWidth = manualValid ? manualParsed.width : 0;
  // What the label under the form shows: the manual SN once it is valid,
  // the automatic next serial otherwise.
  const effectiveSn = manualValid
    ? snOf(manualPrefix, manualWidth, manualValue)
    : fmtSN(nextSerial);
  const qty = Number(form.quantity);
  const repeats = Number(form.repeats);
  const totalLabels = qty > 0 && repeats > 0 ? qty * repeats : 0;

  // Any edit invalidates an open confirmation: the panel quotes concrete
  // numbers, and a stale quote is worse than no quote at all.
  const setField = (key) => (e) => {
    setError('');
    setAsk(null);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  const setProductField = (key) => (e) => {
    setError('');
    setAsk(null);
    setNewProduct((np) => ({ ...np, [key]: e.target.value }));
  };

  // ----- new product -----
  const commitProduct = async () => {
    setAsk(null);
    const { customerCode, name, producerNumber } = newProduct;
    setBusy(true);
    try {
      const { product: saved, updated } = await api('/api/products', {
        method: 'POST',
        body: { customerCode, name, producerNumber },
      });
      await refresh();
      setForm((f) => ({ ...f, productId: String(saved.id) }));
      setNewProduct(null);
      if (updated) {
        setError(
          `Product ${saved.producerNumber} was updated (it already existed).`,
        );
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveProduct = () => {
    setError('');
    const { customerCode, name, producerNumber } = newProduct;
    if (!(customerCode || '').trim()) {
      setError('Enter the customer code.');
      return;
    }
    const existing = state.products.find(
      (p) => p.producerNumber === (producerNumber || '').trim().toUpperCase(),
    );
    if (existing) {
      const changed =
        existing.customerCode !== (customerCode || '').trim().toUpperCase() ||
        existing.name !== (name || '').trim().toUpperCase();
      setAsk(
        changed
          ? {
              kind: 'product',
              title: `Product ${existing.producerNumber} already exists`,
              lines: [
                `Stored now: ${existing.customerCode} — ${existing.name}`,
                `Overwrite with: ${customerCode.trim().toUpperCase()} — ${name.trim().toUpperCase()}`,
                'Already printed labels and history keep their original data.',
              ],
              confirmLabel: 'Overwrite product',
              danger: true,
            }
          : {
              kind: 'product',
              title: `Product ${existing.producerNumber} already exists`,
              lines: ['It already holds exactly this data. Save anyway?'],
              confirmLabel: 'Save anyway',
              danger: false,
            },
      );
      return;
    }
    commitProduct();
  };

  // ----- printing -----
  const commitPrint = async () => {
    setAsk(null);
    setConfirmPrint(null);
    setBusy(true);
    try {
      const { batch } = await api('/api/batches', {
        method: 'POST',
        body: {
          productId: product.id,
          orderNumber: form.orderNumber.trim(),
          machine: Number(form.machine),
          quantity: qty,
          repeats: repeats,
          startSerial: manualSN !== null ? manualSN : null,
        },
      });
      setForm((f) => ({ ...f, quantity: '' }));
      setManualSN(null);
      await deliver({
        title: `Order ${batch.orderNumber}`,
        batchId: batch.id,
        product: batch.product,
        orderNumber: batch.orderNumber,
        supplierCode: batch.supplierCode,
        dateStr: labelDate(batch.printedAt),
        labels: batch.labels.flatMap((l) =>
          Array.from({ length: batch.repeats }, () => l),
        ),
      });
      refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const createAndPrint = () => {
    if (printJob || busy) return;
    setError('');
    if (!product) return setError('Select a product first.');
    if (!form.orderNumber.trim()) return setError('Enter the order number.');
    if (!(qty >= 1)) return setError('Enter how many pieces to label.');
    if (manualSN !== null) {
      if (!manualValid) return setError(manualParsed.error);
      if (manualWidth === 0 && qty > 1) {
        return setError(
          `Manual SN "${manualPrefix}" has no number to count up — it can only print 1 piece. Add digits (for example ${manualPrefix}01) to print ${qty}.`,
        );
      }
      const lastManual = manualValue + qty - 1;
      if (manualWidth > 0 && lastManual > manualParsed.max) {
        return setError(
          `Serials would run past ${snOf(manualPrefix, manualWidth, manualParsed.max)} (start ${effectiveSn}, quantity ${qty}). Reduce the quantity, or start from a wider number.`,
        );
      }
      // A manual SN moves a machine counter ONLY when it is shaped like an
      // automatic one — six plain digits inside that machine's range. S00001
      // and AB09 are different serials in a different space, so they leave
      // both counters exactly where they were.
      const automaticShape = !manualPrefix && manualWidth === AUTO_SN_WIDTH;
      const inOwnRange =
        automaticShape &&
        manualValue >= RANGE_START[form.machine] &&
        manualValue <= RANGE_END[form.machine];
      const otherMachine = automaticShape
        ? MACHINES.find(
            (m) =>
              m !== Number(form.machine) &&
              manualValue >= RANGE_START[m] &&
              manualValue <= RANGE_END[m],
          )
        : undefined;
      const skipped =
        inOwnRange && manualValue > nextSerial ? manualValue - nextSerial : 0;
      const rangeLine = skipped
        ? `WARNING: this SKIPS serials ${nextSerial}–${manualValue - 1} (${skipped} numbers) — the counter continues after the highest printed serial.`
        : otherMachine
          ? `Note: these serials fall inside the automatic range of machine ${otherMachine} and will move its counter forward.`
          : `These serials sit outside the machine ranges — machine ${form.machine}'s counter is not moved and still hands out ${nextSerial} next.`;
      const lastSn = snOf(manualPrefix, manualWidth, lastManual);
      return setAsk({
        kind: 'print',
        title: 'MANUAL SERIAL OVERRIDE',
        lines: [
          qty > 1
            ? `Print ${qty} piece(s) with serials ${effectiveSn}–${lastSn} instead of the automatic ${nextSerial}?`
            : `Print 1 piece with serial ${effectiveSn} instead of the automatic ${nextSerial}?`,
          rangeLine,
          'Duplicates of already printed serials are allowed. Continue?',
        ],
        confirmLabel: `Print with manual SN ${effectiveSn}`,
        danger: true,
      });
    }
    commitPrint();
  };

  const openBatch = async (id) => {
    setAsk(null);
    if (expanded?.batch.id === id) return setExpanded(null);
    try {
      const { batch } = await api(`/api/batches/${id}`);
      setExpanded({ batch, selected: new Set(), copies: 1 });
    } catch (e) {
      setError(e.message);
    }
  };

  const commitVoid = async () => {
    setAsk(null);
    const { batch } = expanded;
    try {
      const { batch: fresh } = await api(`/api/batches/${batch.id}/void`, {
        method: 'POST',
        body: { voided: !batch.voided },
      });
      setExpanded((ex) =>
        ex && ex.batch.id === fresh.id ? { ...ex, batch: fresh } : ex,
      );
      if (fresh.voided) {
        setConfirmPrint((c) => (c && c.batchId === fresh.id ? null : c));
      }
      refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const toggleVoid = () => {
    const { batch } = expanded;
    const first = batch.labels[0]?.sn;
    const last = batch.labels[batch.labels.length - 1]?.sn;
    setAsk(
      batch.voided
        ? {
            kind: 'void',
            title: `Restore batch (order ${batch.orderNumber}, SN ${first}–${last})`,
            lines: ['It goes back into the Excel report.'],
            confirmLabel: 'Restore to report',
            danger: false,
          }
        : {
            kind: 'void',
            title: `Void batch (order ${batch.orderNumber}, SN ${first}–${last})`,
            lines: [
              'It will be EXCLUDED from the Excel report (listed on the Voided sheet instead).',
              'Serial numbers stay used — they are NEVER given out again.',
              'Void only batches that were never physically printed.',
            ],
            confirmLabel: 'Void this batch',
            danger: true,
          },
    );
  };

  const commitDelete = async () => {
    setAsk(null);
    const { batch } = expanded;
    try {
      await api(`/api/batches/${batch.id}`, { method: 'DELETE' });
      setExpanded(null);
      setConfirmPrint((c) => (c && c.batchId === batch.id ? null : c));
      refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const deleteBatch = () => {
    const { batch } = expanded;
    const first = batch.labels[0]?.sn;
    const last = batch.labels[batch.labels.length - 1]?.sn;
    setAsk({
      kind: 'delete',
      title: `DELETE batch (order ${batch.orderNumber}, SN ${first}–${last}) from history`,
      lines: [
        'It disappears completely — from the app AND the Excel report — and its serial numbers can be handed out again.',
        'This cannot be undone.',
      ],
      confirmLabel: 'Delete permanently',
      danger: true,
    });
  };

  const toggleSerial = (serial) => {
    setExpanded((ex) => {
      const selected = new Set(ex.selected);
      if (selected.has(serial)) selected.delete(serial);
      else selected.add(serial);
      return { ...ex, selected };
    });
  };

  // The one path that stays on the browser dialog. A reprint can carry a
  // SELECTION of serials, and the server job payload is { batchId, copies } -
  // it cannot express "these four labels out of eighty". Sending the whole
  // batch instead would be worse than an OS dialog: it would print 76 labels
  // nobody asked for, at EUR 0.5 each.
  const commitReprint = (payload) => {
    setAsk(null);
    setConfirmPrint(null);
    const { batch, chosen, perLabel } = payload;
    setPrintJob({
      title: `REPRINT order ${batch.orderNumber}`,
      batchId: batch.id,
      product: batch.product,
      orderNumber: batch.orderNumber,
      supplierCode: batch.supplierCode,
      dateStr: labelDate(batch.printedAt),
      labels: chosen.flatMap((l) => Array.from({ length: perLabel }, () => l)),
    });
  };

  const reprint = () => {
    if (printJob || busy) return;
    const { batch, selected, copies } = expanded;
    if (batch.voided) {
      setError(
        'This batch is VOIDED — its serials are not in the Excel report. Restore it to the report first, then reprint.',
      );
      return;
    }
    const perLabel = Math.min(10, Math.max(1, Math.trunc(Number(copies)) || 1));
    const chosen = selected.size
      ? batch.labels.filter((l) => selected.has(l.serial))
      : batch.labels;
    const what = selected.size
      ? `${chosen.length} selected label(s)`
      : `ALL ${chosen.length} labels`;
    setAsk({
      kind: 'reprint',
      title: `Reprint ${what} from order ${batch.orderNumber}, ${perLabel}× each`,
      lines: ['Serial numbers stay the same.'],
      confirmLabel: `Reprint ${chosen.length * perLabel} labels`,
      danger: false,
      payload: { batch, chosen, perLabel },
    });
  };

  const runAsk = () => {
    if (!ask) return;
    if (ask.kind === 'product') commitProduct();
    else if (ask.kind === 'print') commitPrint();
    else if (ask.kind === 'void') commitVoid();
    else if (ask.kind === 'delete') commitDelete();
    else if (ask.kind === 'reprint') commitReprint(ask.payload);
  };

  const confirmPanel = (kind) =>
    ask && ask.kind === kind ? (
      <ConfirmPanel
        ask={ask}
        busy={busy}
        onCancel={() => setAsk(null)}
        onConfirm={runAsk}
      />
    ) : null;

  // ----- supplier code -----
  const saveSupplier = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: { supplierCode: supplierEdit },
      });
      setSupplierEdit(null);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // No 100vh here: this page is an outlet under a 56px nav, so the boot
  // screen fills its own box, not the window.
  if (!state) {
    return (
      <div className='lbl-prod-boot'>
        <div className='lbl-prod-boot-card'>
          <h1 className='lbl-prod-title'>Label Studio</h1>
          <p className='lbl-prod-muted'>{error || 'Loading…'}</p>
          {error && (
            <button type='button' className='lbl-prod-btn' onClick={refresh}>
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  const previewLabel = {
    name: product?.name || 'PRODUCT NAME',
    producerNumber: product?.producerNumber || 'PRODUCER NO',
    serial: effectiveSn,
    orderNumber: form.orderNumber.trim() || 'ORDER NO',
    customerCode: product?.customerCode || '000-000-000000R',
    supplierCode: state.supplierCode,
    dateStr: todayLabelDate(),
    matrix: `/${product?.customerCode || '000-000-000000R'}/1/${effectiveSn}`,
  };

  return (
    <>
      <div className='lbl-prod-root'>
        <header className='lbl-prod-topbar'>
          <h1 className='lbl-prod-title'>Label Studio</h1>
          <div className='lbl-prod-supplier'>
            {supplierEdit === null ? (
              <button
                type='button'
                className='lbl-prod-chip'
                onClick={() => setSupplierEdit(state.supplierCode)}
                title='Supplier number printed on every label'
              >
                Supplier: <b>{state.supplierCode}</b> ✎
              </button>
            ) : (
              <span className='lbl-prod-supplier-edit'>
                <input
                  className='lbl-prod-input lbl-prod-input--supplier'
                  value={supplierEdit}
                  onChange={(e) => setSupplierEdit(e.target.value)}
                  autoFocus
                />
                <button
                  type='button'
                  className='lbl-prod-btn'
                  onClick={saveSupplier}
                  disabled={busy}
                >
                  Save
                </button>
                <button
                  type='button'
                  className='lbl-prod-btn lbl-prod-btn--ghost'
                  onClick={() => setSupplierEdit(null)}
                >
                  Cancel
                </button>
              </span>
            )}
          </div>
        </header>

        {state.supplierCodeIsDefault && (
          <div className='lbl-prod-banner lbl-prod-banner--warn'>
            Supplier code is still the placeholder <b>{state.supplierCode}</b> —
            set the real code from the customer before printing production
            labels.
          </div>
        )}
        {error && (
          <div
            className='lbl-prod-banner lbl-prod-banner--error'
            onClick={() => setError('')}
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            className='lbl-prod-banner lbl-prod-banner--ok'
            onClick={() => setNotice('')}
          >
            {notice}
          </div>
        )}
        <nav className='lbl-prod-tabs' aria-label='Label type'>
          <button
            type='button'
            className={
              tab === 'ok'
                ? 'lbl-prod-tab lbl-prod-tab--active'
                : 'lbl-prod-tab'
            }
            onClick={() => {
              setAsk(null);
              setTab('ok');
            }}
            aria-current={tab === 'ok' ? 'page' : undefined}
          >
            Remanufactured{' '}
            <span className='lbl-prod-tab-note'>with serial number</span>
          </button>
          <button
            type='button'
            className={
              tab === 'nok'
                ? 'lbl-prod-tab lbl-prod-tab--active'
                : 'lbl-prod-tab'
            }
            onClick={() => {
              setAsk(null);
              setTab('nok');
            }}
            aria-current={tab === 'nok' ? 'page' : undefined}
          >
            NOK — not remanufactured{' '}
            <span className='lbl-prod-tab-note'>no serial number</span>
          </button>
        </nav>

        {tab === 'nok' && <Nok_Tab state={state} onError={setError} />}

        {tab === 'ok' && confirmPrint && (
          <div className='lbl-prod-banner lbl-prod-banner--ask'>
            <span>
              Did all{' '}
              <b>{confirmPrint.labels.length * (confirmPrint.copies ?? 1)}</b>{' '}
              labels for order <b>{confirmPrint.orderNumber}</b> print
              correctly?
            </span>
            <span className='lbl-prod-banner-actions'>
              <button
                type='button'
                className='lbl-prod-btn'
                onClick={() => setConfirmPrint(null)}
              >
                Yes, all printed
              </button>
              <button
                type='button'
                className='lbl-prod-btn lbl-prod-btn--ghost'
                onClick={() => {
                  const job = confirmPrint;
                  setConfirmPrint(null);
                  // Same delivery path as the first attempt, so a reprint
                  // reaches the same printer instead of dropping back to the
                  // OS dialog halfway through a run.
                  deliver(job);
                }}
              >
                Print again (same serials)
              </button>
            </span>
          </div>
        )}

        {tab === 'ok' && (
          <main className='lbl-prod-layout'>
            <section className='lbl-prod-card'>
              <h2 className='lbl-prod-card-title'>Print labels</h2>

              <label className='lbl-prod-field'>
                <span>Product</span>
                <select
                  className='lbl-prod-select'
                  value={form.productId}
                  onChange={setField('productId')}
                >
                  <option value=''>— select product —</option>
                  {state.products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.producerNumber} — {p.name}
                    </option>
                  ))}
                </select>
              </label>

              {product && (
                <div className='lbl-prod-product-info'>
                  Customer code: <b>{product.customerCode}</b>
                </div>
              )}

              {newProduct === null ? (
                <button
                  type='button'
                  className='lbl-prod-btn lbl-prod-btn--ghost lbl-prod-add-product'
                  onClick={() => setNewProduct(EMPTY_NEW_PRODUCT)}
                >
                  + New product
                </button>
              ) : (
                <div className='lbl-prod-new-product'>
                  <label className='lbl-prod-field'>
                    <span>Customer code</span>
                    <input
                      className='lbl-prod-input'
                      placeholder='001-002-000101R'
                      value={newProduct.customerCode}
                      onChange={setProductField('customerCode')}
                    />
                  </label>
                  <label className='lbl-prod-field'>
                    <span>Product name</span>
                    <input
                      className='lbl-prod-input'
                      placeholder='REMAN INJ CR DELPHI'
                      value={newProduct.name}
                      onChange={setProductField('name')}
                    />
                  </label>
                  <label className='lbl-prod-field'>
                    <span>Producer number</span>
                    <input
                      className='lbl-prod-input'
                      placeholder='1000200301'
                      value={newProduct.producerNumber}
                      onChange={setProductField('producerNumber')}
                    />
                  </label>
                  <div className='lbl-prod-row-buttons'>
                    <button
                      type='button'
                      className='lbl-prod-btn'
                      onClick={saveProduct}
                      disabled={busy}
                    >
                      Save product
                    </button>
                    <button
                      type='button'
                      className='lbl-prod-btn lbl-prod-btn--ghost'
                      onClick={() => {
                        setAsk(null);
                        setNewProduct(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                  {confirmPanel('product')}
                </div>
              )}

              <label className='lbl-prod-field'>
                <span>Order number (from the customer&apos;s order)</span>
                <input
                  className='lbl-prod-input'
                  placeholder='4500012345'
                  value={form.orderNumber}
                  onChange={setField('orderNumber')}
                />
              </label>

              <div className='lbl-prod-field'>
                <span>Machine</span>
                <div className='lbl-prod-machine-row'>
                  {MACHINES.map((m) => (
                    <button
                      type='button'
                      key={m}
                      className={
                        Number(form.machine) === m
                          ? 'lbl-prod-btn lbl-prod-machine lbl-prod-machine--active'
                          : 'lbl-prod-btn lbl-prod-machine'
                      }
                      onClick={() => {
                        setAsk(null);
                        setForm((f) => ({ ...f, machine: m }));
                        setManualSN(null);
                      }}
                    >
                      Machine {m}
                    </button>
                  ))}
                </div>
                <div className='lbl-prod-serial-info'>
                  Last SN: <b>{lastSerial ?? '—'}</b> · Next SN:{' '}
                  <b>{rangeFull ? 'RANGE FULL' : nextSerial}</b>
                  {!rangeFull && remaining !== null && remaining < 500 && (
                    <span className='lbl-prod-range-warn'>
                      {' '}
                      · only {remaining} serials left!
                    </span>
                  )}
                </div>
                {manualSN === null ? (
                  <button
                    type='button'
                    className='lbl-prod-btn lbl-prod-btn--ghost lbl-prod-manual-btn'
                    onClick={() => setManualSN(String(nextSerial))}
                  >
                    Set SN manually
                  </button>
                ) : (
                  <div className='lbl-prod-manual-sn'>
                    <div className='lbl-prod-manual-warn'>
                      Manual serial override — type any SN you want, any
                      characters, no spaces: 000042, S00001, AB-09. It prints
                      exactly as typed, and the batch counts up on the digits at
                      the end (S00001 → S00002). Independent of the machine
                      ranges — only a plain 6-digit SN inside a range moves that
                      machine&apos;s counter. Printing an already used SN again
                      is allowed — make sure duplicates are intentional.
                    </div>
                    <div className='lbl-prod-row-buttons'>
                      <input
                        className='lbl-prod-input lbl-prod-manual-input'
                        value={manualSN}
                        spellCheck={false}
                        autoCapitalize='characters'
                        onChange={(e) => {
                          setError('');
                          setAsk(null);
                          // Any character, any length — the client wants a free
                          // hand. Only whitespace is dropped, because the SN
                          // goes into the Data Matrix and a space breaks the scan.
                          setManualSN(
                            e.target.value.replace(/\s/g, '').toUpperCase(),
                          );
                        }}
                      />
                      <button
                        type='button'
                        className='lbl-prod-btn lbl-prod-btn--ghost'
                        onClick={() => {
                          setAsk(null);
                          setManualSN(null);
                        }}
                      >
                        Back to auto
                      </button>
                    </div>
                    {!manualValid && manualSN !== '' && (
                      <div className='lbl-prod-manual-warn'>
                        {manualParsed?.error ??
                          'Any characters except spaces — e.g. 000042, S00001 or AB-09.'}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className='lbl-prod-qty-row'>
                <label className='lbl-prod-field'>
                  <span>Pieces</span>
                  <input
                    className='lbl-prod-input'
                    type='number'
                    min='1'
                    max='500'
                    placeholder='80'
                    value={form.quantity}
                    onChange={setField('quantity')}
                  />
                </label>
                <label className='lbl-prod-field'>
                  <span>Repeats per piece</span>
                  <input
                    className='lbl-prod-input'
                    type='number'
                    min='1'
                    max='10'
                    value={form.repeats}
                    onChange={setField('repeats')}
                  />
                </label>
              </div>

              {/* R-10. The destination for this run. It carries NO button of
                its own: PRINT LABELS below is still the trigger, because the
                batch (and its serial numbers) must be created before there
                is anything to print, and only this page can do that. The
                browser-dialog button is hidden too - deliver() already falls
                back on its own, and a button that printed an empty sheet
                would be a trap. */}
              <PrintPanel
                ref={printPanelRef}
                pages={totalLabels}
                primaryLabel={null}
                browserLabel={null}
                title='Destination'
              />

              {/* The one red element on this screen: the single primary action.
                Nothing else in production.css spends the brand-red budget. */}
              <button
                type='button'
                className='lbl-prod-btn lbl-prod-btn--print'
                onClick={createAndPrint}
                disabled={busy || !totalLabels || !product}
              >
                {totalLabels
                  ? `PRINT ${totalLabels} LABELS (${qty} pcs × ${repeats})`
                  : 'PRINT LABELS'}
              </button>
              {confirmPanel('print')}
            </section>

            <section className='lbl-prod-right-col'>
              <div className='lbl-prod-card'>
                <h2 className='lbl-prod-card-title'>
                  Label preview — 70 × 50 mm
                </h2>
                <div className='lbl-prod-preview-frame'>
                  <Label_70 {...previewLabel} />
                </div>
                <div className='lbl-prod-matrix-check'>
                  Matrix code content: <b>{previewLabel.matrix}</b>
                </div>
              </div>

              <div className='lbl-prod-card'>
                <div className='lbl-prod-history-head'>
                  <h2 className='lbl-prod-card-title'>History</h2>
                  <span className='lbl-prod-history-actions'>
                    <button
                      type='button'
                      className='lbl-prod-btn lbl-prod-btn--ghost'
                      onClick={async () => {
                        setError('');
                        try {
                          const r = await api('/api/backup');
                          setNotice(`Backup saved: ${r.file}`);
                        } catch (e) {
                          setError(e.message);
                        }
                      }}
                    >
                      Backup DB
                    </button>
                    <a className='lbl-prod-button-link' href='/api/report.xlsx'>
                      Export Excel
                    </a>
                  </span>
                </div>
                {history.length === 0 && (
                  <p className='lbl-prod-muted'>Nothing printed yet.</p>
                )}
                {history.map((b) => (
                  <div key={b.id} className='lbl-prod-batch'>
                    <button
                      type='button'
                      className={
                        b.voided
                          ? 'lbl-prod-batch-row lbl-prod-batch-row--voided'
                          : 'lbl-prod-batch-row'
                      }
                      onClick={() => openBatch(b.id)}
                    >
                      <span className='lbl-prod-b-date'>
                        {b.printedAt?.slice(0, 16)}
                      </span>
                      <span className='lbl-prod-b-order'>
                        {b.orderNumber}
                        {b.voided && (
                          <em className='lbl-prod-void-tag'>VOIDED</em>
                        )}
                      </span>
                      <span className='lbl-prod-b-name'>
                        {b.product.name} · {b.product.producerNumber}
                      </span>
                      <span className='lbl-prod-b-qty'>
                        {b.quantity} pcs · SN {b.snFrom ?? fmtSN(b.serialFrom)}–
                        {b.snTo ?? fmtSN(b.serialTo)} · M{b.machine}
                      </span>
                    </button>
                    {expanded?.batch.id === b.id && (
                      <div className='lbl-prod-batch-detail'>
                        <div className='lbl-prod-serial-chips'>
                          {expanded.batch.labels.map((l) => (
                            <button
                              type='button'
                              key={l.serial}
                              className={
                                expanded.selected.has(l.serial)
                                  ? 'lbl-prod-chip lbl-prod-serial-chip lbl-prod-serial-chip--on'
                                  : 'lbl-prod-chip lbl-prod-serial-chip'
                              }
                              onClick={() => toggleSerial(l.serial)}
                            >
                              {l.sn ?? fmtSN(l.serial)}
                            </button>
                          ))}
                        </div>
                        <div className='lbl-prod-row-buttons'>
                          <label className='lbl-prod-copies'>
                            Copies:
                            <input
                              className='lbl-prod-input lbl-prod-copies-input'
                              type='number'
                              min='1'
                              max='10'
                              value={expanded.copies}
                              onChange={(e) => {
                                setAsk(null);
                                const { value } = e.target;
                                setExpanded((ex) => ({ ...ex, copies: value }));
                              }}
                            />
                          </label>
                          <button
                            type='button'
                            className='lbl-prod-btn'
                            onClick={reprint}
                          >
                            {expanded.selected.size
                              ? `Reprint selected (${expanded.selected.size})`
                              : 'Reprint all'}
                          </button>
                          <button
                            type='button'
                            className='lbl-prod-btn lbl-prod-btn--danger'
                            onClick={toggleVoid}
                          >
                            {expanded.batch.voided
                              ? 'Restore to report'
                              : 'Void (remove from Excel)'}
                          </button>
                          <button
                            type='button'
                            className='lbl-prod-btn lbl-prod-btn--danger'
                            onClick={deleteBatch}
                          >
                            Delete from history
                          </button>
                        </div>
                        {confirmPanel('reprint')}
                        {confirmPanel('void')}
                        {confirmPanel('delete')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </main>
        )}
      </div>

      {printJob && (
        <ProductionPrintSheet job={printJob} copies={printJob.copies ?? 1} />
      )}
    </>
  );
}
