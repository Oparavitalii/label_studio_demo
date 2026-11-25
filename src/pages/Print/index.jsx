// The headless render target: /print/:jobId
//
// This route exists for ONE reader - the headless Chrome that Server/print.js
// launches to turn a job into a PDF. It renders the print tree and nothing
// else: no nav, no toolbar, no panels. That is also why App.jsx mounts it
// OUTSIDE the AppShell layout route rather than inside it. print.css would
// hide the chrome at print time anyway, but "hidden" and "never rendered"
// are not the same promise, and this is the page whose output goes on a
// customer's pump at EUR 0.5 a label.
//
// THE READY MARKER
// Chrome will happily print the instant the DOM exists, and a Data Matrix
// that has not decoded yet prints as a white square. The production app
// worked around this with a blind 300 ms setTimeout before window.print().
// A marker is strictly better than a sleep: this page tells the server when
// it is genuinely finished by setting data-print-ready on <html>, and the
// server waits for that attribute instead of guessing. "Finished" means the
// expected number of .label-page elements exist AND every image inside the
// print root has decoded AND that has stayed true for a quiet period - the
// quiet period is what stops an asynchronously encoded QR from slipping in
// after the check passed but before the PDF was taken.
//
// The server also keeps its own timeout, so a job that never settles fails
// with a readable error instead of hanging the request.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import PrintSheet from '../../labels/components/PrintSheet.jsx';
import { pageCount } from '../../labels/model/counter.js';
import { rowCount } from '../../labels/model/dataset.js';
import '../../labels/styles/print.css';
import '../../labels/styles/tokens.css';
import { ProductionPrintSheet } from '../Production/index.jsx';
import NokPrintSheet from '../Production/Nok_Sheet.jsx';
import '../Production/production.css';

const READY_QUIET_MS = 250;
const POLL_MS = 50;

// Copied rather than exported from Production: six lines of pure string
// slicing, against importing a non-component out of a page module.
// "YYYY-MM-DD HH:MM:SS" -> "DD.MM.YY"
//
// It is also in src/pages/Production/dates.js now, which the Production page
// and its NOK tab share. This copy STAYS, deliberately: replacing it would
// rewrite the import block of the one file two concurrent branches both edit,
// and a merge conflict in the headless print route is a blank label. Six lines
// of duplication is the cheaper of the two costs — the same trade the original
// comment above already made.
function labelDate(printedAt) {
  const p = String(printedAt || '')
    .slice(0, 10)
    .split('-');
  if (p.length !== 3) return '';
  return `${p[2]}.${p[1]}.${p[0].slice(2)}`;
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(`Could not reach ${url}.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${url} failed (${res.status})`);
  return data;
}

function clampCopies(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export default function PrintTarget() {
  const { jobId } = useParams();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const job = await getJson(`/api/print/jobs/${jobId}`);
        const copies = clampCopies(job.copies);

        if (job.kind === 'creator') {
          if (cancelled) return;
          setDoc({
            kind: 'creator',
            copies,
            label: job.label,
            elements: Array.isArray(job.elements) ? job.elements : [],
            // The imported spreadsheet, if the job carried one. Without it
            // this render prints {Column} on every label.
            dataset: job.dataset ?? null,
          });
          return;
        }

        if (job.kind === 'production') {
          // READ-ONLY. This route never creates a batch and never allocates a
          // serial number; it renders what the print log already says.
          const { batch } = await getJson(`/api/batches/${job.batchId}`);
          if (cancelled) return;
          // batch.repeats is the per-label repetition the batch was created
          // with - exactly what Production itself prints. `copies` then
          // repeats that whole run, the way a print dialog's copies box does,
          // and ProductionPrintSheet applies it - the same component, so the
          // pages are the same pages.
          setDoc({
            kind: 'production',
            copies,
            job: {
              product: batch.product,
              orderNumber: batch.orderNumber,
              supplierCode: batch.supplierCode,
              dateStr: labelDate(batch.printedAt),
              labels: batch.labels.flatMap((l) =>
                Array.from({ length: batch.repeats }, () => l),
              ),
            },
          });
          return;
        }

        if (job.kind === 'nok') {
          // READ-ONLY, exactly like the production branch above: this route
          // never creates a NOK batch, it renders what the log already says.
          const { batch } = await getJson(`/api/nok-batches/${job.nokBatchId}`);
          if (cancelled) return;
          // A NOK run is one label repeated quantity × repeats times — every
          // label in it is identical, because a non-remanufactured part has no
          // serial number to vary. `copies` then repeats the whole run.
          //
          // It carries `labels` rather than a plain count so that the ready
          // marker's `expectedPages` — the `doc.job.labels.length * doc.copies`
          // arm below — needs no third case. That expression decides WHEN the
          // server is allowed to take the PDF, and getting it wrong does not
          // fail visibly: the page simply never reports ready and the job dies
          // on a timeout. Leaving it untouched is worth carrying an array of
          // repeats instead of an integer.
          setDoc({
            kind: 'nok',
            copies,
            job: {
              labels: Array.from(
                { length: batch.quantity * batch.repeats },
                (_, i) => i,
              ),
              orderNumber: batch.orderNumber,
              productName: batch.productName,
              producerNumber: batch.producerNumber,
              nokCode: batch.nokCode,
              gradeSerial: `${batch.nokCode}_${batch.grade}`,
              supplierCode: batch.supplierCode,
              dateStr: labelDate(batch.printedAt),
              matrix: batch.matrix,
            },
          });
          return;
        }

        throw new Error(`Unknown print job kind "${job.kind}".`);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // A failed job must fail LOUDLY and immediately: the server reads this
  // attribute and gives up rather than waiting out its full timeout on a page
  // that is never going to be ready.
  useEffect(() => {
    if (!error) return undefined;
    document.documentElement.setAttribute('data-print-error', error);
    return () => document.documentElement.removeAttribute('data-print-error');
  }, [error]);

  // This number and PrintSheet's own page list have to agree exactly. If it
  // is short, the server sees data-print-ready before the last labels exist
  // and prints a truncated run; if it is long, the ready marker is never set
  // and the job dies on the timeout instead of printing. It is the reason
  // rowCount is passed here and not only inside the sheet.
  const expectedPages = !doc
    ? 0
    : doc.kind === 'creator'
      ? pageCount(doc.elements, rowCount(doc.dataset)) * doc.copies
      : doc.job.labels.length * doc.copies;

  useEffect(() => {
    if (!doc || expectedPages < 1) return undefined;
    let cancelled = false;
    let timer = null;
    let signature = '';
    let stableSince = Date.now();

    const tick = () => {
      if (cancelled) return;
      const pages = document.querySelectorAll('.print-root .label-page').length;
      const images = Array.from(document.querySelectorAll('.print-root img'));
      const decoded = images.filter(
        (img) => img.complete && img.naturalWidth > 0,
      ).length;
      const now = Date.now();
      const next = `${pages}:${images.length}:${decoded}`;
      const settled = pages === expectedPages && decoded === images.length;

      if (!settled || next !== signature) {
        // Something is still moving - a page was added, an image finished
        // decoding, a QR appeared. Restart the quiet period.
        signature = next;
        stableSince = now;
      } else if (now - stableSince >= READY_QUIET_MS) {
        document.documentElement.setAttribute('data-print-ready', 'true');
        return;
      }
      timer = window.setTimeout(tick, POLL_MS);
    };

    tick();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      document.documentElement.removeAttribute('data-print-ready');
    };
  }, [doc, expectedPages]);

  if (error) {
    // Never printed - the server aborts on data-print-error - but a human who
    // opens this URL deserves to see why it is blank.
    return <p className='lbl-hint'>Print job failed: {error}</p>;
  }

  if (!doc) return <p className='lbl-hint'>Loading print job…</p>;

  // A NOK run renders through its own sheet. Handled BEFORE the creator /
  // production choice below rather than folded into it, so that choice stays
  // exactly the line it has always been - this is the file two branches edit
  // at once, and an insertion merges where a rewrite argues.
  if (doc.kind === 'nok') {
    return <NokPrintSheet job={doc.job} copies={doc.copies} />;
  }

  // From here the page renders the print tree and NOTHING else. Both sheets
  // portal themselves onto document.body, so what this returns is empty by
  // design.
  return doc.kind === 'creator' ? (
    <PrintSheet
      doc={{ label: doc.label, elements: doc.elements, dataset: doc.dataset }}
      copies={doc.copies}
    />
  ) : (
    <ProductionPrintSheet job={doc.job} copies={doc.copies} />
  );
}
