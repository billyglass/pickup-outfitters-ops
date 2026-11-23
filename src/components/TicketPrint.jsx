import { money, computeTotals, lineTotal, laborAmount, fmtDate, roundCents } from '../lib/tickets.js'
import { formatPhone } from '../lib/phones.js'

// Print layout matching Bill's Excel template (quote-invoice.xlsx):
// 2848 N. Lindbergh Blvd, St. Ann, MO 63074 — Phone 314-428-3730
// "Quotation For:" / "Invoice For:" Name / Company / Address / Phone / Email
// Date + valid until (quote) / due date (invoice — only when it has one;
// a COD invoice has no due date, and the Terms row already says COD)
// SALESPERSON / P.O. NUMBER / VEHICLE / TERMS
// Lines: QUANTITY / DESCRIPTION / PART NUMBER / UNIT PRICE / AMOUNT / LABOR
// (the Taxable column is set per line when creating the ticket and is
// NOT printed — tax is already baked into the totals). Labor on the
// print is one combined line: per-line Labor $ + lump-sum labor.
// NOTES — SUBTOTAL / TAX (7.74%) / LABOR / TOTAL — "Thank You For Your Business"
// Grayscale only (black / white / grays, no color) so it prints on the
// shop's B&W printer. The notes + totals block sits at the bottom of the
// page even on a 1-line ticket (flex spacer), so it never looks like an
// awkward half page; long tickets flow naturally and the totals land
// after the last line on the final page.
// print on the SAME line, matching the ticket's Vehicle section.
export default function TicketPrint({ kind, ticket, lines, customer, vehicle, salespersonName, settings, onClose, onEdit, canEdit = true }) {
  const isQuote = kind === 'quote'
  const taxRate = Number(settings?.tax_rate ?? 0.0774)
  const totals = computeTotals(lines, taxRate, ticket.labor_lump)
  const snapCustomer = ticket.customer_snapshot || {}
  const snapVehicle = ticket.vehicle_snapshot || {}
  const vin = snapVehicle.vin || vehicle?.vin || ''
  const ymm = [snapVehicle.year ?? vehicle?.year, snapVehicle.make || vehicle?.make, snapVehicle.model || vehicle?.model].filter(Boolean).join(' ')
  const unit = snapVehicle.fleet_unit || vehicle?.fleet_unit || ''
  const bedSize = snapVehicle.bed_size || vehicle?.bed_size || ''
  const color = snapVehicle.color || vehicle?.color || ''
  // VIN and Year/Make/Model on the SAME line, as on the ticket.
  const vehicleLine = [
    vin ? `VIN: ${vin}` : '',
    ymm || '',
    bedSize || '',
    color || '',
    unit ? `Unit ${unit}` : '',
  ].filter(Boolean).join(' · ')
  const vehicleText = ymm || '—'
  const contactName = snapCustomer.contact_name || ''
  // Walk-in tickets have no customer record and no company — the buyer's
  // name is the contact name; the Company line is omitted for them.
  const isWalkIn = !ticket.customer_id && !!snapCustomer.walk_in
  const company = snapCustomer.company || customer?.company || ''
  const address = snapCustomer.address || ''
  const phone = formatPhone(snapCustomer.phone || '')
  const email = snapCustomer.email || ''

  return (
    <div className="print-sheet">
      <div className="print-actions">
        <button className="btn" type="button" onClick={() => window.print()}>Print</button>
        {onEdit && canEdit && <button className="btn secondary" type="button" onClick={onEdit}>Edit</button>}
        <button className="btn secondary" type="button" onClick={onClose}>Close</button>
      </div>
      <div className="print-doc">
        <div className="print-header">
          <div>
            <div className="print-logo">PICKUP OUTFITTERS</div>
            <div>2848 N. Lindbergh Blvd</div>
            <div>St. Ann, MO 63074</div>
            <div>Phone: 314-428-3730</div>
          </div>
          <div className="print-title">
            <h1>{isQuote ? 'QUOTATION' : 'INVOICE'}</h1>
            <div><strong>{isQuote ? 'Quote' : 'Invoice'} No:</strong> {ticket.number}</div>
            <div><strong>Status:</strong> {ticket.status}</div>
          </div>
        </div>

        <div className="print-cols">
          <div>
            <strong>{isQuote ? 'Quotation For:' : 'Invoice For:'}</strong>
            {isWalkIn && <div>Walk-in (no customer record)</div>}
            {contactName && <div>Name: {contactName}</div>}
            {company && <div>Company: {company}</div>}
            {address && <div>Address: {address}</div>}
            {phone && <div>Phone: {phone}</div>}
            {email && <div>Email: {email}</div>}
          </div>
          <div>
            <div>Date: {fmtDate(ticket.issue_date || (ticket.created_at || '').slice(0, 10))}</div>
            {isQuote
              ? <div>Quotation valid until: {fmtDate(ticket.expires_on)}</div>
              : ticket.due_date
                ? <div>Due date: {fmtDate(ticket.due_date)}</div>
                : null}
            {ticket.follow_up_on && <div>Follow-up: {fmtDate(ticket.follow_up_on)}</div>}
          </div>
        </div>

        <table className="print-meta">
          <thead><tr><th>Salesperson</th><th>P.O. Number</th><th>Vehicle</th><th>Terms</th></tr></thead>
          <tbody><tr>
            <td>{salespersonName || '—'}</td>
            <td>{ticket.po_number || '—'}</td>
            <td>{vehicleText || '—'}</td>
            <td>{ticket.payment_terms || '—'}</td>
          </tr></tbody>
        </table>
        <div className="print-vin">{vehicleLine || 'Vehicle: —'}</div>

        <table className="print-lines">
          <thead><tr><th>Quantity</th><th>Description</th><th>Part Number</th><th>Unit Price</th><th>Amount</th><th>Labor</th></tr></thead>
          <tbody>
            {(lines || []).map((l, i) => (
              <tr key={l.id || i}>
                <td>{Number(l.quantity) || 0}</td>
                <td>{l.description}</td>
                <td>{l.part_number || '—'}</td>
                <td>${money(l.unit_price)}</td>
                <td>${money(lineTotal(l))}</td>
                <td>${money(laborAmount(l))}</td>
              </tr>
            ))}
            {(lines || []).length === 0 && <tr><td colSpan="6">No line items.</td></tr>}
          </tbody>
        </table>

        <div className="print-spacer" />
        <div className="print-cols">
          <div>
            <strong>NOTES:</strong>
            <div>{ticket.customer_notes || ''}</div>
          </div>
          <table className="print-totals">
            <tbody>
              <tr><td>Subtotal</td><td>${money(totals.subtotal)}</td></tr>
              <tr><td>Tax ({(taxRate * 100).toFixed(2)}%)</td><td>${money(totals.taxTotal)}</td></tr>
              <tr><td>Labor</td><td>${money(totals.labor)}</td></tr>
              <tr className="print-total-row"><td><strong>Total</strong></td><td><strong>${money(totals.total)}</strong></td></tr>
              {!isQuote && roundCents(totals.total - Number(ticket.balance_due ?? totals.total)) > 0 && (
                <tr><td>Paid</td><td>${money(roundCents(totals.total - Number(ticket.balance_due ?? totals.total)))}</td></tr>
              )}
              {!isQuote && <tr><td>Balance due</td><td>${money(ticket.balance_due ?? totals.total)}</td></tr>}
            </tbody>
          </table>
        </div>

        <p className="print-thanks">Thank You For Your Business</p>
        {ticket.quote_id && <p className="print-small">Converted from quote — see original quote for revision history.</p>}
        {isQuote && ticket.converted_invoice_id && <p className="print-small">Converted to invoice — see invoice for the final record.</p>}
      </div>
    </div>
  )
}
