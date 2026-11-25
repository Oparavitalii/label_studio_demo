// Pure label rules, shared by the server routes and the unit tests.
//
// Everything in this file is a function of its arguments: no database, no
// HTTP, no clock. The routes in index.js import these, so the tests in
// label_rules.test.js exercise exactly the code that decides what is printed
// on a label and encoded in its Data Matrix.
//
// (In the production build these lived inline in Server/index.js; they were
// moved into their own module in the public copy so they can be tested
// without starting the server. The bodies are unchanged.)

// Serial ranges: first digit = machine number, 6 digits total.
export const MACHINE_RANGES = {
  1: { lo: 100001, hi: 199999 },
  2: { lo: 200001, hi: 299999 },
};

export const DEFAULT_SUPPLIER_CODE = 'D 000';

// TWO KINDS OF SERIAL NUMBER live in this database.
//
// AUTOMATIC — six digits, first digit = machine: 100001, 200001. The counter,
// the machine ranges and MAX(serial) all speak this format and none of them
// changed.
//
// MANUAL — whatever the operator types, any characters and any length; only
// whitespace is refused, because a space breaks the Data Matrix scan (customer's manual).
// The client asked for no other limits (15.10.2026). What they type is what prints:
// "S00001" prints S00001, "AB09" prints AB09, "000042" prints 000042. The
// client asked for this; the old form accepted digits only and silently ate
// the letter.
//
// A serial is therefore stored in three pieces, and reassembled by snOf():
//   batches.serial_prefix — everything before the trailing run of digits ('')
//   batches.serial_width  — how wide that digit run is (6 for automatic)
//   labels.serial         — the digit run's value, as an INTEGER
// Splitting it this way keeps labels.serial numeric, so the counter, the
// ranges, ORDER BY and the reprint selection are all untouched by this
// feature, and a batch numbers upward by incrementing the digit run inside
// its own width: S00001 -> S00002, AB09 -> AB10.
//
// A NOK label has no serial at all and lives in nok_batches, so none of this
// reaches it.
export const AUTO_SN_WIDTH = 6;

// (prefix 'S', width 5, serial 1) -> "S00001"; ('', 6, 42) -> "000042".
// width 0 means the SN carries no digits at all ("SPARE"), so it is the prefix.
export const snOf = (prefix, width, serial) =>
  width > 0 ? prefix + String(serial).padStart(width, '0') : prefix;

// "S00001" -> { prefix: 'S', width: 5, serial: 1, max: 99999 }.
// null/'' -> null, meaning "no manual serial, use the automatic counter".
// Anything else -> { error } with the message the operator sees.
export function parseSerialInput(raw) {
  if (raw == null) return null;
  const text = String(raw).trim().toUpperCase();
  if (!text) return null;
  if (/\s/.test(text)) {
    return { error: 'Manual SN must not contain spaces.' };
  }
  // The TRAILING run of digits is the counter; everything before it is fixed.
  const [, prefix, digits] = /^(.*?)([0-9]*)$/.exec(text);
  const width = digits.length;
  return {
    prefix,
    width,
    serial: width > 0 ? Number(digits) : 0,
    // A run of digits counts up inside its OWN width — AB09 reaches AB99, not
    // AB100, because widening it would change the serial's printed shape
    // halfway through a batch.
    max: width > 0 ? 10 ** width - 1 : 0,
  };
}

// The OK label's Data Matrix content: /CODE/QUANTITY/SN. The quantity segment
// is always 1 - one code per physical part - and the SN is the serial exactly
// as it is printed above the code.
export function okMatrixOf(customerCode, sn) {
  return `/${customerCode}/1/${sn}`;
}

// ---------- NOK labels ----------
// The customer's Logistics Supplier Manual, section 5 — "Label standard for parts that
// have not been remanufactured or cannot be remanufactured".
//
// The grade letter says what state the part came back in. It is printed on the
// label AND encoded in the Data Matrix, so a wrong letter is a wrong physical
// label, not a cosmetic slip.
export const NOK_GRADES = {
  A: 'fully functional but not remanufactured',
  B: 'part with minor damage',
  C: 'part with major damage',
  N: 'unusable, to be scrapped',
};

// "In the datamatrix code, a change is made — the first digit of the customer
// code is replaced from '0' to '9'. This clearly marks the part as an old
// (non-repairable) part." — the manual, verbatim.
//
// Only a leading '0' is rewritten. A code that already starts with 9 is already
// a NOK code and is returned untouched; anything else is handed back as-is and
// the operator sees it in the editable field, because silently inventing a code
// for an unexpected format is how a pallet gets mislabelled.
export function nokCodeOf(customerCode) {
  const code = String(customerCode ?? '').trim();
  return code.startsWith('0') ? `9${code.slice(1)}` : code;
}

// The catalogue stores names the way the OK label prints them — "REMAN INJ CR
// DELPHI". REMAN is exactly the claim a NOK label exists to deny, so it comes
// off the default. The manual names a core "CORE TD VNT GARRETT"; the owner's
// photographed NOK label reads plain "INJ CR DELPHI". Whatever the operator
// types wins over this.
export function nokNameOf(name) {
  return String(name ?? '')
    .trim()
    .replace(/^REMAN\s+/i, '');
}

// Barcode: /CODE/QUANTITY/GRADE_SERIAL_NUMBER
//   /901-002-000101R/1/901-002-000101R_B
// The quantity segment is 1, exactly as on the OK label.
export function nokMatrixOf(nokCode, grade) {
  return `/${nokCode}/1/${nokCode}_${grade}`;
}

// A cell can be a number, a date, a formula result or a rich-text run. The
// label prints a string, so every one of them becomes the string a human
// would have read in the cell - never "[object Object]", which is what a
// naive String() gives for the last two.
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(value.getDate())}.${p(value.getMonth() + 1)}.${value.getFullYear()}`;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return value.richText.map((run) => run.text ?? '').join('');
    }
    // A formula cell carries { formula, result }; the label wants the result.
    if ('result' in value) return cellText(value.result);
    if ('text' in value) return String(value.text ?? '');
    if ('hyperlink' in value)
      return String(value.text ?? value.hyperlink ?? '');
    return '';
  }
  return String(value);
}
