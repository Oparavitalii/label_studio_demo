// A real Data Matrix symbol, drawn by bwip-js into an offscreen canvas and
// handed to an <img> as a PNG data URL. The approach is lifted verbatim
// from the production app that already prints these labels for money
// (Label_Print/src/Data_Matrix.jsx): a bitmap, not inline
// SVG, because some label-printer drivers silently drop vector graphics at
// print time while a PNG prints the same everywhere. scale 20 draws the
// symbol far above print resolution (~745 dpi at 15 mm) so downscaling it
// to the element's box never loses a module.
//
// CRITICAL: nothing here computes a pixel size, and nothing here may.
// PX_PER_MM (units.js) is 8 and is a SCREEN constant; CSS resolves 1mm to
// 96/25.4 = 3.7795px, so feeding PX_PER_MM into the print tree draws a code
// 2.1167x oversize and clips it. The symbol is drawn at bwip-js's own
// resolution and CSS scales it to 100% of whatever millimetre box the
// element model already defines - on screen and on paper alike.
import * as bwip from 'bwip-js';
import { useMemo } from 'react';

// bwip-js ships both a namespace and a default export depending on how the
// bundler resolves its exports map; take whichever one actually carries
// toCanvas rather than assuming.
const toCanvas = bwip.toCanvas || bwip.default?.toCanvas;

// A visible failure, not a blank box. An empty or unencodable payload that
// rendered as nothing would print as nothing and nobody would notice until
// the labels were already on the pumps. Grey only - scripts/verify-style.mjs
// assertion 2 rejects any non-grey literal in this directory.
const ERROR_STYLE = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxSizing: 'border-box',
  background: '#f2f2f2',
  border: '1px solid #949494',
  color: '#141414',
  fontFamily: 'Inter, sans-serif',
  fontSize: '6pt',
  letterSpacing: '0.04em',
  textAlign: 'center',
  overflow: 'hidden',
};

export default function DataMatrix({ content }) {
  const dataUrl = useMemo(() => {
    if (!content) return null;
    try {
      const canvas = document.createElement('canvas');
      toCanvas(canvas, {
        bcid: 'datamatrix',
        text: content,
        scale: 20,
        padding: 0,
      });
      return canvas.toDataURL('image/png');
    } catch (error) {
      console.error('DataMatrix render failed:', error);
      return null;
    }
  }, [content]);

  if (!dataUrl) return <div style={ERROR_STYLE}>DM ERROR</div>;

  return (
    <img
      src={dataUrl}
      alt=''
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}
