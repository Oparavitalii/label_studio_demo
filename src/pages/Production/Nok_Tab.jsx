// Production → NOK tab.
//
// Labels for parts that came back and were NOT remanufactured. The customer's
// Logistics Supplier Manual, section 5. The rules this screen enforces, all of
// them from the manual rather than from taste:
//
//  - the customer code's first digit becomes 9, marking the part old;
//  - the serial number is replaced by "<9-code>_<GRADE>";
//  - the grade says what state the part is in: A functional-but-not-reman,
//    B minor damage, C major damage, N scrap;
//  - the Data Matrix reads /CODE/1/GRADE_SERIAL.
//
// THE ONE THING THIS SCREEN MUST NEVER DO is touch a serial number. A NOK part
// has none. Nothing here calls /api/batches, and the server keeps NOK rows in
// their own table for the same reason — see the schema comment in
// Server/index.js. If a future edit makes this tab allocate a serial, the
// machine counters start handing out numbers for parts that were never
// remanufactured, and those numbers are gone for good.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import ConfirmPanel from './Confirm_Panel.jsx';
import { labelDate, todayLabelDate } from './dates.js';
import Label_70_Nok from './Label_70_Nok.jsx';
import NokPrintSheet from './Nok_Sheet.jsx';
import PrintPanel from '../../labels/components/PrintPanel.jsx';

const GRADE_ORDER = ['A', 'B', 'C', 'N'];

// "In the datamatrix code, a change is made — the first digit of the customer
// code is replaced from '0' to '9'." Mirrors nokCodeOf() in Server/index.js;
// the server validates the value that actually gets stored, this one only fills
// the field in so the operator sees the code before printing.
function nokCodeOf(customerCode) {
  const code = String(customerCode ?? '').trim();
  return code.startsWith('0') ? `9${code.slice(1)}` : code;
}

// The catalogue stores names the way the OK label prints them — "REMAN INJ CR
// DELPHI". REMAN is precisely the claim a NOK label exists to deny, so it comes
// off. The manual's own example names a core "CORE TD VNT GARRETT"; the owner's
// photographed label reads plain "INJ CR DELPHI". The field stays editable, so
// either convention can be typed over this default.
function nokNameOf(name) {
  return String(name ?? '')
    .trim()
    .replace(/^REMAN\s+/i, '');
}

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

const EMPTY_FORM = {
  productId: '',
  orderNumber: '',
  grade: 'A',
  nokCode: '',
  productName: '',
  producerNumber: '',
  quantity: '',
  repeats: 2,
};

export default function Nok_Tab({ state, onError }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [history, setHistory] = useState([]);
  const [printJob, setPrintJob] = useState(null);
  const [confirmPrint, setConfirmPrint] = useState(null);
  const [ask, setAsk] = useState(null);
  const [expanded, setExpanded] = useState(null); // { batch, copies }
  const [busy, setBusy] = useState(false);
  const printJobRef = useRef(null);
  printJobRef.current = printJob;
  const printPanelRef = useRef(null);

  const grades = state.nokGrades || {};

  const refresh = useCallback(async () => {
    try {
      const { batches } = await api('/api/nok-batches?limit=200');
      setHistory(batches);
    } catch (e) {
      onError(e.message);
    }
  }, [onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Same delivery path as the OK tab: server print when a printer is chosen,
  // browser dialog when it is not, and either way the run ends at the "did all
  // labels print?" confirmation, because an operator looking at the physical
  // labels is the only real proof that anything came out.
  const deliver = useCallback(
    async (job) => {
      const panel = printPanelRef.current;
      if (job.deliveryFailed || !panel?.canServerPrint) {
        setPrintJob(job);
        return;
      }
      const copies = panel.copies ?? 1;
      const outcome = await panel.submit({
        kind: 'nok',
        nokBatchId: job.nokBatchId,
      });
      if (outcome.ok) {
        setConfirmPrint({ ...job, copies });
        return;
      }
      onError(`Print server: ${outcome.error}`);
      setConfirmPrint({ ...job, copies, deliveryFailed: true });
    },
    [onError],
  );

  useEffect(() => {
    const onAfter = () => {
      if (!printJobRef.current) return;
      setConfirmPrint(printJobRef.current);
      setPrintJob(null);
      refresh();
    };
    window.addEventListener('afterprint', onAfter);
    return () => window.removeEventListener('afterprint', onAfter);
  }, [refresh]);

  useEffect(() => {
    if (!printJob) return undefined;
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, [printJob]);

  const setField = (key) => (e) => {
    onError('');
    setAsk(null);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  // Choosing a product fills the three label fields and the 9-code, and then
  // gets out of the way — every one of them stays editable, because the customer
  // sends the graded label data by e-mail and it does not always match what the
  // catalogue holds for the remanufactured part.
  const chooseProduct = (e) => {
    onError('');
    setAsk(null);
    const id = e.target.value;
    const p = state.products.find((x) => x.id === Number(id));
    setForm((f) => ({
      ...f,
      productId: id,
      nokCode: p ? nokCodeOf(p.customerCode) : '',
      productName: p ? nokNameOf(p.name) : '',
      producerNumber: p ? p.producerNumber : '',
    }));
  };

  const qty = Number(form.quantity);
  const repeats = Number(form.repeats);
  const totalLabels = qty > 0 && repeats > 0 ? qty * repeats : 0;
  const nokCode = form.nokCode.trim().toUpperCase();
  const codeLooksWrong = nokCode !== '' && !nokCode.startsWith('9');

  const preview = useMemo(() => {
    const code = nokCode || '900-000-000000R';
    return {
      name: form.productName.trim().toUpperCase() || 'PRODUCT NAME',
      producerNumber: form.producerNumber.trim().toUpperCase() || 'PRODUCER NO',
      orderNumber: form.orderNumber.trim() || 'ORDER NO',
      gradeSerial: `${code}_${form.grade}`,
      supplierCode: state.supplierCode,
      nokCode: code,
      dateStr: todayLabelDate(),
      matrix: `/${code}/1/${code}_${form.grade}`,
    };
  }, [form, nokCode, state.supplierCode]);

  const commitPrint = async () => {
    setAsk(null);
    setConfirmPrint(null);
    setBusy(true);
    try {
      const { batch } = await api('/api/nok-batches', {
        method: 'POST',
        body: {
          productId: form.productId || null,
          orderNumber: form.orderNumber.trim(),
          grade: form.grade,
          nokCode,
          productName: form.productName.trim(),
          producerNumber: form.producerNumber.trim(),
          quantity: qty,
          repeats,
        },
      });
      setForm((f) => ({ ...f, quantity: '' }));
      await deliver(jobOf(batch, `NOK order ${batch.orderNumber}`));
      refresh();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const createAndPrint = () => {
    if (printJob || busy) return;
    onError('');
    if (!form.orderNumber.trim()) return onError('Enter the order number.');
    if (!nokCode)
      return onError('Enter the NOK code (the code starting with 9).');
    if (!form.productName.trim()) return onError('Enter the product name.');
    if (!form.producerNumber.trim())
      return onError('Enter the producer number.');
    if (!(qty >= 1)) return onError('Enter how many pieces to label.');

    // Two clicks, never one, for the grade — it is the one field on this label
    // that no later check can catch. A wrong grade prints a scrap part as
    // fully functional, and the label is already on the pallet by the time
    // anyone reads it.
    return setAsk({
      kind: 'nok-print',
      title: `Print ${totalLabels} NOK label(s), grade ${form.grade}`,
      lines: [
        `Grade ${form.grade} — ${grades[form.grade] || 'unknown grade'}.`,
        `Code ${nokCode}, grade serial ${nokCode}_${form.grade}.`,
        `Matrix: /${nokCode}/1/${nokCode}_${form.grade}`,
        'These labels carry NO serial number — no machine counter moves.',
      ],
      confirmLabel: `Print ${totalLabels} label(s)`,
      danger: false,
    });
  };

  const openBatch = async (id) => {
    setAsk(null);
    if (expanded?.batch.id === id) return setExpanded(null);
    try {
      const { batch } = await api(`/api/nok-batches/${id}`);
      setExpanded({ batch, copies: 1 });
    } catch (e) {
      onError(e.message);
    }
  };

  const commitReprint = (payload) => {
    setAsk(null);
    setConfirmPrint(null);
    const { batch, perLabel } = payload;
    setPrintJob(
      jobOf(batch, `REPRINT NOK order ${batch.orderNumber}`, perLabel),
    );
  };

  const reprint = () => {
    if (printJob || busy) return;
    const { batch, copies } = expanded;
    if (batch.voided) {
      onError(
        'This NOK run is VOIDED — it is flagged in the Excel report. Restore it first, then reprint.',
      );
      return;
    }
    const perLabel = Math.min(10, Math.max(1, Math.trunc(Number(copies)) || 1));
    const count = batch.quantity * batch.repeats * perLabel;
    setAsk({
      kind: 'nok-reprint',
      title: `Reprint NOK order ${batch.orderNumber}, ${perLabel}× the run`,
      lines: [
        `Grade ${batch.grade}, code ${batch.nokCode}. ${count} label(s).`,
        'Identical to what was printed — a NOK label has no serial to change.',
      ],
      confirmLabel: `Reprint ${count} label(s)`,
      danger: false,
      payload: { batch, perLabel },
    });
  };

  const commitVoid = async () => {
    setAsk(null);
    const { batch } = expanded;
    try {
      const { batch: fresh } = await api(`/api/nok-batches/${batch.id}/void`, {
        method: 'POST',
        body: { voided: !batch.voided },
      });
      setExpanded((ex) =>
        ex && ex.batch.id === fresh.id ? { ...ex, batch: fresh } : ex,
      );
      if (fresh.voided) {
        setConfirmPrint((c) => (c && c.nokBatchId === fresh.id ? null : c));
      }
      refresh();
    } catch (e) {
      onError(e.message);
    }
  };

  const toggleVoid = () => {
    const { batch } = expanded;
    setAsk(
      batch.voided
        ? {
            kind: 'nok-void',
            title: `Restore NOK run (order ${batch.orderNumber}, ${batch.nokCode}_${batch.grade})`,
            lines: ['It stops being flagged as voided in the Excel report.'],
            confirmLabel: 'Restore',
            danger: false,
          }
        : {
            kind: 'nok-void',
            title: `Void NOK run (order ${batch.orderNumber}, ${batch.nokCode}_${batch.grade})`,
            lines: [
              'It stays on the NOK sheet of the Excel report, flagged VOIDED.',
              'Void only runs that were never physically printed.',
            ],
            confirmLabel: 'Void this run',
            danger: true,
          },
    );
  };

  const commitDelete = async () => {
    setAsk(null);
    const { batch } = expanded;
    try {
      await api(`/api/nok-batches/${batch.id}`, { method: 'DELETE' });
      setExpanded(null);
      setConfirmPrint((c) => (c && c.nokBatchId === batch.id ? null : c));
      refresh();
    } catch (e) {
      onError(e.message);
    }
  };

  const deleteBatch = () => {
    const { batch } = expanded;
    setAsk({
      kind: 'nok-delete',
      title: `DELETE NOK run (order ${batch.orderNumber}, ${batch.nokCode}_${batch.grade})`,
      lines: [
        'It disappears completely — from the app AND the Excel report.',
        'This cannot be undone.',
      ],
      confirmLabel: 'Delete permanently',
      danger: true,
    });
  };

  const runAsk = () => {
    if (!ask) return;
    if (ask.kind === 'nok-print') commitPrint();
    else if (ask.kind === 'nok-reprint') commitReprint(ask.payload);
    else if (ask.kind === 'nok-void') commitVoid();
    else if (ask.kind === 'nok-delete') commitDelete();
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

  return (
    <>
      {confirmPrint && (
        <div className='lbl-prod-banner lbl-prod-banner--ask'>
          <span>
            Did all <b>{confirmPrint.count * (confirmPrint.copies ?? 1)}</b> NOK
            labels for order <b>{confirmPrint.orderNumber}</b> print correctly?
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
                deliver(job);
              }}
            >
              Print again
            </button>
          </span>
        </div>
      )}

      <main className='lbl-prod-layout'>
        <section className='lbl-prod-card'>
          <h2 className='lbl-prod-card-title'>Print NOK labels</h2>
          <p className='lbl-prod-muted lbl-prod-nok-intro'>
            For parts that were <b>not</b> remanufactured. The customer
            code&apos;s first digit becomes <b>9</b>, and the serial number is
            replaced by the code plus the grade letter.
          </p>

          <label className='lbl-prod-field'>
            <span>Product (fills the fields below — all still editable)</span>
            <select
              className='lbl-prod-select'
              value={form.productId}
              onChange={chooseProduct}
            >
              <option value=''>— select product —</option>
              {state.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.producerNumber} — {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className='lbl-prod-field'>
            <span>
              NOK code (customer code with the first digit changed to 9)
            </span>
            <input
              className='lbl-prod-input'
              placeholder='901-002-000101R'
              value={form.nokCode}
              onChange={setField('nokCode')}
            />
          </label>
          {codeLooksWrong && (
            <div className='lbl-prod-manual-warn'>
              A NOK code starts with <b>9</b>. &quot;{nokCode}&quot; looks like
              the code for the remanufactured part — printing it would mark a
              scrap part as repaired.
            </div>
          )}

          <label className='lbl-prod-field'>
            <span>Product name (without REMAN)</span>
            <input
              className='lbl-prod-input'
              placeholder='INJ CR DELPHI'
              value={form.productName}
              onChange={setField('productName')}
            />
          </label>

          <label className='lbl-prod-field'>
            <span>Producer number</span>
            <input
              className='lbl-prod-input'
              placeholder='1000200301'
              value={form.producerNumber}
              onChange={setField('producerNumber')}
            />
          </label>

          <label className='lbl-prod-field'>
            <span>Order number (from the customer&apos;s order)</span>
            <input
              className='lbl-prod-input'
              placeholder='4500012410'
              value={form.orderNumber}
              onChange={setField('orderNumber')}
            />
          </label>

          <div className='lbl-prod-field'>
            <span>Grade — the condition the customer assigned to the part</span>
            <div className='lbl-prod-grade-row'>
              {GRADE_ORDER.map((g) => (
                <button
                  type='button'
                  key={g}
                  className={
                    form.grade === g
                      ? 'lbl-prod-btn lbl-prod-grade lbl-prod-grade--active'
                      : 'lbl-prod-btn lbl-prod-grade'
                  }
                  onClick={() => {
                    setAsk(null);
                    setForm((f) => ({ ...f, grade: g }));
                  }}
                >
                  {g}
                </button>
              ))}
            </div>
            <div className='lbl-prod-serial-info'>
              {grades[form.grade] || '—'}
            </div>
          </div>

          <div className='lbl-prod-qty-row'>
            <label className='lbl-prod-field'>
              <span>Pieces</span>
              <input
                className='lbl-prod-input'
                type='number'
                min='1'
                max='500'
                placeholder='12'
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

          <PrintPanel
            ref={printPanelRef}
            pages={totalLabels}
            primaryLabel={null}
            browserLabel={null}
            title='Destination'
          />

          {/* Disabled on a code that does not start with 9, not merely warned
              about. The server refuses such a code too, so nothing wrong ever
              reaches paper either way — but without this the operator gets
              there by pressing PRINT, confirming, and only then reading a red
              error. On the one field where a mistake means a scrap part
              labelled as repaired, the button should not be pressable at
              all. */}
          <button
            type='button'
            className='lbl-prod-btn lbl-prod-btn--print'
            onClick={createAndPrint}
            disabled={busy || !totalLabels || codeLooksWrong}
          >
            {codeLooksWrong
              ? 'NOK CODE MUST START WITH 9'
              : totalLabels
                ? `PRINT ${totalLabels} NOK LABELS (${qty} pcs × ${repeats})`
                : 'PRINT NOK LABELS'}
          </button>
          {confirmPanel('nok-print')}
        </section>

        <section className='lbl-prod-right-col'>
          <div className='lbl-prod-card'>
            <h2 className='lbl-prod-card-title'>
              NOK label preview — 70 × 50 mm
            </h2>
            <div className='lbl-prod-preview-frame'>
              <Label_70_Nok {...preview} />
            </div>
            <div className='lbl-prod-matrix-check'>
              Matrix code content: <b>{preview.matrix}</b>
            </div>
          </div>

          <div className='lbl-prod-card'>
            <div className='lbl-prod-history-head'>
              <h2 className='lbl-prod-card-title'>NOK history</h2>
              <a className='lbl-prod-button-link' href='/api/report.xlsx'>
                Export Excel
              </a>
            </div>
            {history.length === 0 && (
              <p className='lbl-prod-muted'>No NOK labels printed yet.</p>
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
                    {b.voided && <em className='lbl-prod-void-tag'>VOIDED</em>}
                  </span>
                  <span className='lbl-prod-b-name'>
                    {b.productName} · {b.producerNumber}
                  </span>
                  <span className='lbl-prod-b-qty'>
                    {b.quantity} pcs · {b.nokCode}_{b.grade}
                  </span>
                </button>
                {expanded?.batch.id === b.id && (
                  <div className='lbl-prod-batch-detail'>
                    <div className='lbl-prod-matrix-check'>
                      Matrix: <b>{expanded.batch.matrix}</b>
                      <br />
                      Grade <b>{expanded.batch.grade}</b> —{' '}
                      {grades[expanded.batch.grade] || 'unknown grade'}
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
                        Reprint run
                      </button>
                      <button
                        type='button'
                        className='lbl-prod-btn lbl-prod-btn--danger'
                        onClick={toggleVoid}
                      >
                        {expanded.batch.voided
                          ? 'Restore in report'
                          : 'Void (flag in Excel)'}
                      </button>
                      <button
                        type='button'
                        className='lbl-prod-btn lbl-prod-btn--danger'
                        onClick={deleteBatch}
                      >
                        Delete from history
                      </button>
                    </div>
                    {confirmPanel('nok-reprint')}
                    {confirmPanel('nok-void')}
                    {confirmPanel('nok-delete')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>

      {printJob && (
        <NokPrintSheet job={printJob} copies={printJob.copies ?? 1} />
      )}
    </>
  );
}

// The print job for one stored NOK batch. `labels` is an array whose length is
// the run — quantity × repeats — and whose entries carry nothing, because every
// label in a NOK run is identical and there is no serial to vary. It is an
// array rather than an integer so this job has the SAME SHAPE as an OK one,
// which is what keeps the headless route's page-count arithmetic single-cased;
// src/pages/Print/index.jsx explains why that matters.
function jobOf(batch, title, perLabel = 1) {
  const count = batch.quantity * batch.repeats * perLabel;
  return {
    title,
    nokBatchId: batch.id,
    count,
    labels: Array.from({ length: count }, (_, i) => i),
    orderNumber: batch.orderNumber,
    productName: batch.productName,
    producerNumber: batch.producerNumber,
    nokCode: batch.nokCode,
    grade: batch.grade,
    gradeSerial: `${batch.nokCode}_${batch.grade}`,
    supplierCode: batch.supplierCode,
    dateStr: labelDate(batch.printedAt),
    matrix: batch.matrix,
  };
}
