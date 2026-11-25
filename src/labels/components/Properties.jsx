// The properties panel is a pure view over the store: every field it shows
// reads straight from useEditorStore and every edit writes straight back
// through a T-02 action. Nothing here keeps a local copy of a value - a
// number input that briefly shows what you typed is still deriving that
// from the store on the next render, never from its own state.
import { buildSequence } from '../model/counter.js';
import { useEditorStore } from '../store/editorStore.js';

// The default preset is first in the list so it is also the first <option>
// in the markup, matching whatever the store's initial label size is.
const LABEL_PRESETS = [
  { key: '60x20', label: '60 x 20 mm', w: 60, h: 20 },
  { key: '70x20', label: '70 x 20 mm', w: 70, h: 20 },
  { key: '50x30', label: '50 x 30 mm', w: 50, h: 30 },
  { key: '40x30', label: '40 x 30 mm', w: 40, h: 30 },
  { key: '38x25', label: '38 x 25 mm', w: 38, h: 25 },
  { key: '100x50', label: '100 x 50 mm', w: 100, h: 50 },
];

// Types whose `content` a human types. image content is a data URL, and
// rect/line have none - offering a text box for those is noise.
const CONTENT_TYPES = ['text', 'number', 'qr', 'barcode', 'matrix'];

// Web-safe families plus the two already loaded in _variables.css - a font
// picked here is guaranteed to exist on the machine that prints the label.
const FONT_FAMILIES = [
  'Inter',
  'Raleway',
  'Arial',
  'Helvetica',
  'Times New Roman',
  'Courier New',
];

// The two 1D formats R-16 names. Barcode.jsx already handles both and
// renders a visible 'invalid' box when a value does not fit the chosen
// format (EAN-13 needs 12 or 13 digits) - this list only decides what the
// picker offers.
const BARCODE_FORMATS = [
  { key: 'CODE128', label: 'Code 128' },
  { key: 'EAN13', label: 'EAN-13' },
];

// A controlled mm/pt/degree number field. It never stores what the user is
// mid-typing - a keystroke that does not yet parse to a finite number is
// simply not written to the store, and the field falls back to showing the
// store's current value.
function NumberField({ label, value, step, onChange }) {
  return (
    <label className='lbl-field'>
      <span className='lbl-field__label'>{label}</span>
      <input
        type='number'
        step={step}
        value={Number.isFinite(value) ? value : ''}
        className='lbl-input'
        onChange={(event) => {
          const next = event.target.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

export default function Properties() {
  const elements = useEditorStore((state) => state.elements);
  const selectedId = useEditorStore((state) => state.selectedId);
  const label = useEditorStore((state) => state.label);
  const setLabel = useEditorStore((state) => state.setLabel);
  const updateElement = useEditorStore((state) => state.updateElement);
  const removeElement = useEditorStore((state) => state.removeElement);
  const duplicateElement = useEditorStore((state) => state.duplicateElement);

  const selected = elements.find((el) => el.id === selectedId) ?? null;

  // A number element always has a counter; every other type has null. The
  // fallback keeps the inputs controlled for the render where a freshly
  // loaded legacy element has not got one yet.
  const counter = selected?.counter ?? {
    start: 1,
    end: 10,
    step: 1,
    pad: 0,
    prefix: '',
    suffix: '',
  };
  const ownSequence =
    selected?.type === 'number'
      ? buildSequence({ ...counter, enabled: true })
      : [];

  function patchCounter(patch) {
    if (!selected) return;
    updateElement(selected.id, { counter: { ...counter, ...patch } });
  }

  const activePresetKey =
    LABEL_PRESETS.find((preset) => preset.w === label.w && preset.h === label.h)
      ?.key ?? 'custom';

  const handlePresetChange = (event) => {
    const preset = LABEL_PRESETS.find((p) => p.key === event.target.value);
    if (preset) setLabel({ w: preset.w, h: preset.h });
  };

  return (
    <aside className='lbl-side-panel'>
      <section className='lbl-panel'>
        <h3 className='lbl-panel__title'>Label size</h3>
        <label className='lbl-field'>
          <span className='lbl-field__label'>Preset</span>
          <select
            className='lbl-select'
            value={activePresetKey}
            onChange={handlePresetChange}
          >
            {LABEL_PRESETS.map((preset) => (
              <option key={preset.key} value={preset.key}>
                {preset.label}
              </option>
            ))}
            {activePresetKey === 'custom' && (
              <option value='custom'>Custom</option>
            )}
          </select>
        </label>
        <div className='lbl-grid'>
          <NumberField
            label='Width (mm)'
            value={label.w}
            step={0.5}
            onChange={(w) => setLabel({ w })}
          />
          <NumberField
            label='Height (mm)'
            value={label.h}
            step={0.5}
            onChange={(h) => setLabel({ h })}
          />
        </div>
      </section>

      {selected && (
        <section className='lbl-panel'>
          <h3 className='lbl-panel__title'>Placement</h3>
          <div className='lbl-grid'>
            <NumberField
              label='X (mm)'
              value={selected.xMm}
              step={0.5}
              onChange={(xMm) => updateElement(selected.id, { xMm })}
            />
            <NumberField
              label='Y (mm)'
              value={selected.yMm}
              step={0.5}
              onChange={(yMm) => updateElement(selected.id, { yMm })}
            />
          </div>
          <div className='lbl-grid'>
            <NumberField
              label='W (mm)'
              value={selected.wMm}
              step={0.5}
              onChange={(wMm) => updateElement(selected.id, { wMm })}
            />
            <NumberField
              label='H (mm)'
              value={selected.hMm}
              step={0.5}
              onChange={(hMm) => updateElement(selected.id, { hMm })}
            />
          </div>
          <NumberField
            label='Rotation (deg)'
            value={selected.rot}
            step={1}
            onChange={(rot) => updateElement(selected.id, { rot })}
          />

          <div className='lbl-btn-row'>
            <button
              type='button'
              className='lbl-btn lbl-btn--sm'
              onClick={() => duplicateElement(selected.id)}
            >
              Duplicate
            </button>
            <button
              type='button'
              className='lbl-btn lbl-btn--sm lbl-btn--danger'
              onClick={() => removeElement(selected.id)}
            >
              Delete
            </button>
          </div>

          {selected.type === 'text' && (
            <>
              <h3 className='lbl-panel__title'>Text</h3>
              <label className='lbl-field'>
                <span className='lbl-field__label'>Font family</span>
                <select
                  className='lbl-select'
                  value={selected.fontFamily ?? ''}
                  onChange={(event) =>
                    updateElement(selected.id, {
                      fontFamily: event.target.value,
                    })
                  }
                >
                  {FONT_FAMILIES.map((font) => (
                    <option key={font} value={font}>
                      {font}
                    </option>
                  ))}
                </select>
              </label>
              <NumberField
                label='Font size (mm)'
                value={selected.fontCapMm}
                step={0.1}
                onChange={(fontCapMm) =>
                  updateElement(selected.id, { fontCapMm })
                }
              />
            </>
          )}

          {selected.type === 'barcode' && (
            <>
              <h3 className='lbl-panel__title'>Barcode</h3>
              <label className='lbl-field'>
                <span className='lbl-field__label'>Format</span>
                <select
                  className='lbl-select'
                  value={selected.barcodeFormat ?? 'CODE128'}
                  onChange={(event) =>
                    updateElement(selected.id, {
                      barcodeFormat: event.target.value,
                    })
                  }
                >
                  {BARCODE_FORMATS.map((format) => (
                    <option key={format.key} value={format.key}>
                      {format.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {/* The range that used to live in the deleted Counter panel, now
              on the element that owns it. There is no enable toggle: a
              number element exists, therefore it counts. */}
          {selected.type === 'number' && (
            <>
              <h3 className='lbl-panel__title'>Number</h3>
              <div className='lbl-grid'>
                <NumberField
                  label='Start'
                  value={counter.start}
                  step={1}
                  onChange={(start) => patchCounter({ start })}
                />
                <NumberField
                  label='End'
                  value={counter.end}
                  step={1}
                  onChange={(end) => patchCounter({ end })}
                />
              </div>
              <div className='lbl-grid'>
                <NumberField
                  label='Step'
                  value={counter.step}
                  step={1}
                  onChange={(step) => patchCounter({ step })}
                />
                <NumberField
                  label='Pad'
                  value={counter.pad}
                  step={1}
                  onChange={(pad) => patchCounter({ pad })}
                />
              </div>
              <div className='lbl-grid'>
                <label className='lbl-field'>
                  <span className='lbl-field__label'>Prefix</span>
                  <input
                    className='lbl-input'
                    type='text'
                    value={counter.prefix}
                    onChange={(event) =>
                      patchCounter({ prefix: event.target.value })
                    }
                  />
                </label>
                <label className='lbl-field'>
                  <span className='lbl-field__label'>Suffix</span>
                  <input
                    className='lbl-input'
                    type='text'
                    value={counter.suffix}
                    onChange={(event) =>
                      patchCounter({ suffix: event.target.value })
                    }
                  />
                </label>
              </div>
              <p className='lbl-stat'>{ownSequence.length} labels</p>
              <p className='lbl-preview'>
                First: {ownSequence[0] ?? '—'} · Last:{' '}
                {ownSequence[ownSequence.length - 1] ?? '—'}
              </p>
              <p className='lbl-hint'>
                The longest Number element sets how many labels print; a shorter
                one holds its last value. {'{n}'} in any other element follows
                that same longest sequence.
              </p>
            </>
          )}

          {/* Rehomed from the deleted Counter panel. Without this there is
              no way to type a QR's payload at all, which would silently
              regress the ability to bind a code to the counter. */}
          {CONTENT_TYPES.includes(selected.type) && (
            <label className='lbl-field'>
              <span className='lbl-field__label'>
                Content ({selected.type})
              </span>
              <input
                className='lbl-input'
                type='text'
                value={selected.content}
                onChange={(event) =>
                  updateElement(selected.id, { content: event.target.value })
                }
              />
            </label>
          )}
        </section>
      )}
    </aside>
  );
}
