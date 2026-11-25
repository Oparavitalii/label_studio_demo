// The editor canvas: a stage sized in real pixels to the label's physical
// mm dimensions (PX_PER_MM * zoom), with every element dragged and resized
// through react-rnd. Rnd's controlled position/size are always derived from
// xMm/yMm/wMm/hMm via mmToPx, and every write back goes through pxToMm - the
// store only ever sees millimetres, never raw pixels.
import { useState } from 'react';
import { Rnd } from 'react-rnd';

import ElementView from './ElementView.jsx';
import { scaleCapMm } from '../model/elements.js';
import { fitTexts, resolveContent } from '../model/preview.js';
import { fitTextBoxMm } from '../model/textMetrics.js';
import { PX_PER_MM, mmToPx, pxToMm } from '../model/units.js';
import { useEditorStore } from '../store/editorStore.js';
import '../styles/editor.css';

// An edge/centre pair is "on guide" when it sits within this many mm of one
// of the label's own edges or centre. The guide is a visual aid only: it
// shows that an element has lined up, it never moves one.
const GUIDE_TOLERANCE_MM = 0.5;

// Positions are free - nothing is constrained to a grid - but they are kept
// to a tenth of a millimetre. That is finer than a 300dpi thermal head can
// resolve (0.085mm), so it rules out no layout at all; it only stops the
// Properties panel showing a dragged element at 12.34567890123 mm.
const round1 = (mm) => Math.round(mm * 10) / 10;
const MIN_SIZE_MM = 1;

// react-rnd names the grabbed handle; only these four scale the type.
const CORNER_DIRECTIONS = new Set([
  'topLeft',
  'topRight',
  'bottomLeft',
  'bottomRight',
]);

function matchingTargets(value, targets) {
  return targets.filter((t) => Math.abs(value - t) <= GUIDE_TOLERANCE_MM);
}

// Every mm value an element's own left/right/centre (or top/bottom/centre)
// can land on to be considered aligned with the label.
function guidesForRect(xMm, yMm, wMm, hMm, label) {
  const xTargets = [0, label.w / 2, label.w];
  const yTargets = [0, label.h / 2, label.h];

  const v = new Set([
    ...matchingTargets(xMm, xTargets),
    ...matchingTargets(xMm + wMm / 2, xTargets),
    ...matchingTargets(xMm + wMm, xTargets),
  ]);
  const h = new Set([
    ...matchingTargets(yMm, yTargets),
    ...matchingTargets(yMm + hMm / 2, yTargets),
    ...matchingTargets(yMm + hMm, yTargets),
  ]);

  return { v: [...v], h: [...h] };
}

export default function Canvas() {
  const elements = useEditorStore((state) => state.elements);
  const label = useEditorStore((state) => state.label);
  const zoom = useEditorStore((state) => state.zoom);
  const selectedId = useEditorStore((state) => state.selectedId);
  const dataset = useEditorStore((state) => state.dataset);
  const select = useEditorStore((state) => state.select);
  const updateElement = useEditorStore((state) => state.updateElement);

  const [guides, setGuides] = useState({ v: [], h: [] });

  const stageWidthPx = mmToPx(label.w, zoom);
  const stageHeightPx = mmToPx(label.h, zoom);
  const minSizePx = mmToPx(MIN_SIZE_MM, zoom);

  function handleStageMouseDown(event) {
    if (event.target === event.currentTarget) select(null);
  }

  function handleDrag(el, data) {
    const xMm = pxToMm(data.x, zoom);
    const yMm = pxToMm(data.y, zoom);
    setGuides(guidesForRect(xMm, yMm, el.wMm, el.hMm, label));
  }

  function handleDragStop(el, data) {
    setGuides({ v: [], h: [] });
    updateElement(el.id, {
      xMm: round1(pxToMm(data.x, zoom)),
      yMm: round1(pxToMm(data.y, zoom)),
    });
  }

  // The point size a live corner drag is heading for, or null. Kept in local
  // state rather than written to the store on every mousemove: the store is
  // wrapped in zundo, so a store write per frame would turn one drag into
  // dozens of undo steps. The commit happens once, on release.
  const [fontPreview, setFontPreview] = useState(null);

  function previewCapMm(el, direction, ref) {
    if (!CORNER_DIRECTIONS.has(direction)) return null;
    return scaleCapMm(el, round1(pxToMm(ref.offsetHeight, zoom)));
  }

  function handleResize(el, direction, ref) {
    const fontCapMm = previewCapMm(el, direction, ref);
    setFontPreview(fontCapMm === null ? null : { id: el.id, fontCapMm });
  }

  function handleResizeStop(el, direction, ref, position) {
    setFontPreview(null);

    const hMm = round1(pxToMm(ref.offsetHeight, zoom));
    const patch = {
      wMm: round1(pxToMm(ref.offsetWidth, zoom)),
      hMm,
      xMm: round1(pxToMm(position.x, zoom)),
      yMm: round1(pxToMm(position.y, zoom)),
    };

    // A CORNER drag scales the type with the box - pulling a text element
    // bigger makes its text bigger, which is what the gesture means. An
    // EDGE drag resizes the box alone, which is how you give existing text
    // more room without changing it. Both gestures are needed, so the
    // handle you grabbed decides which one you get.
    const fontCapMm = previewCapMm(el, direction, ref);
    if (fontCapMm !== null) {
      patch.fontCapMm = fontCapMm;
      // ...and then the frame settles onto the text at that size, instead
      // of keeping whatever rectangle the mouse happened to describe.
      const fitted = fitTextBoxMm(
        { ...el, fontCapMm },
        fitTexts({ ...el, fontCapMm }, dataset),
      );
      // Deliberately unclamped. See withFittedBox in editorStore.js: a box
      // bounded to the label cannot be placed hard against the edge, which
      // is a layout the owner needs.
      if (fitted) Object.assign(patch, fitted);
    }

    updateElement(el.id, patch);
  }

  return (
    <div className='labels-canvas-scroll'>
      <div
        className='labels-stage'
        style={{ width: stageWidthPx, height: stageHeightPx }}
        onMouseDown={handleStageMouseDown}
      >
        {guides.v.map((mm) => (
          <div
            key={`v-${mm}`}
            className='labels-guide labels-guide--v'
            style={{ left: mmToPx(mm, zoom) }}
          />
        ))}
        {guides.h.map((mm) => (
          <div
            key={`h-${mm}`}
            className='labels-guide labels-guide--h'
            style={{ top: mmToPx(mm, zoom) }}
          />
        ))}

        {elements.map((el) => (
          <Rnd
            key={el.id}
            size={{ width: mmToPx(el.wMm, zoom), height: mmToPx(el.hMm, zoom) }}
            position={{ x: mmToPx(el.xMm, zoom), y: mmToPx(el.yMm, zoom) }}
            /* No `bounds` on purpose. Confining elements to the stage looks
               tidy and makes two real layouts impossible: text sitting hard
               against the die line (the bound stops one pixel short of it),
               and anything deliberately bled past the edge. The paper does
               the clipping - .label-page is overflow:hidden - so nothing
               unprintable can reach a label either way. */
            minWidth={minSizePx}
            minHeight={minSizePx}
            enableResizing={el.id === selectedId}
            resizeHandleClasses={{
              topLeft: 'labels-handle',
              topRight: 'labels-handle',
              bottomLeft: 'labels-handle',
              bottomRight: 'labels-handle',
            }}
            style={{ zIndex: el.z }}
            className={
              el.id === selectedId
                ? 'labels-element labels-element--selected'
                : 'labels-element'
            }
            onMouseDown={() => select(el.id)}
            onDrag={(event, data) => handleDrag(el, data)}
            onDragStop={(event, data) => handleDragStop(el, data)}
            onResize={(event, direction, ref) =>
              handleResize(el, direction, ref)
            }
            onResizeStop={(event, direction, ref, delta, position) =>
              handleResizeStop(el, direction, ref, position)
            }
          >
            {/* Three overlays on the stored element, all so the canvas shows
                what will actually happen:
                  - a number element renders the first value it will PRINT,
                    not its raw {n} template;
                  - with a file imported, {Column} renders the FIRST ROW's
                    value, so the layout is judged against real data rather
                    than against the length of the token;
                  - mid-drag, the point size the corner is heading for, so
                    the type grows under the cursor rather than jumping when
                    the mouse is released.
                `driving` is deliberately empty: on the canvas a `{n}` inside
                a TEXT element stays written as {n}, because that element
                shows a different value on every page and the canvas is one
                page. */}
            <ElementView
              /* The canvas draws 1mm as PX_PER_MM*zoom pixels, so the text
                 has to be scaled by the same factor its box is. Without
                 this the type renders at absolute pt - 2.1167x too small
                 against a box measured in mm - and the canvas stops being
                 WYSIWYG for the one thing this editor mostly prints. */
              pxPerMm={PX_PER_MM * zoom}
              el={(() => {
                const preview =
                  fontPreview?.id === el.id
                    ? { fontCapMm: fontPreview.fontCapMm }
                    : null;
                const withPreview = preview ? { ...el, ...preview } : el;
                return {
                  ...withPreview,
                  content: resolveContent(withPreview, 0, [], dataset),
                };
              })()}
            />
          </Rnd>
        ))}
      </div>
    </div>
  );
}
