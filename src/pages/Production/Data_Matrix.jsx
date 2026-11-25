// Our own copy of the production app's Data Matrix renderer, deliberately
// NOT shared with src/labels/components/DataMatrix.jsx. That one belongs to
// the label editor and has a different prop contract (`content`, sized to
// 100% of whatever millimetre box the element model gives it). This one
// carries the customer label's fixed 15 mm geometry. Importing across the two
// would couple the Production page to the editor's element model, so the
// duplication is the cheaper of the two costs.
//
// Copied from Label_Print/src/Data_Matrix.jsx, comment and
// all, because the comment is the reason the component exists in this shape:
//
//   Renders a real Data Matrix (same symbology as the customer's label) as a
//   high-resolution PNG <img>, not inline SVG — some label-printer drivers
//   silently drop vector graphics at print time, while a bitmap prints the
//   same everywhere. scale 20 ≈ 440 px for a typical code, ~745 dpi at 15 mm.
import * as bwip from 'bwip-js';
import { useMemo } from 'react';

// bwip-js ships both a namespace and a default export depending on how the
// bundler resolves its exports map; take whichever one carries toCanvas.
const toCanvas = bwip.toCanvas || bwip.default?.toCanvas;

export default function Data_Matrix({ text, sizeMm = 15 }) {
  const dataUrl = useMemo(() => {
    if (!text) return null;
    try {
      const canvas = document.createElement('canvas');
      toCanvas(canvas, { bcid: 'datamatrix', text, scale: 20, padding: 0 });
      return canvas.toDataURL('image/png');
    } catch (e) {
      console.error('DataMatrix render failed:', e);
      return null;
    }
  }, [text]);

  // A visible failure, never a blank box: an unencodable payload that
  // rendered as nothing would print as nothing, and nobody would notice
  // until the labels were already on the pumps.
  if (!dataUrl) return <div className='lbl-prod-dm-error'>DM ERROR</div>;

  return (
    <img
      className='lbl-prod-dm-box'
      style={{ width: `${sizeMm}mm`, height: `${sizeMm}mm` }}
      src={dataUrl}
      alt=''
    />
  );
}
