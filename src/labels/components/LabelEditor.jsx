// The editor shell, in the three columns the brief asks for:
//
//   LEFT  (.lbl-rail) - the six add-element tiles over the print panel.
//                       The wordmark was here too until R-03-a (25.08.2026):
//                       the owner saw it doubled against the nav mark and
//                       cut this one. The nav lockup carries the identity.
//   MID   (.lbl-main) - the canvas.
//   RIGHT (.lbl-side) - Properties: label size, placement, and the per-type
//                       fields (R-06 - everything the left side offers has
//                       its data edited on the right).
//
// Toolbar stays across the top because R-02 puts save/open there. Properties
// moved to the right by DOM ORDER ALONE - the component itself is untouched,
// and .lbl-side simply hangs its hairline off the other edge now.
//
// PrintSheet is mounted but invisible on screen (print.css keeps
// `.print-root` display:none until @media print) so window.print() always
// has the live document to render from wherever LabelEditor is mounted.
import { useCallback } from 'react';

import Canvas from './Canvas.jsx';
import DataPanel from './DataPanel.jsx';
import Palette from './Palette.jsx';
import PrintPanel from './PrintPanel.jsx';
import PrintSheet from './PrintSheet.jsx';
import Properties from './Properties.jsx';
import Toolbar from './Toolbar.jsx';
import { pageCount } from '../model/counter.js';
import { rowCount } from '../model/dataset.js';
import { useEditorStore } from '../store/editorStore.js';

export default function LabelEditor() {
  const elements = useEditorStore((state) => state.elements);
  const label = useEditorStore((state) => state.label);
  const dataset = useEditorStore((state) => state.dataset);

  // The document travels to the server as DATA. A fresh headless Chrome has
  // no zustand store to read, so the only way the printed PDF can be the
  // document on screen is to send the document itself - the imported
  // spreadsheet included, or the labels come out with {Column} printed on
  // them.
  const getJob = useCallback(
    () => ({ kind: 'creator', label, elements, dataset }),
    [label, elements, dataset],
  );

  // One page per row once a file is loaded, and the print panel says so
  // before anything is committed to stock.
  const pages = pageCount(elements, rowCount(dataset));

  return (
    <div className='lbl-root'>
      <Toolbar />
      <div className='lbl-body'>
        <div className='lbl-rail'>
          <Palette />
          {/* R-04: the print trigger lives under the palette. It is the one
              primary action on this screen, so it wears .lbl-btn--primary -
              the darkest control in a system with no accent colour. It does
              NOT wear the brand red: the brandbook allows one red element per
              screen and the wordmark already spends it, twice over. */}
          <PrintPanel
            pages={pages}
            getJob={getJob}
            primaryLabel='Print'
            title='Print'
          />
          {/* Under the print panel: the layout is drawn first, the data is
              loaded second, and the page total above updates the moment a
              file lands. */}
          <DataPanel />
        </div>
        <div className='lbl-main'>
          <Canvas />
        </div>
        <div className='lbl-side'>
          <Properties />
        </div>
      </div>
      <PrintSheet />
    </div>
  );
}
