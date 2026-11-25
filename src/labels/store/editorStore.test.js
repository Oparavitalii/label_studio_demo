import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from './editorStore.js';
import { drivingSequence, pageCount } from '../model/counter.js';

// Every test starts from the exact initial state with an empty undo/redo
// history, so no test can leak state or history into the next one.
beforeEach(() => {
  useEditorStore.getState().reset();
  useEditorStore.temporal.getState().clear();
});

describe('useEditorStore initial state', () => {
  it('matches the agreed shape exactly', () => {
    const { elements, selectedId, label, zoom } = useEditorStore.getState();

    expect({ elements, selectedId, label, zoom }).toEqual({
      elements: [],
      selectedId: null,
      label: { w: 60, h: 20 },
      zoom: 1,
    });
  });
});

describe('addElement', () => {
  it('adds a createElement(type) result and selects it', () => {
    const id = useEditorStore.getState().addElement('rect');
    const { elements, selectedId } = useEditorStore.getState();

    expect(elements).toHaveLength(1);
    expect(elements[0].id).toBe(id);
    expect(elements[0].type).toBe('rect');
    expect(selectedId).toBe(id);
  });

  it('assigns increasing z so each new element lands on top', () => {
    useEditorStore.getState().addElement('text');
    useEditorStore.getState().addElement('rect');
    useEditorStore.getState().addElement('line');
    const { elements } = useEditorStore.getState();

    expect(elements.map((el) => el.z)).toEqual([0, 1, 2]);
  });
});

describe('updateElement', () => {
  it('merges a patch into only the matching element', () => {
    const id = useEditorStore.getState().addElement('text');
    useEditorStore.getState().updateElement(id, { xMm: 12, content: 'Hi' });
    const el = useEditorStore.getState().elements[0];

    expect(el.xMm).toBe(12);
    expect(el.content).toBe('Hi');
    expect(el.yMm).toBe(2);
  });

  it('is a no-op for an id that does not exist', () => {
    useEditorStore.getState().addElement('text');
    useEditorStore.getState().updateElement('missing', { xMm: 99 });

    expect(useEditorStore.getState().elements[0].xMm).toBe(2);
  });
});

describe('removeElement', () => {
  it('removes the element and clears selectedId when it was selected', () => {
    const id = useEditorStore.getState().addElement('text');
    useEditorStore.getState().removeElement(id);
    const { elements, selectedId } = useEditorStore.getState();

    expect(elements).toHaveLength(0);
    expect(selectedId).toBeNull();
  });

  it('leaves selectedId untouched when removing a different element', () => {
    const keepId = useEditorStore.getState().addElement('text');
    const dropId = useEditorStore.getState().addElement('rect');
    useEditorStore.getState().select(keepId);
    useEditorStore.getState().removeElement(dropId);

    expect(useEditorStore.getState().selectedId).toBe(keepId);
    expect(useEditorStore.getState().elements).toHaveLength(1);
  });
});

describe('duplicateElement', () => {
  it('clones the element with a new id and a top z, and selects the clone', () => {
    const id = useEditorStore.getState().addElement('rect');
    const cloneId = useEditorStore.getState().duplicateElement(id);
    const { elements, selectedId } = useEditorStore.getState();

    expect(elements).toHaveLength(2);
    expect(cloneId).not.toBe(id);
    expect(selectedId).toBe(cloneId);

    const source = elements.find((el) => el.id === id);
    const clone = elements.find((el) => el.id === cloneId);
    expect(clone.z).toBeGreaterThan(source.z);
    expect(clone.type).toBe(source.type);
    expect(clone.xMm).toBe(source.xMm);
  });

  it('is a no-op for an id that does not exist', () => {
    useEditorStore.getState().duplicateElement('missing');
    expect(useEditorStore.getState().elements).toHaveLength(0);
  });
});

describe('select', () => {
  it('sets selectedId, including back to null to deselect', () => {
    const id = useEditorStore.getState().addElement('text');
    useEditorStore.getState().select(null);
    expect(useEditorStore.getState().selectedId).toBeNull();

    useEditorStore.getState().select(id);
    expect(useEditorStore.getState().selectedId).toBe(id);
  });
});

describe('setLabel / setZoom', () => {
  it('setLabel merges a patch into label', () => {
    useEditorStore.getState().setLabel({ w: 100 });
    expect(useEditorStore.getState().label).toEqual({ w: 100, h: 20 });
  });

  it('setZoom sets the value directly', () => {
    useEditorStore.getState().setZoom(2);
    expect(useEditorStore.getState().zoom).toBe(2);
  });
});

describe('loadDoc', () => {
  it('replaces elements/label and clears selectedId', () => {
    const staleId = useEditorStore.getState().addElement('text');
    useEditorStore.getState().select(staleId);

    const doc = {
      label: { w: 50, h: 25 },
      elements: [{ ...useEditorStore.getState().elements[0], id: 'loaded-1' }],
    };
    useEditorStore.getState().loadDoc(doc);
    const state = useEditorStore.getState();

    expect(state.label).toEqual({ w: 50, h: 25 });
    expect(state.elements).toHaveLength(1);
    expect(state.elements[0].id).toBe('loaded-1');
    expect(state.selectedId).toBeNull();
  });

  // The standard label became 60 x 20 in run 5. A template saved before that
  // still opens at the size it was saved at - the default moved, it did not
  // rewrite anyone's saved work.
  it('opens a template saved at the old 70 x 20 default at 70 x 20', () => {
    useEditorStore.getState().loadDoc({
      label: { w: 70, h: 20 },
      elements: [
        { id: 'old-1', type: 'text', content: 'Text', xMm: 1, yMm: 1 },
      ],
    });

    expect(useEditorStore.getState().label).toEqual({ w: 70, h: 20 });
  });

  // ...and a template that carries no label at all falls back to the standard
  // one, which is the number the preset list leads with.
  it('falls back to the 60 x 20 standard when a document carries no label', () => {
    useEditorStore.getState().loadDoc({ elements: [] });

    expect(useEditorStore.getState().label).toEqual({ w: 60, h: 20 });
  });
});

describe('reset', () => {
  it('restores the exact initial state', () => {
    useEditorStore.getState().addElement('text');
    useEditorStore.getState().setZoom(3);

    useEditorStore.getState().reset();
    const { elements, selectedId, label, zoom } = useEditorStore.getState();

    expect({ elements, selectedId, label, zoom }).toEqual({
      elements: [],
      selectedId: null,
      label: { w: 60, h: 20 },
      zoom: 1,
    });
  });
});

describe('undo / redo via zundo', () => {
  it('undo removes the just-added element', () => {
    useEditorStore.getState().addElement('text');
    expect(useEditorStore.getState().elements).toHaveLength(1);

    useEditorStore.temporal.getState().undo();
    expect(useEditorStore.getState().elements).toHaveLength(0);
  });

  it('redo re-applies the undone change', () => {
    useEditorStore.getState().addElement('text');
    useEditorStore.temporal.getState().undo();
    expect(useEditorStore.getState().elements).toHaveLength(0);

    useEditorStore.temporal.getState().redo();
    expect(useEditorStore.getState().elements).toHaveLength(1);
  });
});

describe('counting moved onto elements', () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    useEditorStore.temporal.getState().clear();
  });

  it('addElement("number") gives the element its own counter', () => {
    const id = useEditorStore.getState().addElement('number');
    const el = useEditorStore.getState().elements.find((e) => e.id === id);
    expect(el.type).toBe('number');
    expect(el.counter.start).toBe(1);
    expect(el.counter.end).toBe(10);
  });

  it('updateElement patches a counter without disturbing the rest', () => {
    const id = useEditorStore.getState().addElement('number');
    const before = useEditorStore.getState().elements.find((e) => e.id === id);
    useEditorStore
      .getState()
      .updateElement(id, { counter: { ...before.counter, end: 250 } });
    const after = useEditorStore.getState().elements.find((e) => e.id === id);
    expect(after.counter.end).toBe(250);
    expect(after.counter.start).toBe(1);
    expect(after.xMm).toBe(before.xMm);
  });

  it('there is no document-level counter and no setCounter action', () => {
    expect(useEditorStore.getState().counter).toBeUndefined();
    expect(useEditorStore.getState().setCounter).toBeUndefined();
  });

  // The real risk of this change: a template saved BEFORE counting moved
  // onto elements carries a document-level `counter`, and that counter is
  // what resolved {n} inside its text and QR content. Discarding it loads
  // the document fine and then prints the literal "S/N {n}" onto the label
  // and into the scanned payload. It is MIGRATED instead.
  it('migrates a legacy document counter into a real number element', () => {
    const legacy = {
      label: { w: 50, h: 30 },
      elements: [
        { id: 'x1', type: 'text', content: 'S/N {n}', xMm: 1, yMm: 1, z: 0 },
      ],
      counter: {
        enabled: true,
        start: 7,
        end: 9,
        step: 1,
        pad: 3,
        prefix: 'X',
      },
    };
    expect(() => useEditorStore.getState().loadDoc(legacy)).not.toThrow();

    const state = useEditorStore.getState();
    expect(state.label).toEqual({ w: 50, h: 30 });
    expect(state.counter).toBeUndefined();
    expect(state.elements).toHaveLength(2);

    const migrated = state.elements.find((el) => el.type === 'number');
    expect(migrated).toBeDefined();
    expect(migrated.counter).toEqual({
      start: 7,
      end: 9,
      step: 1,
      pad: 3,
      prefix: 'X',
      suffix: '',
    });
    // the old range still drives the run, so {n} in the text still resolves
    expect(pageCount(state.elements)).toBe(3);
    expect(drivingSequence(state.elements)).toEqual(['X007', 'X008', 'X009']);
    // pre-selected so the migration is visible, not discovered on paper
    expect(state.selectedId).toBe(migrated.id);
  });

  it('leaves a document alone when its legacy counter was disabled', () => {
    useEditorStore.getState().loadDoc({
      label: { w: 70, h: 20 },
      elements: [{ id: 'y1', type: 'text', content: 'plain', xMm: 1, yMm: 1 }],
      counter: { enabled: false, start: 1, end: 5, step: 1 },
    });
    const state = useEditorStore.getState();
    expect(state.elements).toHaveLength(1);
    expect(state.elements.some((el) => el.type === 'number')).toBe(false);
    expect(pageCount(state.elements)).toBe(1);
  });
});
