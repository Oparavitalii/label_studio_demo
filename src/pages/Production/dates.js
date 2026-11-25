// The one date format both production labels print.
//
// DD.MM.YY, as on the OK label the app has always printed and as the customer's
// manual's own OK example shows (15.02.20). The manual's NOK example is written
// 5.9.2023 and the owner's photographed NOK label reads 2026-07-29 — three
// formats across two pages of the same document. The owner settled it on
// 29.08.2026: one format, DD.MM.YY, so an OK and a NOK label sitting on the
// same pallet cannot be read as coming from two different systems.
//
// Shared by index.jsx, Nok_Tab.jsx and src/pages/Print/index.jsx. It used to be
// copied into the print route "rather than exporting a non-component out of a
// page module" — this module is that export, and now there is one copy.

// "YYYY-MM-DD HH:MM:SS" -> "DD.MM.YY"
export function labelDate(printedAt) {
  const p = String(printedAt || '')
    .slice(0, 10)
    .split('-');
  if (p.length !== 3) return '';
  return `${p[2]}.${p[1]}.${p[0].slice(2)}`;
}

export function todayLabelDate() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${String(d.getFullYear()).slice(2)}`;
}
