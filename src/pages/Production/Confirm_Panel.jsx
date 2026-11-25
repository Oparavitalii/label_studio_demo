// The replacement for window.confirm(). Same contract — nothing destructive
// happens on one click — but it renders in the page, next to the control it
// guards, so it can be read by a screen reader and driven by a test.
//
// The pending action is held as a plain `kind` string plus plain payload data,
// never as a stored callback: a callback captured at ask-time goes stale the
// moment the form behind it changes, and this dialog guards the serial counter.
//
// Extracted from index.jsx so the NOK tab can use the same guard without
// importing the page that mounts it — a module cycle between a page and the tab
// it renders is the kind of thing that works until a build tool reorders it.
export default function ConfirmPanel({ ask, busy, onCancel, onConfirm }) {
  return (
    <div
      className='lbl-prod-confirm'
      role='alertdialog'
      aria-label={ask.title}
      data-confirm={ask.kind}
    >
      <div className='lbl-prod-confirm-title'>{ask.title}</div>
      {ask.lines.map((line, i) => (
        <p key={i} className='lbl-prod-confirm-text'>
          {line}
        </p>
      ))}
      <div className='lbl-prod-confirm-actions'>
        <button
          type='button'
          className={
            ask.danger
              ? 'lbl-prod-btn lbl-prod-btn--danger'
              : 'lbl-prod-btn lbl-prod-btn--ghost'
          }
          onClick={onConfirm}
          disabled={busy}
        >
          {ask.confirmLabel}
        </button>
        <button
          type='button'
          className='lbl-prod-btn lbl-prod-btn--ghost'
          onClick={onCancel}
        >
          Keep as is
        </button>
      </div>
    </div>
  );
}
