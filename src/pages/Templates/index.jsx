import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import {
  TEMPLATES_CHANGED,
  deleteTemplate,
  duplicateTemplate,
  listTemplates,
} from '../../labels/model/storage.js';
import { useEditorStore } from '../../labels/store/editorStore.js';
import '../../labels/styles/templates.css';

// R-11: every saved template, visible, openable back into the Creator.
//
// The list is read from localStorage on mount and then kept live by TWO
// subscriptions, because one is not enough:
//
//   * TEMPLATES_CHANGED - storage.js fires it on every successful write, in
//     THIS tab. Without it a save made in the Creator would not reach a
//     Templates page that is already mounted.
//   * 'storage' - the native event, which the browser fires only in OTHER
//     tabs. Without it a second tab keeps showing a deleted template and
//     offers to open it.
//
// The preview below is deliberately its own small renderer rather than the
// editor's Canvas/ElementView: a card needs a picture, not a live editor
// with drag, resize, selection, barcode encoding and history attached.

const PT_TO_MM = 25.4 / 72;

// Fallbacks match createInitialState() in the store, so a template written
// without a label still previews at the house size instead of collapsing.
const FALLBACK_W = 70;
const FALLBACK_H = 20;

// Every type the element model can produce, in the order a breakdown reads
// best: what carries meaning first, decoration last. An unknown type is not
// an error here - it sorts last and still draws.
const TYPE_ORDER = [
  'text',
  'number',
  'qr',
  'barcode',
  'matrix',
  'image',
  'rect',
  'line',
];

// Types that print as machine-read art. There is nothing useful to draw at
// card scale, so they get a neutral block that shows position and size.
// `matrix` is listed even though the model may not define it yet: a code
// type drawn as its own literal content would be worse than a block.
const BLOCK_TYPES = new Set(['qr', 'barcode', 'matrix', 'image']);

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positive(value, fallback) {
  const n = num(value, fallback);
  return n > 0 ? n : fallback;
}

function elementsOf(template) {
  return Array.isArray(template?.elements) ? template.elements : [];
}

function formatSize(label) {
  const w = positive(label?.w, FALLBACK_W);
  const h = positive(label?.h, FALLBACK_H);
  return `${w} × ${h} mm`;
}

// An ISO timestamp is a storage format, not a UI. Rendered in the viewer's
// own locale, and defended against a corrupt value rather than printing
// "Invalid Date" onto the card.
function formatSavedAt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Saved date unknown';
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function savedAtMs(template) {
  const ms = new Date(template?.savedAt).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function breakdown(elements) {
  const counts = new Map();
  for (const el of elements) {
    const type = el && el.type ? el.type : 'other';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => {
      const ai = TYPE_ORDER.indexOf(a[0]);
      const bi = TYPE_ORDER.indexOf(b[0]);
      return (
        (ai === -1 ? TYPE_ORDER.length : ai) -
        (bi === -1 ? TYPE_ORDER.length : bi)
      );
    })
    .map(([type, count]) => `${count} ${type}`)
    .join(' · ');
}

function previewClass(type) {
  if (type === 'rect') return 'lbl-tpl-el lbl-tpl-el--rect';
  if (type === 'line') return 'lbl-tpl-el lbl-tpl-el--line';
  if (BLOCK_TYPES.has(type)) return 'lbl-tpl-el lbl-tpl-el--block';
  return 'lbl-tpl-el lbl-tpl-el--text';
}

// The label drawn to scale: one absolutely positioned box per element,
// every offset a percentage of the label's own millimetres, so the picture
// stays true at whatever width the grid gives the card. No colour is read
// off the element - the model stores literal hex fills, and this page keeps
// to the neutral tokens.
function TemplatePreview({ label, elements }) {
  const w = positive(label?.w, FALLBACK_W);
  const h = positive(label?.h, FALLBACK_H);
  const ordered = [...elements].sort((a, b) => num(a?.z, 0) - num(b?.z, 0));

  return (
    <div className='lbl-tpl-card__preview'>
      <div className='lbl-tpl-stage' style={{ aspectRatio: `${w} / ${h}` }}>
        {ordered.map((el, index) => {
          const type = el && el.type ? el.type : 'other';
          const rot = num(el?.rot, 0);
          const style = {
            left: `${(num(el?.xMm, 0) / w) * 100}%`,
            top: `${(num(el?.yMm, 0) / h) * 100}%`,
            width: `${(positive(el?.wMm, 1) / w) * 100}%`,
            height: `${(positive(el?.hMm, 0.4) / h) * 100}%`,
          };
          if (rot) style.transform = `rotate(${rot}deg)`;

          const isText =
            !BLOCK_TYPES.has(type) && type !== 'rect' && type !== 'line';
          if (isText) {
            // cqh against the stage, which container-type: size makes a
            // query container: 10pt on a 20mm label is 17.6% of its height
            // whatever the card is scaled to.
            const mm = num(el?.fontSizePt, 10) * PT_TO_MM;
            style.fontSize = `${((mm / h) * 100).toFixed(2)}cqh`;
            style.textAlign =
              el?.align === 'center' || el?.align === 'right'
                ? el.align
                : 'left';
          }

          return (
            <div
              key={el?.id ?? `${type}-${index}`}
              className={previewClass(type)}
              style={style}
            >
              {isText ? el?.content || '' : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  confirming,
  onConfirm,
  onCancel,
  onOpen,
  onDuplicate,
  onDelete,
}) {
  const elements = elementsOf(template);

  return (
    <article className='lbl-tpl-card'>
      <TemplatePreview label={template.label} elements={elements} />

      <div className='lbl-tpl-card__body'>
        <h2 className='lbl-tpl-card__name'>{template.name || 'Untitled'}</h2>
        <p className='lbl-tpl-card__meta'>{formatSavedAt(template.savedAt)}</p>
        <p className='lbl-tpl-card__meta'>
          {formatSize(template.label)} &nbsp;&middot;&nbsp;{' '}
          {elements.length === 1 ? '1 element' : `${elements.length} elements`}
        </p>
        {elements.length > 0 ? (
          <p className='lbl-tpl-card__types'>{breakdown(elements)}</p>
        ) : null}
      </div>

      {confirming ? (
        // Inline, in the card, never window.confirm: a native modal blocks
        // the page and wedges any automated run driving this UI.
        <div className='lbl-tpl-card__confirm'>
          <span className='lbl-tpl-card__confirm-text'>Delete for good?</span>
          <button
            type='button'
            className='lbl-btn lbl-btn--sm lbl-btn--danger'
            onClick={() => onDelete(template.id)}
          >
            Delete
          </button>
          <button
            type='button'
            className='lbl-btn lbl-btn--sm'
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className='lbl-tpl-card__actions'>
          <button
            type='button'
            className='lbl-btn lbl-btn--sm lbl-btn--primary'
            onClick={() => onOpen(template)}
          >
            Open in Creator
          </button>
          <button
            type='button'
            className='lbl-btn lbl-btn--sm'
            onClick={() => onDuplicate(template.id)}
          >
            Duplicate
          </button>
          <button
            type='button'
            className='lbl-btn lbl-btn--sm lbl-btn--danger'
            onClick={() => onConfirm(template.id)}
          >
            Delete
          </button>
        </div>
      )}
    </article>
  );
}

export default function Templates() {
  const navigate = useNavigate();
  const loadDoc = useEditorStore((state) => state.loadDoc);
  const [templates, setTemplates] = useState(() => listTemplates());
  const [confirmId, setConfirmId] = useState(null);

  const refresh = useCallback(() => {
    setTemplates(listTemplates());
    setConfirmId(null);
  }, []);

  useEffect(() => {
    // Re-read once on mount as well: the store may have changed between the
    // useState initialiser and this effect.
    setTemplates(listTemplates());

    const onChange = () => setTemplates(listTemplates());
    globalThis.addEventListener?.(TEMPLATES_CHANGED, onChange);
    globalThis.addEventListener?.('storage', onChange);
    return () => {
      globalThis.removeEventListener?.(TEMPLATES_CHANGED, onChange);
      globalThis.removeEventListener?.('storage', onChange);
    };
  }, []);

  const ordered = useMemo(
    () => [...templates].sort((a, b) => savedAtMs(b) - savedAtMs(a)),
    [templates],
  );

  const handleOpen = useCallback(
    (template) => {
      // loadDoc is the store's own entry point - it also migrates a legacy
      // document-level counter into a real number element, which is why the
      // template's `counter` is handed over with it rather than dropped.
      loadDoc({
        label: template.label,
        elements: elementsOf(template),
        counter: template.counter,
      });
      navigate('/creator');
    },
    [loadDoc, navigate],
  );

  const handleDuplicate = useCallback(
    (id) => {
      duplicateTemplate(id);
      refresh();
    },
    [refresh],
  );

  const handleDelete = useCallback(
    (id) => {
      deleteTemplate(id);
      refresh();
    },
    [refresh],
  );

  return (
    <section className='lbl-tpl'>
      <header className='lbl-tpl__head'>
        <h1 className='lbl-tpl__title'>Templates</h1>
        <p className='lbl-tpl__lead'>
          {ordered.length === 1
            ? '1 saved template'
            : `${ordered.length} saved templates`}
        </p>
      </header>

      {ordered.length === 0 ? (
        <div className='lbl-tpl-empty'>
          <p className='lbl-tpl-empty__text'>
            No templates are saved yet. Build a label in the Creator and use
            Save to keep it here.
          </p>
          <Link className='lbl-btn lbl-btn--primary lbl-tpl-link' to='/creator'>
            Go to the Creator
          </Link>
        </div>
      ) : (
        <div className='lbl-tpl__grid'>
          {ordered.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              confirming={confirmId === template.id}
              onConfirm={setConfirmId}
              onCancel={() => setConfirmId(null)}
              onOpen={handleOpen}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </section>
  );
}
