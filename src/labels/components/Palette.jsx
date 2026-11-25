// The left rail's add-element palette. R-05 names exactly six things and
// this renders exactly those six, in the brief's own order:
//
//   text - number - qr - image - barcode - matrix
//
// `rect` and `line` are deliberately absent from the palette while staying
// fully alive in the model (TYPE_DEFAULTS, ElementView, the tests): a
// template saved before this card still renders and still prints. Not
// offering a type is not the same as deleting it.
//
// Every tile carries `data-el-type`. scripts/verify-print.mjs finds the
// "add an element" control through that attribute rather than through
// button text, so the wording under an icon can change without breaking the
// print gate. The visible label stays: an icon-only rail would be a
// regression both in accessibility and in what the gate can see.
//
// The hidden <input type='file'> moved here from Toolbar.jsx along with the
// image tile - the control that starts an upload and the input that
// receives the file belong to the same component, and the toolbar no longer
// adds elements at all.
import {
  Barcode,
  Grid3x3,
  Hash,
  Image as ImageIcon,
  QrCode,
  Type,
} from 'lucide-react';
import { useRef } from 'react';

import { useEditorStore } from '../store/editorStore.js';

const TILES = [
  { type: 'text', label: 'Text', Icon: Type },
  { type: 'number', label: 'Number', Icon: Hash },
  { type: 'qr', label: 'QR', Icon: QrCode },
  { type: 'image', label: 'Image', Icon: ImageIcon },
  { type: 'barcode', label: 'Barcode', Icon: Barcode },
  { type: 'matrix', label: 'Matrix', Icon: Grid3x3 },
];

export default function Palette() {
  const addElement = useEditorStore((state) => state.addElement);
  const updateElement = useEditorStore((state) => state.updateElement);

  const fileInputRef = useRef(null);

  // An image element with no source is a dashed placeholder that prints as
  // nothing, so the tile opens the file picker first and only creates the
  // element once a file is actually chosen.
  function handleAddElement(type) {
    if (type === 'image') {
      fileInputRef.current?.click();
      return;
    }
    addElement(type);
  }

  function handleImageFileChange(event) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') return;
      const id = addElement('image');
      updateElement(id, { content: dataUrl });
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className='lbl-palette'>
      {TILES.map(({ type, label, Icon }) => (
        <button
          key={type}
          type='button'
          className='lbl-tile'
          data-el-type={type}
          title={label}
          onClick={() => handleAddElement(type)}
        >
          <Icon size={18} aria-hidden='true' />
          <span className='lbl-tile__label'>{label}</span>
        </button>
      ))}
      <input
        ref={fileInputRef}
        type='file'
        accept='image/*'
        style={{ display: 'none' }}
        onChange={handleImageFileChange}
      />
    </div>
  );
}
