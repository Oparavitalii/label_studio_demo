import { beforeEach, describe, expect, it } from 'vitest';

import {
  FIT_SAMPLE_CAP,
  buildSequence,
  countLabels,
  drivingSequence,
  fitCandidates,
  numberElements,
  pageCount,
  valueAt,
} from './counter.js';
import { createElement, scaleCapMm } from './elements.js';
import {
  deleteTemplate,
  duplicateTemplate,
  listTemplates,
  loadTemplate,
  saveTemplate,
} from './storage.js';
import {
  CAP_MM_MAX,
  CAP_MM_MIN,
  DEFAULT_CAP_MM,
  capMmFromPt,
  emMmFromCapMm,
  fitTextBoxMm,
} from './textMetrics.js';
import { applyToken } from './tokens.js';
import { DEFAULT_LABEL, PX_PER_MM, mmToPx, pxToMm } from './units.js';

// ---------------------------------------------------------------------------
// units.js
// ---------------------------------------------------------------------------

describe('units', () => {
  it('exposes 8 pixels per millimetre and the default label size', () => {
    expect(PX_PER_MM).toBe(8);
    expect(DEFAULT_LABEL).toEqual({ w: 60, h: 20 });
  });

  it('mmToPx scales by PX_PER_MM and zoom', () => {
    expect(mmToPx(10)).toBe(80);
    expect(mmToPx(10, 2)).toBe(160);
    expect(mmToPx(0)).toBe(0);
  });

  it('pxToMm is the inverse of mmToPx', () => {
    expect(pxToMm(80)).toBe(10);
    expect(pxToMm(160, 2)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// counter.js
// ---------------------------------------------------------------------------

describe('counter', () => {
  it('builds the exact contract sequence (length 151, first entry BF-00100-A)', () => {
    const sequence = buildSequence({
      enabled: true,
      start: 100,
      end: 250,
      step: 1,
      pad: 5,
      prefix: 'BF-',
      suffix: '-A',
    });

    expect(sequence).toHaveLength(151);
    expect(sequence[0]).toBe('BF-00100-A');
    expect(sequence[sequence.length - 1]).toBe('BF-00250-A');
  });

  it('produces one label per number in the diapazon (R-11)', () => {
    const sequence = buildSequence({
      enabled: true,
      start: 1,
      end: 10,
      step: 1,
      pad: 0,
    });

    expect(sequence).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
    ]);
  });

  it('works for a descending range when step is negative', () => {
    const sequence = buildSequence({
      enabled: true,
      start: 5,
      end: 1,
      step: -1,
      pad: 0,
    });

    expect(sequence).toEqual(['5', '4', '3', '2', '1']);
  });

  it('treats pad 0 as no padding', () => {
    const sequence = buildSequence({
      enabled: true,
      start: 8,
      end: 8,
      step: 1,
      pad: 0,
      prefix: 'X',
    });

    expect(sequence).toEqual(['X8']);
  });

  it('zero-pads to N digits before prefix/suffix are applied', () => {
    const sequence = buildSequence({
      enabled: true,
      start: 7,
      end: 7,
      step: 1,
      pad: 3,
      prefix: 'ID-',
      suffix: '-Z',
    });

    expect(sequence).toEqual(['ID-007-Z']);
  });

  it('returns [] and never throws for an inverted range with a positive step', () => {
    expect(() =>
      buildSequence({ enabled: true, start: 10, end: 1, step: 1, pad: 0 }),
    ).not.toThrow();
    expect(
      buildSequence({ enabled: true, start: 10, end: 1, step: 1, pad: 0 }),
    ).toEqual([]);
  });

  it('returns [] and never throws for a zero step', () => {
    expect(() =>
      buildSequence({ enabled: true, start: 1, end: 10, step: 0, pad: 0 }),
    ).not.toThrow();
    expect(
      buildSequence({ enabled: true, start: 1, end: 10, step: 0, pad: 0 }),
    ).toEqual([]);
  });

  it('returns [] and never throws for non-integer bounds', () => {
    expect(() =>
      buildSequence({ enabled: true, start: 1.5, end: 10, step: 1, pad: 0 }),
    ).not.toThrow();
    expect(
      buildSequence({ enabled: true, start: 1.5, end: 10, step: 1, pad: 0 }),
    ).toEqual([]);
  });

  it('returns [] and never throws for missing/undefined input', () => {
    expect(() => buildSequence()).not.toThrow();
    expect(buildSequence()).toEqual([]);
    expect(() => buildSequence({ enabled: true })).not.toThrow();
    expect(buildSequence({ enabled: true })).toEqual([]);
  });

  it('returns [] when the counter is disabled', () => {
    expect(
      buildSequence({ enabled: false, start: 1, end: 10, step: 1, pad: 0 }),
    ).toEqual([]);
  });

  it('countLabels reports the sequence length', () => {
    const counter = {
      enabled: true,
      start: 100,
      end: 250,
      step: 1,
      pad: 5,
      prefix: 'BF-',
      suffix: '-A',
    };

    expect(countLabels(counter)).toBe(151);
    expect(countLabels({ enabled: false, start: 1, end: 10, step: 1 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// tokens.js
// ---------------------------------------------------------------------------

describe('tokens', () => {
  it('replaces every occurrence of {n} with the value', () => {
    expect(applyToken('SN-{n}-{n}', 42)).toBe('SN-42-42');
  });

  it('stringifies non-string values on substitution', () => {
    expect(applyToken('Item {n}', 7)).toBe('Item 7');
  });

  it('returns non-string content unchanged', () => {
    expect(applyToken(null, 5)).toBeNull();
    expect(applyToken(123, 5)).toBe(123);
    expect(applyToken(undefined, 5)).toBeUndefined();
  });

  it('returns content without a token identical', () => {
    expect(applyToken('no token here', 5)).toBe('no token here');
  });
});

// ---------------------------------------------------------------------------
// elements.js
// ---------------------------------------------------------------------------

describe('elements', () => {
  const types = ['text', 'image', 'rect', 'line', 'qr', 'barcode'];

  it.each(types)('createElement(%s) fits inside a 70x20mm label', (type) => {
    const el = createElement(type);
    expect(el.type).toBe(type);
    expect(el.xMm + el.wMm).toBeLessThanOrEqual(70);
    expect(el.yMm + el.hMm).toBeLessThanOrEqual(20);
  });

  it('gives each element a unique nanoid id', () => {
    const a = createElement('text');
    const b = createElement('text');
    expect(a.id).not.toBe(b.id);
    expect(typeof a.id).toBe('string');
    expect(a.id.length).toBeGreaterThan(0);
  });

  it('gives text elements sane font defaults', () => {
    const el = createElement('text');
    expect(el.fontFamily).toBe('Inter');
    expect(typeof el.fontCapMm).toBe('number');
    expect(el.content).toBe('Text');
  });

  it('gives qr and barcode elements a {n} token payload by default', () => {
    expect(createElement('qr').content).toBe('{n}');
    expect(createElement('barcode').content).toBe('{n}');
    expect(createElement('barcode').barcodeFormat).toBe('CODE128');
  });

  it('throws for an unknown element type', () => {
    expect(() => createElement('nope')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// storage.js
// ---------------------------------------------------------------------------

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

describe('storage', () => {
  beforeEach(() => {
    globalThis.localStorage = new MemoryLocalStorage();
  });

  it('lists no templates against a fresh store', () => {
    expect(listTemplates()).toEqual([]);
  });

  it('saves a template and lists it back', () => {
    const doc = { label: { w: 70, h: 20 }, elements: [], counter: null };
    const saved = saveTemplate('My Label', doc);

    expect(saved.id).toBeTruthy();
    expect(saved.name).toBe('My Label');
    expect(listTemplates()).toHaveLength(1);
  });

  it('loads a template by id', () => {
    const saved = saveTemplate('Loadable', {
      label: { w: 70, h: 20 },
      elements: [],
      counter: null,
    });

    const loaded = loadTemplate(saved.id);
    expect(loaded).toEqual(saved);
  });

  it('returns null when loading a missing template', () => {
    expect(loadTemplate('does-not-exist')).toBeNull();
  });

  it('duplicates a template under a new id', () => {
    const saved = saveTemplate('Original', {
      label: { w: 70, h: 20 },
      elements: [],
      counter: null,
    });

    const copy = duplicateTemplate(saved.id);
    expect(copy).not.toBeNull();
    expect(copy.id).not.toBe(saved.id);
    expect(copy.name).toBe('Original copy');
    expect(listTemplates()).toHaveLength(2);
  });

  it('returns null when duplicating a missing template', () => {
    expect(duplicateTemplate('does-not-exist')).toBeNull();
  });

  it('deletes a template by id', () => {
    const saved = saveTemplate('Deletable', {
      label: { w: 70, h: 20 },
      elements: [],
      counter: null,
    });

    expect(deleteTemplate(saved.id)).toBe(true);
    expect(listTemplates()).toEqual([]);
  });

  it('reports false when deleting a template that does not exist', () => {
    expect(deleteTemplate('does-not-exist')).toBe(false);
  });

  it('survives an absent localStorage without throwing', () => {
    delete globalThis.localStorage;

    expect(() => listTemplates()).not.toThrow();
    expect(listTemplates()).toEqual([]);

    expect(() =>
      saveTemplate('No Storage', {
        label: { w: 70, h: 20 },
        elements: [],
        counter: null,
      }),
    ).not.toThrow();
  });

  it('survives corrupt JSON already sitting in localStorage', () => {
    globalThis.localStorage.setItem('labelstudio.labels.v1', '{not valid json');

    expect(() => listTemplates()).not.toThrow();
    expect(listTemplates()).toEqual([]);

    expect(() =>
      saveTemplate('Recovers', {
        label: { w: 70, h: 20 },
        elements: [],
        counter: null,
      }),
    ).not.toThrow();
  });

  it('survives localStorage holding a non-array JSON value', () => {
    globalThis.localStorage.setItem(
      'labelstudio.labels.v1',
      JSON.stringify({ not: 'an array' }),
    );

    expect(listTemplates()).toEqual([]);
  });
});

// --- counting per element -------------------------------------------------
// The maths above is unchanged; these cover the layer that decides how many
// pages print and what each element shows on page N.

const num = (counter) => ({ type: 'number', counter });
const SHORT = num({
  start: 1,
  end: 50,
  step: 1,
  pad: 0,
  prefix: '',
  suffix: '',
});
const LONG = num({
  start: 100,
  end: 250,
  step: 1,
  pad: 5,
  prefix: 'BF-',
  suffix: '-A',
});

describe('numberElements', () => {
  it('picks only number elements, in array order', () => {
    const els = [{ type: 'text' }, SHORT, { type: 'qr' }, LONG];
    expect(numberElements(els)).toEqual([SHORT, LONG]);
  });

  it('tolerates a missing or non-array input', () => {
    expect(numberElements(undefined)).toEqual([]);
    expect(numberElements(null)).toEqual([]);
  });
});

describe('pageCount', () => {
  it('is 1 when nothing counts - the contract says no number element prints one label', () => {
    expect(pageCount([{ type: 'text' }, { type: 'qr' }])).toBe(1);
    expect(pageCount([])).toBe(1);
  });

  it('is the LONGEST range, which is the contract worked example', () => {
    expect(pageCount([SHORT, LONG])).toBe(151);
    expect(pageCount([LONG, SHORT])).toBe(151);
  });

  it('never drops below 1 even when every range is invalid', () => {
    expect(pageCount([num({ start: 5, end: 1, step: 1 })])).toBe(1);
    expect(pageCount([num({ start: 1, end: 10, step: 0 })])).toBe(1);
  });
});

// The 1..100 bug, at the level it was actually caused: the box used to be
// measured against the first value of the range and nothing else, so `1` set
// the width and `10` had nowhere to go but a second line.
describe('fitCandidates', () => {
  it('offers the LONGEST value of the range, not the first', () => {
    expect(fitCandidates(num({ start: 1, end: 100, step: 1 }))).toEqual([
      '100',
    ]);
  });

  it('offers every value when they are all the same length', () => {
    expect(fitCandidates(num({ start: 1, end: 9, step: 1 }))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
  });

  it('keeps prefix, suffix and padding, because they take room too', () => {
    expect(
      fitCandidates(
        num({
          start: 8,
          end: 11,
          step: 1,
          pad: 4,
          prefix: 'BF-',
          suffix: '-A',
        }),
      ),
    ).toEqual(['BF-0008-A', 'BF-0009-A', 'BF-0010-A', 'BF-0011-A']);
  });

  it('fills the element content template, not the bare number', () => {
    const el = { ...num({ start: 1, end: 100, step: 1 }), content: 'S/N {n}' };
    expect(fitCandidates(el)).toEqual(['S/N 100']);
  });

  it('caps the sample so a huge range cannot stall the editor', () => {
    // 100000..200000 is 100,001 values that are ALL six digits long, so the
    // longest-value filter removes none of them and only the cap can.
    const many = fitCandidates(num({ start: 100000, end: 200000, step: 1 }));
    expect(many).toHaveLength(FIT_SAMPLE_CAP);
    expect(many[0]).toBe('100000');
  });

  it('narrows a 1..100000 range to the single widest value', () => {
    expect(fitCandidates(num({ start: 1, end: 100000, step: 1 }))).toEqual([
      '100000',
    ]);
  });

  it('is empty for a range with no values at all', () => {
    expect(fitCandidates(num({ start: 5, end: 1, step: 1 }))).toEqual([]);
    expect(fitCandidates({ type: 'text' })).toEqual([]);
  });
});

describe('valueAt', () => {
  it('returns the element own value, not the driving one', () => {
    expect(valueAt(LONG, 0)).toBe('BF-00100-A');
    expect(valueAt(SHORT, 0)).toBe('1');
  });

  it('CLAMPS a shorter range to its last value instead of blanking or repeating', () => {
    expect(valueAt(SHORT, 49)).toBe('50');
    expect(valueAt(SHORT, 50)).toBe('50');
    expect(valueAt(SHORT, 150)).toBe('50');
    expect(valueAt(SHORT, 9999)).toBe('50');
  });

  it('is null for an element whose range yields nothing', () => {
    expect(valueAt(num({ start: 5, end: 1, step: 1 }), 0)).toBeNull();
  });
});

describe('drivingSequence', () => {
  it('is the longest sequence, so {n} and the page count can never disagree', () => {
    const driving = drivingSequence([SHORT, LONG]);
    expect(driving).toHaveLength(pageCount([SHORT, LONG]));
    expect(driving[0]).toBe('BF-00100-A');
    expect(driving[150]).toBe('BF-00250-A');
  });

  it('breaks ties by element order', () => {
    const a = num({ start: 1, end: 3, step: 1, prefix: 'A' });
    const b = num({ start: 1, end: 3, step: 1, prefix: 'B' });
    expect(drivingSequence([a, b])[0]).toBe('A1');
    expect(drivingSequence([b, a])[0]).toBe('B1');
  });

  it('is empty when nothing counts', () => {
    expect(drivingSequence([{ type: 'text' }])).toEqual([]);
  });
});

describe('createElement("number")', () => {
  it('carries its own counter and needs no enabled flag', () => {
    const el = createElement('number');
    expect(el.type).toBe('number');
    expect(el.counter).toEqual({
      start: 1,
      end: 10,
      step: 1,
      pad: 0,
      prefix: '',
      suffix: '',
    });
    expect(el.counter.enabled).toBeUndefined();
    expect(valueAt(el, 0)).toBe('1');
    expect(pageCount([el])).toBe(10);
  });

  it('leaves every other type without a counter', () => {
    for (const type of ['text', 'image', 'rect', 'line', 'qr', 'barcode']) {
      expect(createElement(type).counter).toBeNull();
    }
  });
});

// The challenger measured three number elements on paper and found the run's
// own does_not_prove line false in the flattering direction: it claimed three
// elements were covered by unit tests, and nothing anywhere covered them.
describe('three or more number elements', () => {
  const a = num({ start: 1, end: 3, step: 1, pad: 0, prefix: '', suffix: '' });
  const b = num({ start: 1, end: 7, step: 1, pad: 0, prefix: '', suffix: '' });
  const c = num({ start: 1, end: 20, step: 1, pad: 0, prefix: '', suffix: '' });

  it('the longest of three sets the run', () => {
    expect(pageCount([a, b, c])).toBe(20);
  });

  it('BOTH shorter elements hold their last value simultaneously', () => {
    expect(valueAt(a, 19)).toBe('3');
    expect(valueAt(b, 19)).toBe('7');
    expect(valueAt(c, 19)).toBe('20');
  });

  it('an invalid range among valid ones neither wins nor breaks the run', () => {
    const dead = num({ start: 10, end: 1, step: 1 });
    expect(pageCount([dead, a, c])).toBe(20);
    expect(valueAt(dead, 0)).toBeNull();
    expect(drivingSequence([dead, a, c])).toHaveLength(20);
  });
});

// Dragging a text box by a corner should scale the type with it - the owner
// asked for exactly this after finding the box resized while the text stayed
// 10pt. The maths lives in the model so it is testable without a DOM.
describe('scaleCapMm', () => {
  it('doubles the cap height when the box is dragged to twice the height', () => {
    expect(scaleCapMm({ type: 'text', hMm: 8, fontCapMm: 2.5 }, 16)).toBe(5);
  });

  it('halves it when the box is dragged to half the height', () => {
    expect(scaleCapMm({ type: 'text', hMm: 8, fontCapMm: 5 }, 4)).toBe(2.5);
  });

  it('ignores width entirely - only height drives type size', () => {
    const el = { type: 'text', hMm: 8, fontCapMm: 3 };
    expect(scaleCapMm({ ...el, wMm: 10 }, 12)).toBe(4.5);
    expect(scaleCapMm({ ...el, wMm: 200 }, 12)).toBe(4.5);
  });

  it('scales a number element too - it draws type as much as text does', () => {
    expect(scaleCapMm({ type: 'number', hMm: 8, fontCapMm: 2.5 }, 12)).toBe(
      3.8,
    );
  });

  it('falls back to the default cap height when the element carries none', () => {
    expect(scaleCapMm({ type: 'text', hMm: 10 }, 20)).toBe(DEFAULT_CAP_MM * 2);
  });

  it('returns null for every type that draws no type at all', () => {
    for (const type of ['qr', 'barcode', 'matrix', 'image', 'rect', 'line']) {
      expect(scaleCapMm({ type, hMm: 8, fontCapMm: 2.5 }, 16)).toBeNull();
    }
  });

  it('clamps rather than running away: a huge drag stops at the maximum', () => {
    expect(scaleCapMm({ type: 'text', hMm: 1, fontCapMm: 2.5 }, 500)).toBe(
      CAP_MM_MAX,
    );
  });

  it('clamps at the minimum so text can never be dragged to nothing', () => {
    expect(scaleCapMm({ type: 'text', hMm: 100, fontCapMm: 2.5 }, 0.5)).toBe(
      CAP_MM_MIN,
    );
  });

  it('refuses a zero or missing height instead of writing NaN into the model', () => {
    expect(scaleCapMm({ type: 'text', hMm: 0, fontCapMm: 2.5 }, 8)).toBeNull();
    expect(scaleCapMm({ type: 'text', fontCapMm: 2.5 }, 8)).toBeNull();
    expect(scaleCapMm({ type: 'text', hMm: 8, fontCapMm: 2.5 }, 0)).toBeNull();
    expect(scaleCapMm(null, 8)).toBeNull();
  });

  it('rounds to tenths of a millimetre - finer than a 300dpi head resolves', () => {
    expect(scaleCapMm({ type: 'text', hMm: 8, fontCapMm: 2.5 }, 8.3)).toBe(2.6);
  });

  it('a real text element from createElement scales from its own defaults', () => {
    const el = createElement('text');
    expect(el.fontCapMm).toBe(DEFAULT_CAP_MM);
    expect(scaleCapMm(el, el.hMm * 3)).toBe(DEFAULT_CAP_MM * 3);
  });
});

// The frame hugs the text: the owner asked for "рамка повинна бути на розмір
// тексту" after seeing a 40x8mm box around the word "Text". Measurement needs
// a DOM, so these tests inject a deterministic measurer instead.
describe('fitTextBoxMm', () => {
  // Every glyph exactly half an em wide, and a cap ratio of exactly 0.5, so
  // the expected numbers can be worked out by hand rather than trusted.
  const halfEm = (text, cssFont) => text.length * parseFloat(cssFont) * 0.5;
  const halfCap = () => 0.5;
  const fit = (el, text) => fitTextBoxMm(el, text, halfEm, halfCap);

  it('sizes the box from the cap height, not from PX_PER_MM', () => {
    // cap 2mm at ratio 0.5 -> em 4mm -> 15.118 css px; "Text" is 4 glyphs
    // -> 30.236px -> 8.0mm, plus 0.4mm padding each side = 8.8mm.
    const box = fit(
      { type: 'text', fontCapMm: 2, fontFamily: 'Inter' },
      'Text',
    );
    expect(box.wMm).toBeCloseTo(8.8, 1);
    // 4mm em * 1.15 line height = 4.6mm + 0.8 padding = 5.4mm
    expect(box.hMm).toBeCloseTo(5.4, 1);
  });

  it('doubling the cap height roughly doubles both dimensions', () => {
    const small = fit({ type: 'text', fontCapMm: 2 }, 'Text');
    const large = fit({ type: 'text', fontCapMm: 4 }, 'Text');
    expect(large.wMm / small.wMm).toBeGreaterThan(1.8);
    expect(large.hMm / small.hMm).toBeGreaterThan(1.8);
  });

  it('takes the widest line and stacks the height for multi-line text', () => {
    const one = fit({ type: 'text', fontCapMm: 2 }, 'AAAA');
    const two = fit({ type: 'text', fontCapMm: 2 }, 'AAAA\nAA');
    expect(two.wMm).toBeCloseTo(one.wMm, 5);
    expect(two.hMm).toBeGreaterThan(one.hMm);
  });

  // The other half of the 1..100 fix: the caller may hand in every value the
  // element will show, and the box has to hold all of them.
  it('takes the widest of a LIST of candidate strings', () => {
    const one = fit({ type: 'number', fontCapMm: 2 }, '1');
    const many = fit({ type: 'number', fontCapMm: 2 }, ['1', '10', '100']);
    expect(many.wMm).toBeGreaterThan(one.wMm);
    // Three one-line candidates are still one line tall.
    expect(many.hMm).toBeCloseTo(one.hMm, 5);
  });

  it('a single-string call is unchanged by the list support', () => {
    const asString = fit({ type: 'text', fontCapMm: 2 }, 'Text');
    const asList = fit({ type: 'text', fontCapMm: 2 }, ['Text']);
    expect(asList).toEqual(asString);
  });

  it('treats an empty list as empty text rather than a zero-wide box', () => {
    const box = fit({ type: 'number', fontCapMm: 2 }, []);
    expect(box.wMm).toBeGreaterThan(0);
    expect(box.hMm).toBeGreaterThan(0);
  });

  it('returns null rather than a guess when the text cannot be measured', () => {
    expect(
      fitTextBoxMm({ type: 'text', fontCapMm: 2 }, 'Text', () => null, halfCap),
    ).toBeNull();
  });

  it('refuses a missing or zero cap height instead of returning a zero box', () => {
    expect(fit({ type: 'text' }, 'Text')).toBeNull();
    expect(fit({ type: 'text', fontCapMm: 0 }, 'Text')).toBeNull();
    expect(fitTextBoxMm(null, 'Text', halfEm, halfCap)).toBeNull();
  });

  it('handles empty content without producing a negative or zero-height box', () => {
    const box = fit({ type: 'text', fontCapMm: 2 }, '');
    expect(box.wMm).toBeGreaterThan(0);
    expect(box.hMm).toBeGreaterThan(0);
  });
});

// The unit the owner authors in, and the one-way door back to the old field.
describe('cap height in millimetres', () => {
  const halfCap = () => 0.5;

  it('derives the em size CSS needs from the cap height', () => {
    expect(emMmFromCapMm(2, 'Inter', halfCap)).toBe(4);
    expect(emMmFromCapMm(3, 'Inter', () => 0.75)).toBe(4);
  });

  it('refuses a zero or missing cap height', () => {
    expect(emMmFromCapMm(0, 'Inter', halfCap)).toBeNull();
    expect(emMmFromCapMm(undefined, 'Inter', halfCap)).toBeNull();
  });

  it('migrates a legacy point size to the cap height that renders the same', () => {
    // 10pt em = 3.528mm; at a 0.72 cap ratio the capitals measure 2.5mm.
    expect(capMmFromPt(10, 'Inter', () => 0.72)).toBe(2.5);
    expect(capMmFromPt(20, 'Inter', () => 0.72)).toBe(5.1);
  });

  it('refuses a missing or nonsense point size rather than inventing one', () => {
    expect(capMmFromPt(0, 'Inter', halfCap)).toBeNull();
    expect(capMmFromPt(undefined, 'Inter', halfCap)).toBeNull();
  });
});
