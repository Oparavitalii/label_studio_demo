import { nanoid } from 'nanoid';

// Templates are an array of { id, name, savedAt, label, elements }.
// Templates written before counting moved onto elements also carry a
// document-level `counter`; loadDoc migrates that into a number element
// rather than discarding it, so old templates keep printing what they did.
// stored under one localStorage key. globalThis.localStorage is read lazily
// inside each function (never at module top level) so this module imports
// cleanly in Node/Vitest, where there is no localStorage at all, and every
// function here survives an absent or corrupt store without throwing.
const STORAGE_KEY = 'labelstudio.labels.v1';

// Broadcast on every successful write, so a second view of the same key
// (the Templates page) redraws the moment the Creator saves. The native
// `storage` event is NOT enough on its own: the browser fires it only in
// OTHER tabs, never in the tab that wrote. Without this event the Templates
// page would show a stale list until a full reload - the exact bug the
// Toolbar's manual `setTemplates(listTemplates())` refresh papers over
// inside one component and cannot fix across two.
export const TEMPLATES_CHANGED = 'labelstudio:templates';

function notifyChanged() {
  try {
    // Optional-call: Node/Vitest has no global dispatchEvent, and by spec
    // the argument is never evaluated when the callee is nullish, so no
    // CustomEvent is constructed there either. The try/catch is belt and
    // braces for a runtime with dispatchEvent but no CustomEvent, and so
    // that a listener throwing can never be mistaken for a failed write.
    globalThis.dispatchEvent?.(new CustomEvent(TEMPLATES_CHANGED));
  } catch {
    return;
  }
}

function readAll() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return [];
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(templates) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch {
    // A write that threw changed nothing, so nothing is announced.
    return false;
  }

  // Outside the try on purpose: the write already succeeded by here, and a
  // failure to announce it must not be reported back as a failed write.
  notifyChanged();
  return true;
}

export function listTemplates() {
  return readAll();
}

export function saveTemplate(name, doc) {
  const templates = readAll();
  const template = {
    id: nanoid(),
    name,
    savedAt: new Date().toISOString(),
    label: doc && doc.label ? doc.label : null,
    elements: doc && Array.isArray(doc.elements) ? doc.elements : [],
  };

  templates.push(template);
  writeAll(templates);
  return template;
}

export function loadTemplate(id) {
  const templates = readAll();
  return templates.find((template) => template && template.id === id) ?? null;
}

export function duplicateTemplate(id) {
  const templates = readAll();
  const original = templates.find((template) => template && template.id === id);
  if (!original) return null;

  const copy = {
    ...original,
    id: nanoid(),
    name: `${original.name} copy`,
    savedAt: new Date().toISOString(),
  };

  templates.push(copy);
  writeAll(templates);
  return copy;
}

export function deleteTemplate(id) {
  const templates = readAll();
  const remaining = templates.filter(
    (template) => !(template && template.id === id),
  );
  const changed = remaining.length !== templates.length;
  if (changed) writeAll(remaining);
  return changed;
}
