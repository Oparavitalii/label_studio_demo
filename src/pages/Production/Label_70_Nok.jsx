import Data_Matrix from './Data_Matrix.jsx';

// One 70×50 mm label for a part that was NOT remanufactured.
//
// The customer's Logistics Supplier Manual, section 5 — "Label standard for parts that
// have not been remanufactured or cannot be remanufactured". The manual's own
// diagram is the spec; this component is that diagram, row for row:
//
//   CORE TD VNT GARRETT              <- manufacture code, name
//   751851-5003S                     <- manufacture code, producer number
//                          [ DM ]    <- /901-002-000101R/1/901-002-000101R_B
//   4500012410                       <- purchase order number
//   901-002-000101R_B      D 000      <- grade serial number | supplier number
//   901-002-000101R        5.9.2023  <- NOK code | date of packaging
//
// The geometry is deliberately IDENTICAL to Label_70 — same 70×50 box, same
// rows, same type sizes, every class shared. Only the content mapping differs,
// and it differs in exactly two places:
//
//  - the row that carries the 6-digit SERIAL on an OK label carries the
//    PURCHASE ORDER NUMBER here, because a non-remanufactured part is never
//    given a serial;
//  - the row under it carries the GRADE SERIAL NUMBER (`<9-code>_<GRADE>`)
//    where the OK label carries the order number.
//
// Two things that look like oversights and are not:
//
//  1. The name is NOT split across two lines. Label_70 splits "REMAN PUMP BOSCH
//     VP44" into brand + model because the manual's OK example is three rows.
//     The manual's NOK example is one row ("CORE TD VNT GARRETT"), and the
//     owner's photographed label is one row too. Splitting it here would print
//     a layout the customer never specified.
//
//  2. There is no "REMAN" anywhere. That word is the claim this label exists to
//     deny. The Production page strips it from the catalogue name before the
//     value reaches this component.
export default function Label_70_Nok({
  name,
  producerNumber,
  orderNumber,
  gradeSerial,
  supplierCode,
  nokCode,
  dateStr,
  matrix,
}) {
  return (
    <div className='lbl-prod-label'>
      <div className='lbl-prod-l-top'>
        <div className='lbl-prod-l-name'>
          <div className='lbl-prod-l-name-lines'>{name}</div>
          <div className='lbl-prod-l-producer'>{producerNumber}</div>
        </div>
        <Data_Matrix text={matrix} sizeMm={15} />
      </div>
      <div className='lbl-prod-l-spacer' />
      <div className='lbl-prod-l-sn'>{orderNumber}</div>
      <div className='lbl-prod-l-row'>
        <span>{gradeSerial}</span>
        <span>{supplierCode}</span>
      </div>
      <div className='lbl-prod-l-row'>
        <span>{nokCode}</span>
        <span>{dateStr}</span>
      </div>
    </div>
  );
}
