import { useMemo, useState } from 'react'
import { store, VersionConflict } from '../lib/store.js'
import { normalizeVin } from '../lib/csv.js'
import {
  computeTotals, money, lineTotal, emptyLine, addDays, todayStr,
  dueDateFor, termsDays, customerSnapshot, vehicleSnapshot, vehicleLabel,
} from '../lib/tickets.js'

const TERMS = ['Due on receipt', 'Net 15', 'Net 30', 'Net 60', 'COD']
const TAX_RATE = 0.0774

export default function TicketForm({
  kind, initial, lines: initialLines, customers, vehicles, contacts, addresses,
  products, profiles, user, profile, isAdmin, settings, onSaved, onCancel, onPrint,
  prefill, onDuplicate,
}) {
  const isQuote = kind === 'quote'
  const taxRate = Number(settings?.tax_rate ?? TAX_RATE)
  const [ticket, setTicket] = useState(() => {
    if (initial) return { ...initial }
    // Duplicate (prefill): a new Draft with no id/number — Save allocates a
    // new atomic number. The original ticket is never touched.
    if (prefill) return { ...prefill }
    const issue = todayStr()
    return {
      customer_id: customers[0]?.id || '',
      vehicle_id: '',
      salesperson_id: user?.id || '',
      created_by: user?.id || '',
      status: 'Draft',
      po_number: '',
      payment_terms: settings?.default_payment_terms || 'Net 30',
      customer_notes: '',
      internal_notes: '',
      issue_date: issue,
      expires_on: isQuote ? addDays(issue, settings?.quote_validity_days ?? 15) : undefined,
      follow_up_on: '',
      due_date: !isQuote ? dueDateFor(issue, settings?.default_payment_terms || 'Net 30') : undefined,
    }
  })
  const [lines, setLines] = useState(() =>
    (initialLines?.length ? initialLines : [emptyLine()]).map((l) => ({ ...l }))
  )
  const [vinOverride, setVinOverride] = useState(
    initial?.vehicle_snapshot?.vin || prefill?.vehicle_snapshot?.vin || ''
  )
  const [status, setStatus] = useState('saved')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState('')
  const [customerFilter, setCustomerFilter] = useState('')

  const customer = customers.find((c) => c.id === ticket.customer_id) || null
  const customerVehicles = vehicles.filter((v) => v.customer_id === ticket.customer_id)
  const vehicle = vehicles.find((v) => v.id === ticket.vehicle_id) || null
  const vinDiffers = !!(vehicle?.vin && vinOverride && normalizeVin(vinOverride) !== normalizeVin(vehicle.vin))
  const totals = useMemo(() => computeTotals(lines, taxRate), [lines, taxRate])
  const filteredCustomers = customers.filter((c) =>
    !customerFilter.trim() || c.company.toLowerCase().includes(customerFilter.toLowerCase())
  )

  // Edit rules: Sales edit Draft quotes and Draft / Issued / Partially Paid
  // invoices. Paid / Void / closed-period invoices are locked to Sales
  // (the DB invoice_guard enforces this too). Admin may correct any ticket
  // except a Void one; Admin edits to a Paid invoice keep a revision/audit
  // trail via the audit trigger.
  const lockedForSales =
    initial && (
      (isQuote && initial.status !== 'Draft') ||
      (!isQuote && (initial.status === 'Paid' || initial.status === 'Void' || initial.accounting_period_closed))
    )
  const editable = !initial || isAdmin ? initial?.status !== 'Void' : !lockedForSales
  const readOnly = !editable

  function patch(p, { recomputeDates = false } = {}) {
    setTicket((t) => {
      const next = { ...t, ...p }
      if (recomputeDates && next.issue_date) {
        if (isQuote) next.expires_on = addDays(next.issue_date, settings?.quote_validity_days ?? 15)
        else next.due_date = dueDateFor(next.issue_date, next.payment_terms || 'Net 30')
      }
      return next
    })
    setStatus('unsaved')
  }

  function updateLine(i, p) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...p } : l)))
    setStatus('unsaved')
  }

  function applyProduct(i, productId) {
    const p = products.find((x) => x.id === productId)
    if (!p) return
    updateLine(i, {
      product_id: p.id,
      part_number: p.part_number || '',
      description: p.description || p.name,
      unit_price: Number(p.default_price) || 0,
      taxable: !!p.taxable,
      line_kind: p.type || 'part',
    })
  }

  async function save(e) {
    e?.preventDefault()
    if (!ticket.customer_id) { setError('Choose a customer first.'); return }
    if (!lines.some((l) => String(l.description || '').trim())) { setError('Add at least one line item.'); return }
    setError('')
    setConflict('')
    setStatus('saving')
    try {
      const snapCustomer = initial && initial.status !== 'Draft'
        ? initial.customer_snapshot
        : customerSnapshot(customer, contacts, addresses)
      const snapVehicle = initial && initial.status !== 'Draft'
        ? initial.vehicle_snapshot
        : vehicleSnapshot(vehicle, vinOverride || vehicle?.vin || '')
      const saved = await store.saveTicket(
        kind,
        { ...ticket, tax_rate: taxRate, customer_snapshot: snapCustomer, vehicle_snapshot: snapVehicle },
        lines,
        user?.id
      )
      setTicket(saved)
      setStatus('saved')
      onSaved(saved)
    } catch (err) {
      setStatus('unsaved')
      if (err instanceof VersionConflict) setConflict(err.message)
      else setError(err.message || 'Save failed.')
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>
          {initial ? `${isQuote ? 'Quote' : 'Invoice'} ${initial.number}` : prefill ? `New ${isQuote ? 'quote' : 'invoice'} (copy of ${prefill.sourceLabel})` : `New ${isQuote ? 'quote' : 'invoice'}`}
          {initial && <span className="pill" style={{ marginLeft: 8 }}>{initial.status}</span>}
          {prefill && <span className="pill" style={{ marginLeft: 8 }}>New — number assigned on save</span>}
        </h2>
        <span className={`saved ${status === 'saved' ? 'saved-ok' : status === 'saving' ? 'saving' : 'unsaved'}`}>
          {status === 'saved' ? '● Saved' : status === 'saving' ? '● Saving…' : '● Unsaved changes'}
        </span>
      </div>
      {conflict && <div className="error">{conflict} <button type="button" className="btn secondary" onClick={onCancel}>Reload</button></div>}
      {error && <div className="error">{error}</div>}
      {prefill && (
        <div className="warn">
          <strong>Duplicated from {prefill.sourceLabel}.</strong> Everything is copied — customer, lines, notes, terms, PO.
          Change the vehicle / VIN below for this fleet unit, then Save. A new number is assigned on save; the original {isQuote ? 'quote' : 'invoice'} is unchanged.
        </div>
      )}
      {readOnly && <div className="warn">This ticket is locked for editing ({initial?.status}{initial?.accounting_period_closed ? ' · closed period' : ''}). {isAdmin ? 'Admin: you can still correct it — the change is logged.' : 'Ask an Admin to correct it.'}</div>}
      {initial && <p className="muted small">Created by {profiles.find((p) => p.id === initial.created_by)?.name || '—'} · Salesperson {profiles.find((p) => p.id === initial.salesperson_id)?.name || '—'} · Version {initial.version} · {initial.updated_at ? `Last updated ${initial.updated_at.slice(0, 10)}` : ''}</p>}

      <div className="form-grid">
        <div>
          <label>Customer *</label>
          <input value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} placeholder="Filter customers…" disabled={readOnly} />
          <select value={ticket.customer_id || ''} disabled={readOnly} onChange={(e) => patch({ customer_id: e.target.value, vehicle_id: '' })}>
            <option value="">— Choose customer —</option>
            {filteredCustomers.map((c) => <option key={c.id} value={c.id}>{c.company}</option>)}
          </select>
          {customer && <p className="muted small">{customer.payment_terms} · {customer.tax_exempt ? 'Tax exempt' : 'Taxable'}{customer.po_requirements ? ` · PO: ${customer.po_requirements}` : ''}</p>}
        </div>
        <div style={prefill ? { outline: '2px solid #e67e22', outlineOffset: 4, borderRadius: 4, padding: 4 } : undefined}>
          <label>Vehicle {prefill && '— change this for the fleet unit'}</label>
          <select value={ticket.vehicle_id || ''} disabled={readOnly || !ticket.customer_id} autoFocus={!!prefill} onChange={(e) => { patch({ vehicle_id: e.target.value }); const v = vehicles.find((x) => x.id === e.target.value); setVinOverride(v?.vin || '') }}>
            <option value="">— No vehicle —</option>
            {customerVehicles.map((v) => <option key={v.id} value={v.id}>{vehicleLabel(v)}{v.fleet_unit ? ` · Unit ${v.fleet_unit}` : ''}{v.plate ? ` · ${v.plate}` : ''}</option>)}
          </select>
          {vehicle && <p className="muted small">{vehicleLabel(vehicle)} · Unit {vehicle.fleet_unit || '—'} · Plate {vehicle.plate || '—'}</p>}
          {prefill && <p className="muted small">Change the vehicle / VIN for this fleet unit — everything else is copied.</p>}
        </div>
      </div>

      <div>
        <label>VIN (on this ticket)</label>
        <input value={vinOverride} disabled={readOnly} onChange={(e) => setVinOverride(e.target.value.toUpperCase())} placeholder="Auto-filled from the vehicle — edit only if this ticket's VIN differs" />
        {vinDiffers && <div className="warn">This VIN differs from the vehicle record ({vehicle.vin}). It is saved only on this ticket as a snapshot override — the vehicle record is not changed.</div>}
        {!vehicle && <p className="muted small">Pick a vehicle to auto-fill the VIN, or type it here.</p>}
        {prefill && vehicle && <p className="muted small">VIN auto-fills from the vehicle you pick — change the vehicle above and the VIN follows.</p>}
      </div>

      <div className="form-grid">
        <div>
          <label>Salesperson</label>
          {isAdmin ? (
            <select value={ticket.salesperson_id || ''} disabled={readOnly} onChange={(e) => patch({ salesperson_id: e.target.value })}>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role})</option>)}
            </select>
          ) : (
            <input value={profiles.find((p) => p.id === ticket.salesperson_id)?.name || profile?.name || ''} disabled />
          )}
          <p className="muted small">Auto-assigned to the logged-in user when created. Admin can reassign.</p>
        </div>
        <div>
          <label>P.O. number</label>
          <input value={ticket.po_number || ''} disabled={readOnly} onChange={(e) => patch({ po_number: e.target.value })} />
        </div>
        <div>
          <label>{isQuote ? 'Date' : 'Issue date'}</label>
          <input type="date" value={ticket.issue_date || ''} disabled={readOnly} onChange={(e) => patch({ issue_date: e.target.value }, { recomputeDates: true })} />
        </div>
        <div>
          <label>Terms</label>
          <select value={ticket.payment_terms || 'Net 30'} disabled={readOnly} onChange={(e) => patch({ payment_terms: e.target.value }, { recomputeDates: true })}>
            {TERMS.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        {isQuote ? (
          <>
            <div>
              <label>Valid until (issue + {settings?.quote_validity_days ?? 15} days)</label>
              <input type="date" value={ticket.expires_on || ''} disabled={readOnly} onChange={(e) => patch({ expires_on: e.target.value })} />
            </div>
            <div>
              <label>Follow-up date (optional)</label>
              <input type="date" value={ticket.follow_up_on || ''} disabled={readOnly} onChange={(e) => patch({ follow_up_on: e.target.value })} />
            </div>
          </>
        ) : (
          <div>
            <label>Due date (issue + {termsDays(ticket.payment_terms)} days)</label>
            <input type="date" value={ticket.due_date || ''} disabled={readOnly} onChange={(e) => patch({ due_date: e.target.value })} />
          </div>
        )}
      </div>

      <h3>Line items</h3>
      {lines.map((line, i) => (
        <div key={line.id || `new-${i}`} className="card" style={{ padding: 12, marginBottom: 10 }}>
          <div className="form-grid">
            <div>
              <label>Product (optional — fills the line)</label>
              <select value={line.product_id || ''} disabled={readOnly} onChange={(e) => applyProduct(i, e.target.value)}>
                <option value="">— Custom one-time line —</option>
                {products.filter((p) => p.active !== false).map((p) => <option key={p.id} value={p.id}>{p.name}{p.part_number ? ` (${p.part_number})` : ''} — ${money(p.default_price)}</option>)}
              </select>
            </div>
            <div>
              <label>Kind</label>
              <select value={line.line_kind || 'part'} disabled={readOnly} onChange={(e) => updateLine(i, { line_kind: e.target.value })}>
                <option value="part">Part</option>
                <option value="labor">Labor</option>
                <option value="service">Service</option>
              </select>
            </div>
            <div>
              <label>Description *</label>
              <input value={line.description || ''} disabled={readOnly} onChange={(e) => updateLine(i, { description: e.target.value })} />
            </div>
            <div>
              <label>Part number</label>
              <input value={line.part_number || ''} disabled={readOnly} onChange={(e) => updateLine(i, { part_number: e.target.value })} />
            </div>
            <div>
              <label>Qty</label>
              <input type="number" min="0" step="0.01" value={line.quantity ?? 1} disabled={readOnly} onChange={(e) => updateLine(i, { quantity: Number(e.target.value) })} />
            </div>
            <div>
              <label>Unit price</label>
              <input type="number" min="0" step="0.01" value={line.unit_price ?? 0} disabled={readOnly} onChange={(e) => updateLine(i, { unit_price: Number(e.target.value) })} />
            </div>
            <div>
              <label>Discount (per unit)</label>
              <input type="number" min="0" step="0.01" value={line.discount ?? 0} disabled={readOnly} onChange={(e) => updateLine(i, { discount: Number(e.target.value) })} />
            </div>
            <div>
              <label>Taxable</label>
              <input type="checkbox" style={{ width: 'auto' }} checked={!!line.taxable} disabled={readOnly} onChange={(e) => updateLine(i, { taxable: e.target.checked })} /> Taxable (7.74%)
            </div>
          </div>
          <div className="row-between">
            <strong>Amount: ${money(lineTotal(line))}</strong>
            {!readOnly && <button type="button" className="btn secondary" onClick={() => { setLines(lines.filter((_, idx) => idx !== i)); setStatus('unsaved') }}>Remove line</button>}
          </div>
        </div>
      ))}
      {!readOnly && <button type="button" className="btn secondary" onClick={() => { setLines([...lines, emptyLine()]); setStatus('unsaved') }}>+ Add line</button>}

      <h3>Totals</h3>
      <table>
        <tbody>
          <tr><td>Subtotal</td><td style={{ textAlign: 'right' }}>${money(totals.subtotal)}</td></tr>
          <tr><td>Tax rate</td><td style={{ textAlign: 'right' }}>{(taxRate * 100).toFixed(2)}%</td></tr>
          <tr><td>Tax (taxable lines only)</td><td style={{ textAlign: 'right' }}>${money(totals.taxTotal)}</td></tr>
          <tr><td>Labor (included in subtotal — shown separately, not added twice)</td><td style={{ textAlign: 'right' }}>${money(totals.labor)}</td></tr>
          <tr><td><strong>Total</strong></td><td style={{ textAlign: 'right' }}><strong>${money(totals.total)}</strong></td></tr>
        </tbody>
      </table>

      <div className="form-grid">
        <div>
          <label>Customer notes (printed on the ticket)</label>
          <textarea rows={3} value={ticket.customer_notes || ''} disabled={readOnly} onChange={(e) => patch({ customer_notes: e.target.value })} />
        </div>
        <div>
          <label>Internal notes (never printed)</label>
          <textarea rows={3} value={ticket.internal_notes || ''} disabled={readOnly} onChange={(e) => patch({ internal_notes: e.target.value })} />
        </div>
      </div>

      <div className="row" style={{ marginTop: 20 }}>
        {!readOnly && <button className="btn" type="submit" disabled={status === 'saving'}>{status === 'saving' ? 'Saving…' : initial ? 'Save changes' : `Save ${isQuote ? 'quote' : 'invoice'}`}</button>}
        {initial && onPrint && <button className="btn secondary" type="button" onClick={onPrint}>Print</button>}
        {initial && onDuplicate && <button className="btn secondary" type="button" onClick={onDuplicate}>Duplicate</button>}
        <button className="btn secondary" type="button" onClick={onCancel}>Close</button>
      </div>
      {!initial && <p className="muted small">Saving assigns the number automatically ({isQuote ? 'QT-' : 'INV-'}… from 1001) — numbers are never typed in by hand.{prefill ? ` This is a copy of ${prefill.sourceLabel}; the original is unchanged.` : ''}</p>}
    </form>
  )
}
