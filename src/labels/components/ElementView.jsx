// Pure presentational switch: given one element from the store, render the
// visual that matches its type. Sizing comes entirely from the parent Rnd
// box (width/height: 100%) - this component never reads xMm/yMm/wMm/hMm
// for its own box, it only fills whatever box Canvas.jsx (on screen) or
// PrintSheet.jsx (in print) already sized. The qr/barcode branches are the
// one exception: those renderers draw a real image/svg at a fixed pixel
// size, so they read el.wMm/el.hMm directly and convert via mmToPx rather
// than measuring the DOM (see the comment above QrContent for why).
// `matrix` is deliberately NOT in that exception: bwip-js draws the symbol
// at its own resolution and CSS scales the resulting <img> to 100% of the
// mm box, so no pixel number is ever computed for it - see DataMatrix.jsx.
// Rotation is the one transform every type shares, so it lives on the root
// wrapper rather than being repeated per branch.
import Barcode from './Barcode.jsx';
import DataMatrix from './DataMatrix.jsx';
import QrCode from './QrCode.jsx';
import {
  DEFAULT_CAP_MM,
  TEXT_LINE_HEIGHT,
  emMmFromCapMm,
} from '../model/textMetrics.js';
import { mmToPx } from '../model/units.js';

const ROOT_STYLE = {
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  overflow: 'hidden',
};

// The one place a point size becomes a rendered size, and the only place
// that can get WYSIWYG right for text.
//
// Boxes are sized in mm everywhere, but the canvas draws 1mm as PX_PER_MM
// (8) pixels while CSS resolves 1mm to 96/25.4 = 3.7795px. Rendering the
// font as an absolute `pt` therefore made canvas text 8/3.7795 = 2.1167x
// too SMALL inside its own box, while print - where the box really is
// physical - was correct. The two disagreed by exactly the constant that
// clipped a barcode in run 1, and the mismatch only became visible once
// the box started hugging the text.
//
// So: when a caller supplies pxPerMm (the canvas), convert the point size
// through millimetres into that caller's pixels. When none is supplied
// (print), emit the point size unchanged, because there the page IS
// physical and pt is already right.
function fontSizeCss(el, pxPerMm) {
  const family = el.fontFamily ?? 'Inter';
  const emMm = emMmFromCapMm(el.fontCapMm ?? DEFAULT_CAP_MM, family);
  if (emMm === null) return '0px';
  // Print gets real millimetres, because there the page IS physical. The
  // canvas gets the same height expressed in ITS pixels, because it draws
  // 1mm as pxPerMm rather than as CSS's 3.7795px.
  return pxPerMm ? `${emMm * pxPerMm}px` : `${emMm}mm`;
}

function TextContent({ el, pxPerMm }) {
  // A number element holds ONE value and must never break it across lines.
  // Wrapping is what turned 10 into a "1" with a "0" underneath it on a
  // 1..100 run, and a number split over two lines is unreadable to a human
  // and invisible to a scanner. Text elements keep wrapping, because a
  // multi-line caption is a legitimate text element - a wrapped number is
  // not a layout, it is a bug.
  const wraps = el.type !== 'number';

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent:
          el.align === 'center'
            ? 'center'
            : el.align === 'right'
              ? 'flex-end'
              : 'flex-start',
        fontFamily: el.fontFamily ?? 'Inter',
        fontSize: fontSizeCss(el, pxPerMm),
        textAlign: el.align ?? 'left',
        color: el.fill ?? '#000000',
        // Must stay in step with TEXT_LINE_HEIGHT in model/textMetrics.js:
        // that is the number the auto-fitted box height is computed from,
        // so if these two drift the frame stops matching its text.
        lineHeight: TEXT_LINE_HEIGHT,
        whiteSpace: wraps ? 'pre-wrap' : 'pre',
        wordBreak: wraps ? 'break-word' : 'normal',
        overflow: 'hidden',
      }}
    >
      {el.content}
    </div>
  );
}

function ImageContent({ el }) {
  if (!el.content) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: '#f2f2f2',
          border: '1px dashed #c7c7c7',
          boxSizing: 'border-box',
        }}
      />
    );
  }

  return (
    <img
      src={el.content}
      alt=''
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        display: 'block',
      }}
    />
  );
}

function RectContent({ el }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        background: el.fill ?? 'transparent',
        border: `${el.strokeMm ?? 0}mm solid ${el.stroke ?? 'transparent'}`,
      }}
    />
  );
}

function LineContent({ el }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: el.stroke ?? '#000000',
      }}
    />
  );
}

// QR and barcode renderers draw a real image/svg at a fixed pixel size, so
// filling their box needs a pixel size in hand. A DOM measurement
// (offsetWidth/ResizeObserver) reads 0 whenever the node sits inside a
// display:none subtree - exactly what print.css does with the whole editor
// chrome, and what PrintSheet.jsx's own .print-root is on screen - so it
// can never be used here. The model already carries the element's true
// size in millimetres (el.wMm/el.hMm), and mmToPx is the same conversion
// Canvas.jsx uses to size the on-screen box in the first place, so deriving
// the pixel size straight from the model reproduces exactly what the old
// DOM measurement returned on screen while also being correct when
// display:none makes the DOM unreadable.
function QrContent({ el }) {
  const sizePx = Math.max(1, Math.round(mmToPx(Math.min(el.wMm, el.hMm))));

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <QrCode value={el.content} sizePx={sizePx} />
    </div>
  );
}

function BarcodeContent({ el }) {
  const widthPx = Math.max(1, Math.round(mmToPx(el.wMm)));
  const heightPx = Math.max(1, Math.round(mmToPx(el.hMm)));

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Barcode
        value={el.content}
        format={el.barcodeFormat ?? 'CODE128'}
        widthPx={widthPx}
        heightPx={heightPx}
      />
    </div>
  );
}

export default function ElementView({ el, pxPerMm }) {
  let inner;
  switch (el.type) {
    case 'number':
    case 'text':
      inner = <TextContent el={el} pxPerMm={pxPerMm} />;
      break;
    case 'image':
      inner = <ImageContent el={el} />;
      break;
    case 'rect':
      inner = <RectContent el={el} />;
      break;
    case 'line':
      inner = <LineContent el={el} />;
      break;
    case 'qr':
      inner = <QrContent el={el} />;
      break;
    case 'barcode':
      inner = <BarcodeContent el={el} />;
      break;
    // Without this case `default: inner = null` renders a matrix element as
    // an invisible, un-selectable, silently blank box - on the canvas AND
    // on paper. A missing case here is not a missing feature, it is a
    // failure nobody can see.
    case 'matrix':
      inner = <DataMatrix content={el.content} />;
      break;
    default:
      inner = null;
  }

  return (
    <div style={{ ...ROOT_STYLE, transform: `rotate(${el.rot}deg)` }}>
      {inner}
    </div>
  );
}
