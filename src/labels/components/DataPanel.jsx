// The import panel: load a spreadsheet, print one label per row.
//
// It sits in the left rail under the print panel, because that is the order
// the work happens in - lay the label out, load the data, press Print - and
// the print panel's page total updates the moment a file lands, which is the
// operator's confirmation that the file was understood.
//
// TWO PARSERS, ON PURPOSE.
//   .csv  is parsed HERE, by src/labels/model/dataset.js. It needs no
//         library, so it keeps working when the print server is not running -
//         the state the panel below it already has to be honest about.
//   .xlsx is parsed by the SERVER, with the ExcelJS that is already installed
//         for /api/report.xlsx. A second copy of ExcelJS in the browser would
//         add roughly a megabyte to a 1.4MB bundle to do what the server that
//         always ships with this app already does.
// Both come back as the same { columns, rows } shape and go through the same
// normaliseDataset, so a CSV and an XLSX of the same table print identically.
//
// The panel never prints anything itself. It fills the store; PrintPanel and
// PrintSheet do the rest, exactly as they do without a file.
import { useState } from 'react';

import { MAX_DATASET_ROWS, parseCsv } from '../model/dataset.js';
import { useEditorStore } from '../store/editorStore.js';
import '../styles/data-panel.css';

// The types whose `content` a token can be written into. rect, line and image
// have no text to substitute into, so offering them a column chip would be a
// button that does nothing.
const CONTENT_TYPES = new Set(['text', 'number', 'qr', 'barcode', 'matrix']);

// How many columns' worth of the first row the panel shows back. Enough to
// recognise the file, few enough to fit a 180px rail.
const PREVIEW_COLUMNS = 4;

function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return match ? match[1].toLowerCase() : '';
}

async function importOnServer(file) {
  let res;
  try {
    res = await fetch(`/api/import?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new Error(
      'The app server is not reachable, and .xlsx is read by the server. Start the server, or save the sheet as .csv.',
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`);
  return data;
}

export default function DataPanel() {
  const dataset = useEditorStore((state) => state.dataset);
  const setDataset = useEditorStore((state) => state.setDataset);
  const clearDataset = useEditorStore((state) => state.clearDataset);
  const elements = useEditorStore((state) => state.elements);
  const selectedId = useEditorStore((state) => state.selectedId);
  const updateElement = useEditorStore((state) => state.updateElement);

  // idle -> loading -> idle | error. `note` says what happened either way;
  // an import that quietly does nothing is the failure this panel is most
  // likely to produce, so it always says something.
  const [status, setStatus] = useState('idle');
  const [note, setNote] = useState('');

  const selected = elements.find((el) => el.id === selectedId) ?? null;
  const canInsert = Boolean(selected) && CONTENT_TYPES.has(selected.type);

  async function handleFile(event) {
    const file = event.target.files?.[0];
    // Clearing the input is what lets the same file be chosen twice - after
    // editing it in Excel, which is exactly when an operator would.
    event.target.value = '';
    if (!file) return;

    setStatus('loading');
    setNote('');

    try {
      const ext = extensionOf(file.name);
      if (ext === 'xls') {
        throw new Error(
          'The old .xls format cannot be read. Open it in Excel and save as .xlsx or .csv.',
        );
      }

      const parsed =
        ext === 'csv'
          ? parseCsv(await file.text())
          : await importOnServer(file);

      const rows = Array.isArray(parsed?.rows) ? parsed.rows.length : 0;
      if (rows > MAX_DATASET_ROWS) {
        // Refused, not truncated: silently dropping rows 5001 and up prints
        // a run that looks complete and is not.
        throw new Error(
          `${rows} rows is over the ${MAX_DATASET_ROWS} limit. Split the file and print it in parts.`,
        );
      }

      const next = setDataset({ ...parsed, name: file.name });
      if (!next) {
        throw new Error(
          'No rows found. The first line has to be the column names, with at least one row under it.',
        );
      }

      setStatus('idle');
      setNote(
        `${next.rows.length} row${next.rows.length === 1 ? '' : 's'} loaded.`,
      );
    } catch (e) {
      setStatus('error');
      setNote(e.message);
    }
  }

  function insertToken(column) {
    if (!canInsert) return;
    const content = selected.content ?? '';
    updateElement(selected.id, { content: `${content}{${column}}` });
  }

  function handleClear() {
    clearDataset();
    setStatus('idle');
    setNote('');
  }

  const firstRow = dataset?.rows?.[0] ?? null;

  return (
    <section className='lbl-data-panel'>
      <h2 className='lbl-panel__title'>Data</h2>

      <label className='lbl-data-panel__file'>
        <span className='lbl-field__label'>Excel or CSV</span>
        <input
          type='file'
          className='lbl-data-panel__input'
          accept='.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          onChange={handleFile}
          disabled={status === 'loading'}
        />
      </label>

      {status === 'loading' && <p className='lbl-hint'>Reading the file…</p>}

      {dataset && (
        <>
          <p className='lbl-stat'>
            {dataset.rows.length} row{dataset.rows.length === 1 ? '' : 's'} ×{' '}
            {dataset.columns.length} column
            {dataset.columns.length === 1 ? '' : 's'}
          </p>
          <p className='lbl-preview'>{dataset.name}</p>

          <p className='lbl-hint'>
            {canInsert
              ? 'Click a column to add it to the selected element.'
              : 'Select a text, number, QR, barcode or matrix element to add a column to it.'}
          </p>

          <div className='lbl-data-panel__columns'>
            {dataset.columns.map((column) => (
              <button
                key={column}
                type='button'
                className='lbl-btn lbl-btn--sm'
                onClick={() => insertToken(column)}
                disabled={!canInsert}
                title={`Insert {${column}}`}
              >
                {column}
              </button>
            ))}
          </div>

          {firstRow && (
            <p className='lbl-preview'>
              Row 1 ·{' '}
              {dataset.columns
                .slice(0, PREVIEW_COLUMNS)
                .map((column) => firstRow[column] || '—')
                .join(' · ')}
            </p>
          )}

          <div className='lbl-btn-row'>
            <button type='button' className='lbl-btn' onClick={handleClear}>
              Remove file
            </button>
          </div>
        </>
      )}

      {note && (
        <p
          className={
            status === 'error'
              ? 'lbl-data-panel__note lbl-data-panel__note--alert'
              : 'lbl-data-panel__note'
          }
          role='status'
        >
          {note}
        </p>
      )}
    </section>
  );
}
