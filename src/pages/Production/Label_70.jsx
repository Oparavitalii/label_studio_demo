import Data_Matrix from './Data_Matrix.jsx';

// The manual's example shows the manufacture block as three rows:
// "REMAN PUMP" / "BOSCH VP44" / "0470504017". Split the name so the brand
// (and its model word, when the last word carries digits) gets its own line:
// "REMAN INJ CR DELPHI" -> "REMAN INJ CR" + "DELPHI"
// "REMAN PUMP BOSCH VP44" -> "REMAN PUMP" + "BOSCH VP44"
//
// Ported verbatim from Label_Print/src/Label_70.jsx. The
// geometry is a customer contract, not a style choice — a wrong label costs
// EUR 0.5 a piece — so nothing here moved except the class names, which are
// namespaced lbl-prod-* like every other class this page owns.
function splitName(name) {
  const words = String(name).trim().split(/\s+/);
  if (words.length < 3) return [name];
  const take = /\d/.test(words[words.length - 1]) && words.length > 3 ? 2 : 1;
  return [words.slice(0, -take).join(' '), words.slice(-take).join(' ')];
}

// One 70×50 mm label in the customer's supplier-manual layout (regular weight):
// name + producer number top-left with the 15×15 mm Data Matrix top-right,
// then — grouped at the bottom with no big gaps — serial number,
// order | supplier, and customer code | date.
export default function Label_70({
  name,
  producerNumber,
  serial,
  orderNumber,
  customerCode,
  supplierCode,
  dateStr,
  matrix,
}) {
  return (
    <div className='lbl-prod-label'>
      <div className='lbl-prod-l-top'>
        <div className='lbl-prod-l-name'>
          <div className='lbl-prod-l-name-lines'>
            {splitName(name).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          <div className='lbl-prod-l-producer'>{producerNumber}</div>
        </div>
        <Data_Matrix text={matrix} sizeMm={15} />
      </div>
      <div className='lbl-prod-l-spacer' />
      <div className='lbl-prod-l-sn'>{serial}</div>
      <div className='lbl-prod-l-row'>
        <span>{orderNumber}</span>
        <span>{supplierCode}</span>
      </div>
      <div className='lbl-prod-l-row'>
        <span>{customerCode}</span>
        <span>{dateStr}</span>
      </div>
    </div>
  );
}
