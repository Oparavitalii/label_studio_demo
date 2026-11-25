import { nanoid } from 'nanoid';
import { temporal } from 'zundo';
import { create } from 'zustand';

import { normaliseDataset, tokenColumns } from '../model/dataset.js';
import { createElement } from '../model/elements.js';
import { fitTexts } from '../model/preview.js';
import { capMmFromPt, fitTextBoxMm } from '../model/textMetrics.js';
import { DEFAULT_LABEL } from '../model/units.js';

// Only these two draw type, so only these two have a box that can hug it.
const SIZED_TEXT_TYPES = new Set(['text', 'number']);

// Changing any of these changes how much room the text needs. `counter` is in
// the list because the RANGE decides the widest value the box has to hold: a
// 1..9 element and a 1..100 element show the same first value and need
// different boxes. Leaving it out was half of why "10" printed as a 1 with a
// 0 underneath - the box was measured once, at 1..10, and never again.
const REFIT_KEYS = ['content', 'fontCapMm', 'fontFamily', 'counter'];

// Returns the element with its box resized to exactly hold its text, or the
// element untouched when there is nothing to measure with (Node, vitest) -
// never a guessed size.
//
// The fit is NOT clamped to the label, and the position is not corrected.
// An earlier version bounded both. The owner rejected it: clamping the box
// to the label means you can never place text hard against the edge, and
// pulling the origin back means the editor silently moves an element you
// just put somewhere deliberately. Overhang is a legitimate layout - text
// that runs past the die line, a number bled off the edge - and the paper
// does the clipping at print time, which is where clipping belongs.
function withFittedBox(el, dataset = null) {
  if (!SIZED_TEXT_TYPES.has(el.type)) return el;
  const box = fitTextBoxMm(el, fitTexts(el, dataset));
  return box ? { ...el, ...box } : el;
}

// The store's only shape of "fresh document" truth. A factory (not a shared
// constant) so reset() and loadDoc() never hand out object/array references
// that a later mutation could leak into a different call site.
function createInitialState() {
  return {
    elements: [],
    selectedId: null,
    // The imported spreadsheet: null until a file is loaded, and not part of
    // the document - see setDataset.
    dataset: null,
    // The one place the standard label size is written is units.js. A second
    // literal here is how the default and the preset list drift apart.
    label: { ...DEFAULT_LABEL },
    zoom: 1,
  };
}

// z is a plain incrementing counter: the next element always lands one above
// the current highest z, so "on top" never has to reason about gaps.
//
// z stays in the model even though the reorder buttons are gone. It is what
// decides which element draws on top where two overlap, on screen and on
// paper alike, and it is now settled purely by creation order: whatever was
// added last sits highest. Removing the field would not simplify anything -
// it would just make the stacking order undefined.
function nextZ(elements) {
  return elements.length ? Math.max(...elements.map((el) => el.z)) + 1 : 0;
}

export const useEditorStore = create(
  temporal(
    (set, get) => ({
      ...createInitialState(),

      addElement: (type) => {
        // A new text element arrives already hugging its text rather than
        // sitting in a 40x8mm box with three characters rattling around in
        // the corner of it.
        const element = withFittedBox(
          { ...createElement(type), z: nextZ(get().elements) },
          get().dataset,
        );
        set({ elements: [...get().elements, element], selectedId: element.id });
        return element.id;
      },

      updateElement: (id, patch) => {
        // The box tracks the text: change the content, the point size or the
        // family and the frame follows. But an explicit wMm/hMm in the patch
        // is a deliberate size - a drag of a side handle, or a typed value in
        // Properties - and it wins. Otherwise the two would fight, and the
        // one the owner just set by hand would be the one that lost.
        const sizedByHand = 'wMm' in patch || 'hMm' in patch;
        const changesText = REFIT_KEYS.some((k) => k in patch);

        const { dataset } = get();
        set({
          elements: get().elements.map((el) => {
            if (el.id !== id) return el;
            const next = { ...el, ...patch };
            return !sizedByHand && changesText
              ? withFittedBox(next, dataset)
              : next;
          }),
        });
      },

      removeElement: (id) => {
        const { elements, selectedId } = get();
        set({
          elements: elements.filter((el) => el.id !== id),
          selectedId: selectedId === id ? null : selectedId,
        });
      },

      duplicateElement: (id) => {
        const { elements } = get();
        const source = elements.find((el) => el.id === id);
        if (!source) return undefined;

        const clone = { ...source, id: nanoid(), z: nextZ(elements) };
        set({ elements: [...elements, clone], selectedId: clone.id });
        return clone.id;
      },

      select: (id) => set({ selectedId: id }),

      // Loading a file is not an edit to the document: it changes what the
      // labels SAY, not what the label IS. It is kept out of the undo history
      // (see the temporal options below) and out of saved templates - a
      // template is a layout, the spreadsheet is this afternoon's job.
      //
      // Every text box then re-hugs its text, because the widest value in the
      // file is what the box has to hold. Without this the boxes stay the size
      // the {Column} token needed and the imported values wrap - the same fault
      // as a 1..100 counter in a box measured for `1`.
      setDataset: (input) => {
        const dataset = normaliseDataset(input);
        set({
          dataset,
          elements: get().elements.map((el) => withFittedBox(el, dataset)),
        });
        return dataset;
      },

      clearDataset: () => {
        set({
          dataset: null,
          elements: get().elements.map((el) => withFittedBox(el, null)),
        });
      },

      setLabel: (patch) => set({ label: { ...get().label, ...patch } }),

      setZoom: (n) => set({ zoom: n }),

      loadDoc: (doc) => {
        const initial = createInitialState();
        const label = doc.label ?? initial.label;

        // Type size used to be a point size and is now the height of a capital
        // letter in millimetres. A template saved before the switch carries
        // fontSizePt and no fontCapMm; dropping it silently would render every
        // text element at the default size, so it is converted through the
        // font's real cap ratio and lands at the same size it was saved at.
        const elements = (doc.elements ?? initial.elements).map((el) => {
          if (el.fontCapMm != null || el.fontSizePt == null) return el;
          const fontCapMm = capMmFromPt(
            el.fontSizePt,
            el.fontFamily ?? 'Inter',
          );
          return fontCapMm === null ? el : { ...el, fontCapMm };
        });

        // A template saved before counting moved onto elements carries a
        // document-level `counter`. Discarding it silently is not harmless:
        // that counter is what resolved `{n}` inside the template's own text
        // and QR content, so the document would load fine and then print the
        // literal string "S/N {n}" - a visible token on the label and in the
        // scanned payload. Instead the old counter is MIGRATED into a real
        // number element, which restores both the page count and every `{n}`.
        let migratedId = null;
        const legacy = doc.counter;
        if (legacy && legacy.enabled) {
          const migrated = createElement('number');
          migrated.counter = {
            start: legacy.start ?? 1,
            end: legacy.end ?? 10,
            step: legacy.step ?? 1,
            pad: legacy.pad ?? 0,
            prefix: legacy.prefix ?? '',
            suffix: legacy.suffix ?? '',
          };
          // Parked in the bottom-left corner and pre-selected, so the change is
          // visible and movable rather than a surprise discovered on paper.
          migrated.xMm = 1;
          migrated.yMm = Math.max(1, label.h - migrated.hMm - 1);
          migrated.z = elements.length;
          elements.push(migrated);
          migratedId = migrated.id;
        }

        // A template is a layout and carries its own box sizes, so loading one
        // does NOT re-measure every element - that would overwrite a width the
        // owner set by hand. The exception is an element whose content names a
        // column: its box was saved hugging the literal "{Code}", and with a
        // file loaded it has to hug the values instead.
        const { dataset } = get();
        const fitted = dataset
          ? elements.map((el) =>
              tokenColumns(el.content).length ? withFittedBox(el, dataset) : el,
            )
          : elements;

        set({ elements: fitted, label, selectedId: migratedId });
      },

      reset: () => set(createInitialState()),
    }),
    {
      // Undo moves elements and changes the label. It does NOT unload the
      // spreadsheet: an imported file is not an edit to the document, and
      // parking 5,000 rows in every undo frame is a memory leak with a UI.
      // Named explicitly rather than by subtracting `dataset`: this list is
      // the document, and anything added to the store later has to be put on
      // it deliberately to become undoable.
      partialize: (state) => ({
        elements: state.elements,
        label: state.label,
        selectedId: state.selectedId,
        zoom: state.zoom,
      }),
    },
  ),
);
