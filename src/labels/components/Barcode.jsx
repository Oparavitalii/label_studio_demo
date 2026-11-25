// Pure presentational 1D barcode renderer. Draws directly into a ref'd
// <svg> via JsBarcode. The svg node is never conditionally unmounted -
// only its content and an overlay flip - so the ref stays stable across
// value/format changes (JsBarcode redraws into the same live node).
import JsBarcode from 'jsbarcode';
import { useEffect, useRef, useState } from 'react';

export default function Barcode({ value, format, widthPx, heightPx }) {
  const svgRef = useRef(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    if (!value) {
      setInvalid(true);
      return;
    }

    try {
      JsBarcode(svg, value, {
        format,
        displayValue: false,
        margin: 0,
        width: 2,
        height: heightPx,
      });
      // JsBarcode sets its own width/height/viewBox on the svg node sized
      // to the barcode it just drew. Keep that intrinsic size as the
      // viewBox aspect, but let CSS (width/height 100% below) do the
      // LAYOUT from the element's millimetre box.
      //
      // The attributes must NOT drive layout: widthPx comes from
      // mmToPx at PX_PER_MM = 8, which is a SCREEN constant. In print the
      // box is real millimetres, where CSS resolves 1mm to 96/25.4 =
      // 3.7795px - so a px-sized svg overdrew by 8/3.7795 = 2.1167x and
      // was then clipped by .label-page{overflow:hidden}, leaving an
      // undecodable barcode on paper. An <img> escapes this via the
      // img{max-width:100%} reset in _global.css; an <svg> does not.
      // Keep whatever viewBox JsBarcode drew into - its coordinate system
      // is its own (module count x bar height), never widthPx x heightPx.
      // Only synthesise one if it left none, from the intrinsic attributes
      // it did set, before those attributes are dropped.
      if (!svg.getAttribute('viewBox')) {
        const iw = Number(svg.getAttribute('width')) || widthPx;
        const ih = Number(svg.getAttribute('height')) || heightPx;
        svg.setAttribute('viewBox', `0 0 ${iw} ${ih}`);
      }
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('preserveAspectRatio', 'none');
      setInvalid(false);
    } catch {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      setInvalid(true);
    }
  }, [value, format, widthPx, heightPx]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      <svg
        ref={svgRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
      {invalid && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--lbl-grey-1, #fafafa)',
            border: '1px dashed var(--lbl-danger, #b42318)',
            color: 'var(--lbl-danger, #b42318)',
            fontSize: 10,
            fontFamily: 'monospace',
            boxSizing: 'border-box',
          }}
        >
          invalid
        </div>
      )}
    </div>
  );
}
