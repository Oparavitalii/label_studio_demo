// The top bar. R-02 asks for save/open at the TOP, so the template area
// (save/load/duplicate/delete, built entirely over ../model/storage.js)
// lives here, next to undo/redo wired straight to zundo's temporal store.
//
// Adding elements is NOT here any more: R-05 puts the element types on the
// left side, so they moved to Palette.jsx in the rail, and the hidden image
// <input type='file'> went with them. Nothing here keeps its own copy of
// the document - the template list is the one piece of local state, because
// storage.js reads/writes localStorage directly and is never itself
// reactive.
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

import {
  deleteTemplate,
  duplicateTemplate,
  listTemplates,
  loadTemplate,
  saveTemplate,
} from '../model/storage.js';
import { useEditorStore } from '../store/editorStore.js';

export default function Toolbar() {
  const elements = useEditorStore((state) => state.elements);
  const label = useEditorStore((state) => state.label);
  const loadDoc = useEditorStore((state) => state.loadDoc);

  // zundo's temporal store is a plain vanilla zustand store, not a hook -
  // useStore is what subscribes this component to it so undo/redo disable
  // correctly the instant either stack empties.
  const { undo, redo, pastStates, futureStates } = useStore(
    useEditorStore.temporal,
    (state) => state,
  );
  const canUndo = pastStates.length > 0;
  const canRedo = futureStates.length > 0;

  const [templates, setTemplates] = useState(() => listTemplates());
  const [templateName, setTemplateName] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');

  useEffect(() => {
    const stillExists = templates.some(
      (template) => template.id === selectedTemplateId,
    );
    if (!stillExists && templates.length > 0) {
      setSelectedTemplateId(templates[0].id);
    }
    if (!stillExists && templates.length === 0) {
      setSelectedTemplateId('');
    }
  }, [templates, selectedTemplateId]);

  function refreshTemplates() {
    setTemplates(listTemplates());
  }

  function handleSaveTemplate() {
    const name = templateName.trim();
    if (!name) return;
    saveTemplate(name, { label, elements });
    setTemplateName('');
    refreshTemplates();
  }

  function handleLoadTemplate() {
    if (!selectedTemplateId) return;
    const template = loadTemplate(selectedTemplateId);
    if (!template) return;
    loadDoc(template);
  }

  function handleDuplicateTemplate() {
    if (!selectedTemplateId) return;
    const copy = duplicateTemplate(selectedTemplateId);
    if (!copy) return;
    setTemplates(listTemplates());
    setSelectedTemplateId(copy.id);
  }

  function handleDeleteTemplate() {
    if (!selectedTemplateId) return;
    deleteTemplate(selectedTemplateId);
    setSelectedTemplateId('');
    refreshTemplates();
  }

  function handlePrint() {
    window.print();
  }

  return (
    <header className='lbl-toolbar'>
      <div className='lbl-toolbar__main'>
        <div className='lbl-group'>
          <button
            type='button'
            className='lbl-btn'
            disabled={!canUndo}
            onClick={() => undo()}
          >
            Undo
          </button>
          <button
            type='button'
            className='lbl-btn'
            disabled={!canRedo}
            onClick={() => redo()}
          >
            Redo
          </button>
        </div>

        <div className='lbl-divider' />

        <div className='lbl-group'>
          <input
            type='text'
            placeholder='Template name'
            value={templateName}
            className='lbl-input'
            onChange={(event) => setTemplateName(event.target.value)}
          />
          <button
            type='button'
            className='lbl-btn'
            disabled={!templateName.trim()}
            onClick={handleSaveTemplate}
          >
            Save
          </button>
          <select
            value={selectedTemplateId}
            className='lbl-select'
            onChange={(event) => setSelectedTemplateId(event.target.value)}
          >
            <option value=''>Select template…</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
          <button
            type='button'
            className='lbl-btn'
            disabled={!selectedTemplateId}
            onClick={handleLoadTemplate}
          >
            Load
          </button>
          <button
            type='button'
            className='lbl-btn'
            disabled={!selectedTemplateId}
            onClick={handleDuplicateTemplate}
          >
            Duplicate
          </button>
          <button
            type='button'
            className='lbl-btn lbl-btn--danger'
            disabled={!selectedTemplateId}
            onClick={handleDeleteTemplate}
          >
            Delete
          </button>
        </div>
      </div>

      <div className='lbl-group'>
        <button
          type='button'
          className='lbl-btn lbl-btn--primary'
          onClick={handlePrint}
        >
          Print
        </button>
      </div>
    </header>
  );
}
