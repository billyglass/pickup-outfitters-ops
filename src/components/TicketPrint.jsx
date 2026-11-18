import { money, computeTotals } from '../lib/tickets.js'

// Print layout matching Bill's Excel template (quote-invoice.xlsx):
// 2848 N. Lindbergh Blvd, St. Ann, MO 63074 — Phone 314-428-3730
// "Quotation For:" / "Invoice For:" Name / Company / Address / Phone / Email
// Date + valid until (quote) / due date (invoice)
// SALESPERSON / P.O. NUMBER / VEHICLE / TERMS
// Lines: QUANTITY / DESCRIPTION / PART NUMBER / UNIT PRICE / TAXABLE / AMOUNT
// NOTES — SUBTOTAL / TAX RATE / TAX / LABOR / TOTAL — "Thank You For Your Business"
// Plain black-and-white, no background colours. VIN and Year/Make/Model
// print on the SAME line, matching the ticket's Vehicle section.
export default function TicketPrint({ kind, ticket, lines, customer, vehicle, salespersonName, settings, onClose }) {
  const isQuote = kind === 'quote'
  const taxRate = Number(settings?.tax_rate ?? 0.0774)
  const totals = computeTotals(lines, taxRate)
  const snapCustomer = ticket.customer_snapshot || {}
  const snapVehicle = ticket.vehicle_snapshot || {}
  const vin = snapVehicle.vin || vehicle?.vin || ''
  const ymm = [snapVehicle.year ?? vehicle?.year, snapVehicle.make || vehicle?.make, snapVehicle.model || vehicle?.model].filter(Boolean).join(' ')
  const unit = snapVehicle.fleet_unit || vehicle?.fleet_unit || ''
  const plate = snapVehicle.plate || vehicle?.plate || ''
  // VIN and Year/Make/Model on the SAME line, as on the ticket.
  const vehicleLine = [
    vin ? `VIN: ${vin}` : '',
    ymm || '',
    unit ? `Unit ${unit}` : '',
    plate ? `Plate ${plate}` : '',
  ].filter(Boolean).join(' · ')
  const vehicleText = ymm || '—'
  const contactName = snapCustomer.contact_name || ''
  // Walk-in tickets have no customer record and no company — the buyer's
  // name is the contact name; the Company line is omitted for them.
  const isWalkIn = !ticket.customer_id && !!snapCustomer.walk_in
  const company = snapCustomer.company || customer?.company || ''
  const address = snapCustomer.address || ''
  const phone = snapCustomer.phone || ''
  const email = snapCustomer.email || ''

  return (
    <div className="print-sheet">
      <div className="print-actions">
        <button className="btn" type="button" onClick={() => window.print()}>Print</button>
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
            <div>Date: {ticket.issue_date || (ticket.created_at || '').slice(0, 10)}</div>
            {isQuote
              ? <div>Quotation valid until: {ticket.expires_on || '—'}</div>
              : <div>Due date: {ticket.due_date || '—'}</div>}
            {ticket.follow_up_on && <div>Follow-up: {ticket.follow_up_on}</div>}
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
          <thead><tr><th>Quantity</th><th>Description</th><th>Part Number</th><th>Unit Price</th><th>Taxable</th><th>Amount</th></tr></thead>
          <tbody>
            {(lines || []).map((l, i) => (
              <tr key={l.id || i}>
                <td>{Number(l.quantity) || 0}</td>
                <td>{l.description}{l.line_kind === 'labor' ? ' (Labor)' : ''}</td>
                <td>{l.part_number || '—'}</td>
                <td>${money(l.unit_price)}</td>
                <td>{l.taxable ? 't' : ''}</td>
                <td>${money(l.line_total)}</td>
              </tr>
            ))}
            {(lines || []).length === 0 && <tr><td colSpan="6">No line items.</td></tr>}
          </tbody>
        </table>

        <div className="print-cols">
          <div>
            <strong>NOTES:</strong>
            <div>{ticket.customer_notes || ''}</div>
          </div>
          <table className="print-totals">
            <tbody>
              <tr><td>Subtotal</td><td>${money(totals.subtotal)}</td></tr>
              <tr><td>Tax rate</td><td>{(taxRate * 100).toFixed(2)}%</td></tr>
              <tr><td>Tax</td><td>${money(totals.taxTotal)}</td></tr>
              <tr><td>Labor</td><td>${money(totals.labor)}</td></tr>
              <tr><td><strong>Total</strong></td><td><strong>${money(totals.total)}</strong></td></tr>
              {!isQuote && <tr><td>Balance due</td><td>${money(ticket.balance_due ?? totals.total)}</td></tr>}
            </tbody>
          </table>
        </div>

        <p className="print-thanks">Thank You For Your Business</p>
        <div className="print-sign">
          <div><span>Signature</span></div>
          <div><span>Date</span></div>
        </div>
        {ticket.quote_id && <p className="print-small">Converted from quote — see original quote for revision history.</p>}
        {isQuote && ticket.converted_invoice_id && <p className="print-small">Converted to invoice — see invoice for the final record.</p>}
      </div>
    </div>
  )
}
