// Demo mode only (VITE_DEMO_MODE=1, set by `npm run dev` / `npm run demo`).
//
// Templates live in the browser's localStorage, so a fresh browser has none
// and the Templates page would open empty. On first load in demo mode this
// saves three example templates through the normal storage API - the same
// call the Creator's "Save template" button makes. All content is invented.
import { createElement } from '../labels/model/elements.js';
import { listTemplates, saveTemplate } from '../labels/model/storage.js';

function el(type, patch) {
  return { ...createElement(type), ...patch };
}

function serialPlate() {
  return {
    label: { w: 60, h: 20 },
    elements: [
      el('text', {
        xMm: 2,
        yMm: 2,
        wMm: 38,
        hMm: 5,
        z: 0,
        content: 'DEMO PARTS · REMAN',
        fontCapMm: 2.2,
      }),
      el('number', {
        xMm: 2,
        yMm: 8.5,
        wMm: 36,
        hMm: 6,
        z: 1,
        content: 'SN {n}',
        fontCapMm: 3,
        counter: {
          start: 1,
          end: 24,
          step: 1,
          pad: 6,
          prefix: '',
          suffix: '',
        },
      }),
      el('matrix', {
        xMm: 43,
        yMm: 2.5,
        wMm: 15,
        hMm: 15,
        z: 2,
        content: '/001-002-000101R/1/{n}',
      }),
    ],
  };
}

function shippingLabel() {
  return {
    label: { w: 100, h: 50 },
    elements: [
      el('text', {
        xMm: 4,
        yMm: 4,
        wMm: 60,
        hMm: 7,
        z: 0,
        content: 'Order {Order}',
        fontCapMm: 3.5,
      }),
      el('text', {
        xMm: 4,
        yMm: 13,
        wMm: 60,
        hMm: 6,
        z: 1,
        content: '{Name}',
        fontCapMm: 2.6,
      }),
      el('text', {
        xMm: 4,
        yMm: 21,
        wMm: 60,
        hMm: 6,
        z: 2,
        content: 'Code {Code} · SN {SN}',
        fontCapMm: 2.4,
      }),
      el('barcode', {
        xMm: 4,
        yMm: 31,
        wMm: 60,
        hMm: 15,
        z: 3,
        content: '{SN}',
      }),
      el('qr', {
        xMm: 70,
        yMm: 8,
        wMm: 26,
        hMm: 26,
        z: 4,
        content: 'https://example.com/part/{SN}',
      }),
    ],
  };
}

function binTag() {
  return {
    label: { w: 70, h: 20 },
    elements: [
      el('text', {
        xMm: 4,
        yMm: 4,
        wMm: 40,
        hMm: 6,
        z: 1,
        content: 'BIN A-07',
        fontCapMm: 3.2,
      }),
      el('number', {
        xMm: 4,
        yMm: 11,
        wMm: 30,
        hMm: 5,
        z: 2,
        content: 'Slot {n}',
        fontCapMm: 2.2,
        counter: { start: 1, end: 8, step: 1, pad: 2, prefix: '', suffix: '' },
      }),
      el('qr', {
        xMm: 52,
        yMm: 2.5,
        wMm: 15,
        hMm: 15,
        z: 3,
        content: 'BIN-A-07-{n}',
      }),
    ],
  };
}

export function seedDemoTemplates() {
  if (listTemplates().length > 0) return;
  saveTemplate('Serial plate 60 × 20 (Data Matrix)', serialPlate());
  saveTemplate('Shipping label 100 × 50 (from CSV)', shippingLabel());
  saveTemplate('Bin tag 70 × 20 (counter + QR)', binTag());
}
