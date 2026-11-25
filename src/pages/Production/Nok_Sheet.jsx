import { createPortal } from 'react-dom';

import Label_70_Nok from './Label_70_Nok.jsx';

// The physical label, and therefore the physical page. 70×50 mm is the same
// customer contract the OK label answers to — section 5 changes the CONTENT of
// the label, never its size.
const PAGE_W_MM = 70;
const PAGE_H_MM = 50;

// The printed document for a NOK run, portaled out of the page and onto
// document.body so print.css's `body > * { display: none }` cannot swallow it.
// Same technique, and same reasons, as ProductionPrintSheet in index.jsx — read
// note 2 at the top of that file before changing anything here.
//
// The `@page` size is emitted at runtime rather than written into
// production.css. A stylesheet @page is global and cannot vary, and Creator
// mounts its own PrintSheet with its own @page for whatever size the editor
// holds. Only one route — and, inside Production, only one TAB — is mounted at
// a time, so exactly one @page rule ever exists. Two of them in one document
// would silently fight, and the loser is a mis-sized physical label.
//
// Lives in its own module rather than beside the tab UI because
// src/pages/Print/index.jsx imports it: the headless render target must produce
// BYTE-IDENTICAL pages to the ones the tab prints, and importing the sheet from
// the tab would drag the whole form, its history list and its fetches into the
// print bundle.
//
// A NOK batch has ONE label repeated `quantity × repeats` times — every label in
// the run is identical, because there is no serial number to vary. `copies`
// then repeats the whole run again, the way a print dialog's copies box does.
//
// The run arrives as `job.labels`, an array whose LENGTH is the only thing read
// off it, rather than as a plain count. That is the same shape
// ProductionPrintSheet takes, which is what lets src/pages/Print/index.jsx
// compute `expectedPages` for a NOK job without growing a third case — see the
// note there. Symmetry bought cheaply, in the file where a wrong page count
// means the PDF is taken before the Data Matrix has decoded.
export default function NokPrintSheet({ job, copies = 1 }) {
  const runs = Math.max(1, Math.trunc(Number(copies)) || 1);
  const pages = Array.from({ length: runs }, () => job.labels || []).flat();

  return createPortal(
    <div className='print-root'>
      <style>{`@page { size: ${PAGE_W_MM}mm ${PAGE_H_MM}mm; margin: 0; }`}</style>
      {pages.map((_, i) => (
        <div
          key={i}
          className='label-page'
          style={{ width: `${PAGE_W_MM}mm`, height: `${PAGE_H_MM}mm` }}
        >
          <Label_70_Nok
            name={job.productName}
            producerNumber={job.producerNumber}
            orderNumber={job.orderNumber}
            gradeSerial={job.gradeSerial}
            supplierCode={job.supplierCode}
            nokCode={job.nokCode}
            dateStr={job.dateStr}
            matrix={job.matrix}
          />
        </div>
      ))}
    </div>,
    document.body,
  );
}
