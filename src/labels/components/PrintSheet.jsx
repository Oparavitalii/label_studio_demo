// The print-only view of the label document. It never appears in the
// editor UI - print.css keeps `.print-root` at `display: none` on screen -
// and becomes the entire printed output once window.print() applies the
// @media print rules in that same file. One `.label-page` renders per
// page per counted value, or exactly one page when nothing counts, each
// sized to the label's own millimetre dimensions and holding every element
// positioned by its own xMm/yMm/wMm/hMm. Millimetres are the model's only
// unit, so there is no pixel conversion here: the same mm numbers
// Canvas.jsx turns into on-screen pixels via mmToPx are instead handed
// straight to CSS as `mm` units, and the browser maps them onto the
// physical page itself.
//
// `.print-root` is portaled straight onto `document.body` rather than
// rendered in place. That is what lets print.css's `body > * { display:
// none }` rule take the rest of the app's chrome fully out of flow for
// print: a `display: none` ancestor cannot be "un-hidden" by a display
// override on a nested descendant, so the print root has to sit as a
// direct child of body itself for its own, higher-specificity `.print-root
// { display: block }` rule to apply to it and to it alone.
//
// The physical page size is likewise carried at runtime rather than left
// to a hardcoded @page literal: this component renders its own <style>
// tag containing `@page { size: <label.w>mm <label.h>mm; margin: 0 }`, so
// whichever label size is live in the store is what the printed media
// actually becomes.
import { createPortal } from 'react-dom';

import ElementView from './ElementView.jsx';
import { drivingSequence, pageCount } from '../model/counter.js';
import { rowCount } from '../model/dataset.js';
import { resolveContent } from '../model/preview.js';
import { useEditorStore } from '../store/editorStore.js';
import '../styles/print.css';

// `doc` and `copies` are both OPTIONAL and both default to today's exact
// behaviour, because this component is the print pipeline the whole app
// prints through and scripts/verify-print.mjs asserts against it.
//
//   doc    - { label, elements } to print INSTEAD of the live store. The
//            server-side render target (src/pages/Print/index.jsx) runs in a
//            fresh headless Chrome that has no store, so the document has to
//            arrive as data. With no `doc` the store is still the source of
//            truth and nothing about the editor changes.
//   copies - repeats the WHOLE page list, the way a print dialog's "copies"
//            does: 2 pages x 3 copies is 1,2,1,2,1,2 in ONE PDF and ONE
//            spooler job. Deliberately not N separate submissions - a
//            partial failure there leaves half a run printed with no record
//            of where it stopped. Per-LABEL repetition is a different thing
//            and already exists as Production's `repeats`.
//
// `doc.dataset` travels the same road as `doc.elements` and for the same
// reason: the headless Chrome has no store, so the imported spreadsheet has
// to arrive as data or the printed labels are the ones with {Column} still
// written on them.
export default function PrintSheet({ doc, copies = 1 }) {
  const storeElements = useEditorStore((state) => state.elements);
  const storeLabel = useEditorStore((state) => state.label);
  const storeDataset = useEditorStore((state) => state.dataset);
  const elements = doc?.elements ?? storeElements;
  const label = doc?.label ?? storeLabel;
  const dataset = doc ? (doc.dataset ?? null) : storeDataset;
  const pages = pageCount(elements, rowCount(dataset));
  const driving = drivingSequence(elements);
  const runs = Math.max(1, Math.trunc(Number(copies)) || 1);

  // One flat list of page indexes, so the render below stays a single map and
  // the printed page ORDER is written down in one place instead of implied by
  // two nested loops.
  const pageIndexes = Array.from({ length: runs * pages }, (_, i) => i % pages);

  return createPortal(
    <div className='print-root'>
      <style>{`@page { size: ${label.w}mm ${label.h}mm; margin: 0; }`}</style>
      {pageIndexes.map((index, position) => (
        <div
          key={position}
          className='label-page'
          style={{ width: `${label.w}mm`, height: `${label.h}mm` }}
        >
          {elements.map((el) => (
            <div
              key={el.id}
              style={{
                position: 'absolute',
                left: `${el.xMm}mm`,
                top: `${el.yMm}mm`,
                width: `${el.wMm}mm`,
                height: `${el.hMm}mm`,
                zIndex: el.z,
              }}
            >
              <ElementView
                el={{
                  ...el,
                  content: resolveContent(el, index, driving, dataset),
                }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  );
}
