// Pure presentational QR renderer. Generates a PNG data URL from `value`
// via the qrcode package and displays it as an <img>. Regeneration is
// gated on [value, sizePx] so an unrelated re-render of the parent (e.g.
// selection state changing) never re-runs the (async) encode.
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

const PLACEHOLDER_BOX = {
  display: 'block',
  boxSizing: 'border-box',
  background: '#f2f2f2',
  border: '1px dashed #c7c7c7',
};

export default function QrCode({ value, sizePx }) {
  const [dataUrl, setDataUrl] = useState(null);

  useEffect(() => {
    if (!value) {
      setDataUrl(null);
      return undefined;
    }

    let cancelled = false;

    QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 0 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [value, sizePx]);

  if (!value || !dataUrl) {
    return (
      <div
        style={{
          ...PLACEHOLDER_BOX,
          width: sizePx,
          height: sizePx,
          maxWidth: '100%',
          maxHeight: '100%',
        }}
      />
    );
  }

  return (
    <img
      src={dataUrl}
      alt='QR code'
      width={sizePx}
      height={sizePx}
      style={{
        // Fill the box and let object-fit keep the QR square. sizePx is
        // derived from PX_PER_MM = 8, a SCREEN constant; in print the box
        // is real millimetres (CSS: 1mm = 96/25.4 px), so a px-sized image
        // is 2.1167x too large. On screen this is identical (the box is
        // already sizePx); in print it now fits the mm box instead of
        // relying on the img{max-width:100%} reset in _global.css, which
        // caps width only and so let a wide box crop the QR vertically.
        display: 'block',
        width: '100%',
        height: '100%',
        objectFit: 'contain',
      }}
    />
  );
}
