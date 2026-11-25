import logoUrl from '../../assets/Demo_Parts_Logo.svg';
// The wordmark ships as an imported ASSET, never as inline JSX. scripts/verify-style.mjs
// assertion 2 rejects any non-grey colour literal inside src/labels/components, and the
// brand accent lives inside this SVG. An asset file is not scanned; inline markup is.
//
// The SVG itself declares width="100%" height="100%", so it has no intrinsic size and
// MUST be constrained by whatever holds it - `.lbl-brand` in shell.css does that. The
// width/height attributes below are the 472x63 viewBox scaled to the nav lockup, and
// they only reserve the box before the file loads; CSS `width:auto` keeps the ratio.
export default function BrandMark({ className = '' }) {
  return (
    <img
      className={`lbl-brand ${className}`.trim()}
      src={logoUrl}
      width={160}
      height={21}
      alt='DEMO PARTS'
    />
  );
}
