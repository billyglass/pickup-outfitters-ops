import { useEffect, useMemo, useRef, useState } from 'react'
import { store, VersionConflict } from '../lib/store.js'
import { normalizeVin } from '../lib/csv.js'
import { titleCaseName } from '../lib/names.js'
import {
  computeTotals, money, lineTotal, laborAmount, emptyLine, normalizeLineForForm, addDays, todayStr,
  dueDateFor, termsDays, customerSnapshot,
  vehicleFieldsFromSnapshot, vehicleSnapshotFromFields, findVehicleByVin,
  walkInCustomerSnapshot, isWalkInTicket, findCustomerByPhoneOrEmail, customerTypeOf,
} from '../lib/tickets.js'

const TERMS = ['Due on receipt', 'Net 15', 'Net 30', 'Net 60', 'COD']
const TAX_RATE = 0.0774

export default function TicketForm({
  kind, initial, lines: initialLines, customers, vehicles, contacts, addresses,
  products, profiles, user, profile, isAdmin, settings, onSaved, onCancel, onPrint,
  prefill, onDuplicate, onConvert, onDelete,
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isQuote = kind === 'quote'
  const taxRate = Number(settings?.tax_rate ?? TAX_RATE)
  const [ticket, setTicket] = useState(() => {
    if (initial) return { ...initial }
    // Duplicate (prefill): a new ticket with no id/number — Save allocates a
    // new atomic number. The original ticket is never touched.
    if (prefill) return { ...prefill }
    const issue = todayStr()
    return {
      customer_id: customers[0]?.id || '',
      vehicle_id: '',
      salesperson_id: user?.id || '',
      created_by: user?.id || '',
      status: isQuote ? 'Open' : 'Draft',
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
  // Legacy lines are normalized for the form: a labor-kind line's charge
  // moves into Labor $, discount/product are dropped. Nothing is rewritten
  // in the DB until the ticket is saved.
  const [lines, setLines] = useState(() =>
    (initialLines?.length ? initialLines : [emptyLine()]).map((l) => normalizeLineForForm(l))
  )
  // Vehicle is entered ON the ticket — VIN + Year/Make/Model on one line,
  // Fleet/Unit on the next. No separate vehicle step: on save the
  // ticket's VIN/YMM upserts the Vehicles directory (see store.saveTicket).
  // Initial fields come from the ticket snapshot first, then the linked
  // vehicle record (older tickets whose snapshot lacks YMM).
  const [veh, setVeh] = useState(() => {
    const src = initial || prefill
    const linked = src?.vehicle_id ? vehicles.find((v) => v.id === src.vehicle_id) : null
    return vehicleFieldsFromSnapshot(src?.vehicle_snapshot || null, linked)
  })
  const [status, setStatus] = useState('saved')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState('')
  // Customer picker: type to search — matches drop below, click to pick.
  const [customerQuery, setCustomerQuery] = useState(() => {
    const id = (initial || prefill)?.customer_id || (initial || prefill ? null : customers[0]?.id)
    return customers.find((c) => c.id === id)?.company || ''
  })
  const [customerOpen, setCustomerOpen] = useState(false)
  const [customerHi, setCustomerHi] = useState(0)
  // Walk-in / one-off mode: no customer record — just a name + phone on the
  // ticket (stored in customer_snapshot, customer_id = null). No customer
  // record is created and the customer list is not polluted with one-offs.
  const [walkIn, setWalkIn] = useState(() => {
    const src = initial || prefill
    return !!src && isWalkInTicket(src)
  })
  const [walkInFields, setWalkInFields] = useState(() => {
    const src = initial || prefill
    const s = src?.customer_snapshot || {}
    return {
      name: s.contact_name || s.company || '',
      phone: s.phone || '',
      email: s.email || '',
    }
  })
  // Save this walk-in as a real customer (unchecked by default — one-offs
  // stay one-offs). On save, the buyer becomes a customer record (Retail
  // or Fleet) and the ticket links to it, so their history builds up.
  const [saveAsCustomer, setSaveAsCustomer] = useState(false)
  const [saveAsType, setSaveAsType] = useState('Retail')
  // If a customer with this phone/email already exists, saving will link
  // to them instead of creating a duplicate — say so up front.
  const walkInExistingCustomer = useMemo(
    () => (walkIn ? findCustomerByPhoneOrEmail(customers, contacts, walkInFields.phone, walkInFields.email) : null),
    [walkIn, customers, contacts, walkInFields.phone, walkInFields.email] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const customer = customers.find((c) => c.id === ticket.customer_id) || null
  const vinNorm = normalizeVin(veh.vin)
  // A VIN already on file (prefer this customer's record) auto-fills the
  // YMM/unit fields — blank ones only, never overwriting what was typed.
  // Walk-ins have no customer, so any record for the VIN is the fallback.
  const vinMatch = useMemo(
    () => findVehicleByVin(vehicles, veh.vin, walkIn ? null : ticket.customer_id),
    [vehicles, veh.vin, ticket.customer_id, walkIn] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const vinMatchOtherCustomer = !!(vinMatch && ticket.customer_id && vinMatch.customer_id !== ticket.customer_id)
  const lastAutofillVin = useRef('')
  useEffect(() => {
    if (!vinMatch || vinNorm === lastAutofillVin.current) return
    lastAutofillVin.current = vinNorm
    setVeh((v) => ({
      ...v,
      year: v.year || vinMatch.year || '',
      make: v.make || vinMatch.make || '',
      model: v.model || vinMatch.model || '',
      fleet_unit: v.fleet_unit || vinMatch.fleet_unit || '',
    }))
    setTicket((t) => (t.vehicle_id === vinMatch.id ? t : { ...t, vehicle_id: vinMatch.id }))
    setStatus('unsaved')
  }, [vinMatch, vinNorm]) // eslint-disable-line react-hooks/exhaustive-deps
  const totals = useMemo(() => computeTotals(lines, taxRate), [lines, taxRate])
  // Suggestions: companies — or their contacts — starting with what was
  // typed come first, then ones that just contain it. Empty query shows
  // the first few alphabetically, so clicking the box lists customers.
  const customerSuggestions = useMemo(() => {
    const q = customerQuery.trim().toLowerCase()
    const scored = customers.map((c) => {
      const names = [c.company, ...contacts.filter((ct) => ct.customer_id === c.id).map((ct) => ct.name || '')]
      const hay = names.map((n) => (n || '').toLowerCase())
      return {
        c,
        starts: q !== '' && hay.some((n) => n.startsWith(q)),
        contains: q === '' || hay.some((n) => n.includes(q)),
      }
    }).filter((s) => s.contains)
    scored.sort((a, b) => (b.starts - a.starts) || a.c.company.localeCompare(b.c.company))
    return scored.map((s) => s.c)
  }, [customers, contacts, customerQuery])
  const shownSuggestions = customerSuggestions.slice(0, 8)

  function pickCustomer(c) {
    patch({ customer_id: c.id })
    setCustomerQuery(c.company)
    setCustomerOpen(false)
  }

  // Edit rules: Sales edit Open quotes and Draft / Issued / Partially Paid
  // invoices. Lost quotes and converted quotes (won — they live as invoices
  // now) are locked to Sales, as are Paid / Void / closed-period invoices
  // (the DB invoice_guard enforces this too). Admin may correct any ticket
  // except a Void one; Admin edits to a Paid invoice keep a revision/audit
  // trail via the audit trigger.
  const lockedForSales =
    initial && (
      (isQuote && (initial.status !== 'Open' || initial.converted_invoice_id)) ||
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

  async function save(e) {
    e?.preventDefault()
    if (walkIn) {
      if (!walkInFields.name.trim()) { setError('Walk-in needs a name.'); return }
      if (!walkInFields.phone.trim()) { setError('Walk-in needs a phone number.'); return }
    } else if (!ticket.customer_id) { setError('Choose a customer first.'); return }
    if (!lines.some((l) => String(l.description || '').trim())) { setError('Add at least one line item.'); return }
    setError('')
    setConflict('')
    setStatus('saving')
    try {
      // Snapshots freeze once a ticket leaves its open state — for quotes
      // that is any status other than Open (Lost, or already converted to
      // an invoice and won); for invoices, any status other than Draft.
      // A frozen snapshot is kept exactly as it was, so later customer /
      // vehicle edits don't rewrite history.
      const snapshotFrozen = initial && (initial.converted_invoice_id || (isQuote ? initial.status !== 'Open' : initial.status !== 'Draft'))
      // Walk-in: the snapshot IS the customer (name + phone live nowhere
      // else), built fresh from the fields — except on a frozen walk-in
      // ticket, where the snapshot is kept as it was.
      // Customer-linked: frozen snapshot on frozen tickets, fresh from
      // the customer record otherwise.
      const snapCustomer = walkIn
        ? (initial && !prefill && snapshotFrozen && isWalkInTicket(initial)
            ? initial.customer_snapshot
            : walkInCustomerSnapshot(walkInFields.name, walkInFields.phone, walkInFields.email))
        : initial && snapshotFrozen
          ? initial.customer_snapshot
          : customerSnapshot(customer, contacts, addresses)
      // The vehicle snapshot is ALWAYS built from this ticket's own vehicle
      // fields — these fields are the ticket, so editing them here is what
      // changes the snapshot (and, on save, upserts the Vehicles directory).
      const snapVehicle = vehicleSnapshotFromFields(veh, ticket.vehicle_id || vinMatch?.id || null)
      const saved = await store.saveTicket(
        kind,
        { ...ticket, customer_id: walkIn ? null : ticket.customer_id, tax_rate: taxRate, customer_snapshot: snapCustomer, vehicle_snapshot: snapVehicle },
        lines,
        user?.id
      )
      // Walk-in + "save as customer": the ticket is saved first (as a
      // walk-in), then the buyer becomes a customer record and the ticket
      // links to it. If that second step fails, the ticket itself is still
      // saved — say so and keep the form open so it can be retried.
      if (walkIn && saveAsCustomer) {
        try {
          const linked = await store.saveWalkInAsCustomer(kind, saved, saveAsType, user?.id)
          setTicket(linked.ticket)
          setStatus('saved')
          onSaved(linked.ticket, { savedAsCustomer: linked.customer, linkedExisting: linked.linkedExisting })
          return
        } catch (saveErr) {
          setTicket(saved)
          setStatus('saved')
          setError(`Ticket saved as a walk-in, but saving the customer failed: ${saveErr.message || 'Save failed.'} Close and use "Save as customer" on the ticket to retry.`)
          return
        }
      }
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
          Change the VIN and Year/Make/Model below for this fleet unit, then Save. A new number is assigned on save; the original {isQuote ? 'quote' : 'invoice'} is unchanged.
        </div>
      )}
      {readOnly && <div className="warn">This ticket is locked for editing ({initial?.status}{initial?.accounting_period_closed ? ' · closed period' : ''}). {isAdmin ? 'Admin: you can still correct it — the change is logged.' : 'Ask an Admin to correct it.'}</div>}
      {initial && <p className="muted small">Created by {profiles.find((p) => p.id === initial.created_by)?.name || '—'} · Salesperson {profiles.find((p) => p.id === initial.salesperson_id)?.name || '—'} · Version {initial.version} · {initial.updated_at ? `Last updated ${initial.updated_at.slice(0, 10)}` : ''}</p>}

      <div className="form-grid">
        <div>
          <label>Customer *</label>
          <div className="row" role="group" aria-label="Customer type">
            <button type="button" className={walkIn ? 'btn secondary' : 'btn'} disabled={readOnly} onClick={() => { setWalkIn(false); setStatus('unsaved') }}>Pick a customer</button>
            <button type="button" className={walkIn ? 'btn' : 'btn secondary'} disabled={readOnly} onClick={() => { setWalkIn(true); setStatus('unsaved') }}>Walk-in — no customer record</button>
          </div>
          {walkIn ? (
            <>
              <label>Name *</label>
              <input value={walkInFields.name} disabled={readOnly} autoComplete="off" placeholder="Buyer's name" onChange={(e) => { setWalkInFields((f) => ({ ...f, name: e.target.value })); setStatus('unsaved') }} onBlur={(e) => { const v = titleCaseName(e.target.value); if (v !== e.target.value) { setWalkInFields((f) => ({ ...f, name: v })); setStatus('unsaved') } }} />
              <label>Phone *</label>
              <input value={walkInFields.phone} disabled={readOnly} autoComplete="off" placeholder="Phone number" onChange={(e) => { setWalkInFields((f) => ({ ...f, phone: e.target.value })); setStatus('unsaved') }} />
              <label>Email (optional)</label>
              <input value={walkInFields.email} disabled={readOnly} autoComplete="off" placeholder="Email (optional)" onChange={(e) => { setWalkInFields((f) => ({ ...f, email: e.target.value })); setStatus('unsaved') }} />
              <label style={{ marginTop: 12 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={saveAsCustomer} disabled={readOnly} onChange={(e) => { setSaveAsCustomer(e.target.checked); setStatus('unsaved') }} />{' '}
                Save this person as a customer for next time
              </label>
              {saveAsCustomer && (
                <>
                  <label>Customer type</label>
                  <div className="row" role="group" aria-label="New customer type">
                    <label style={{ margin: 0 }}>
                      <input type="radio" name="wi-type" style={{ width: 'auto' }} checked={saveAsType === 'Retail'} disabled={readOnly} onChange={() => setSaveAsType('Retail')} /> Retail
                    </label>
                    <label style={{ margin: 0 }}>
                      <input type="radio" name="wi-type" style={{ width: 'auto' }} checked={saveAsType === 'Fleet'} disabled={readOnly} onChange={() => setSaveAsType('Fleet')} /> Fleet
                    </label>
                  </div>
                  {walkInExistingCustomer ? (
                    <p className="muted small">A customer with this phone/email already exists ({walkInExistingCustomer.company} — {customerTypeOf(walkInExistingCustomer)}). Saving will link this ticket to them instead of creating a duplicate.</p>
                  ) : (
                    <p className="muted small">On save, a {saveAsType} customer record is created from this name + phone, and this ticket links to it — so next time they come back you can look up everything they've bought.</p>
                  )}
                </>
              )}
              <p className="muted small">Walk-in / one-off — no customer record is created unless you check the box above. The name and phone print on the ticket and are searchable.</p>
            </>
          ) : (
            <>
              <div className="combo" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setCustomerOpen(false) }}>
                <input
                  value={customerQuery}
                  disabled={readOnly}
                  autoComplete="off"
                  placeholder="Type a customer name — e.g. rei…"
                  onFocus={() => { setCustomerOpen(true); setCustomerHi(0) }}
                  onChange={(e) => {
                    const v = e.target.value
                    setCustomerQuery(v)
                    setCustomerOpen(true)
                    setCustomerHi(0)
                    if (!v.trim()) patch({ customer_id: '' })
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setCustomerOpen(true); setCustomerHi((h) => Math.min(h + 1, shownSuggestions.length - 1)) }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setCustomerHi((h) => Math.max(h - 1, 0)) }
                    else if (e.key === 'Enter') { e.preventDefault(); if (customerOpen && shownSuggestions[customerHi]) pickCustomer(shownSuggestions[customerHi]) }
                    else if (e.key === 'Escape') { setCustomerOpen(false) }
                  }}
                />
                {customerQuery && !readOnly && (
                  <button type="button" className="combo-clear" aria-label="Clear customer" onClick={() => { setCustomerQuery(''); patch({ customer_id: '' }); setCustomerOpen(true) }}>×</button>
                )}
                {customerOpen && !readOnly && (
                  <div className="combo-list" role="listbox">
                    {shownSuggestions.length === 0 ? (
                      <div className="combo-item muted">No customers match “{customerQuery.trim()}”. Try fewer letters, or use Walk-in below.</div>
                    ) : (
                      shownSuggestions.map((c, i) => (
                        <div
                          key={c.id} role="option" aria-selected={i === customerHi}
                          className={`combo-item${i === customerHi ? ' active' : ''}${c.id === ticket.customer_id ? ' selected' : ''}`}
                          onMouseDown={(e) => { e.preventDefault(); pickCustomer(c) }}
                          onMouseEnter={() => setCustomerHi(i)}
                        >
                          <strong>{c.company}</strong> <span className="pill">{customerTypeOf(c)}</span>
                          <span className="muted small"> · {c.payment_terms}{c.tax_exempt ? ' · Tax exempt' : ''}</span>
                        </div>
                      ))
                    )}
                    {customerSuggestions.length > shownSuggestions.length && (
                      <div className="combo-foot muted small">Showing {shownSuggestions.length} of {customerSuggestions.length} matches — keep typing to narrow it down.</div>
                    )}
                  </div>
                )}
              </div>
              {customer && <p className="muted small">{customer.payment_terms} · {customer.tax_exempt ? 'Tax exempt' : 'Taxable'}{customer.po_requirements ? ` · PO: ${customer.po_requirements}` : ''}</p>}
            </>
          )}
        </div>
      </div>

      <h3>Vehicle</h3>
      <div className="vehicle-row" style={prefill ? { outline: '2px solid #e67e22', outlineOffset: 4, borderRadius: 4, padding: 4 } : undefined}>
        <div>
          <label>VIN</label>
          <input
            value={veh.vin || ''} disabled={readOnly} autoFocus={!!prefill} autoComplete="off"
            placeholder="Type the full VIN — Year/Make/Model fill in if it's already on file"
            onChange={(e) => {
              const v = normalizeVin(e.target.value)
              setVeh((prev) => ({ ...prev, vin: v }))
              if (!findVehicleByVin(vehicles, v, walkIn ? null : ticket.customer_id)) {
                setTicket((t) => (t.vehicle_id ? { ...t, vehicle_id: '' } : t))
              }
              setStatus('unsaved')
            }}
          />
        </div>
        <div>
          <label>Year</label>
          <input type="number" min="1900" max="2100" value={veh.year ?? ''} disabled={readOnly} onChange={(e) => { setVeh((v) => ({ ...v, year: e.target.value })); setStatus('unsaved') }} />
        </div>
        <div>
          <label>Make</label>
          <input value={veh.make || ''} disabled={readOnly} placeholder="Ford" onChange={(e) => { setVeh((v) => ({ ...v, make: e.target.value })); setStatus('unsaved') }} />
        </div>
        <div>
          <label>Model</label>
          <input value={veh.model || ''} disabled={readOnly} placeholder="F-250" onChange={(e) => { setVeh((v) => ({ ...v, model: e.target.value })); setStatus('unsaved') }} />
        </div>
      </div>
      <div>
        <label>Fleet / unit number (optional)</label>
        <input value={veh.fleet_unit || ''} disabled={readOnly} onChange={(e) => { setVeh((v) => ({ ...v, fleet_unit: e.target.value })); setStatus('unsaved') }} />
      </div>
      {vinMatch && <p className="muted small">Found in Vehicles — Year/Make/Model filled in from that record. Edit anything here if it's wrong; saving updates the vehicle record too.</p>}
      {vinMatchOtherCustomer && <div className="warn">This VIN is already on file under a different customer ({vinMatch.year || ''} {vinMatch.make || ''} {vinMatch.model || ''}). You can still save — check it's not a typo or the wrong customer.</div>}
      {vinNorm && vinNorm.length !== 17 && <div className="warn">This VIN is {vinNorm.length} characters — a full VIN is 17. Check for a typo. You can still save.</div>}
      {!vinNorm && <p className="muted small">VIN can be left blank if it's not known yet — no vehicle record is created until a VIN is entered. When you save with a VIN, the vehicle shows up in the Vehicles tab automatically.</p>}
      {prefill && <p className="muted small">Change the VIN above for this fleet unit — Year/Make/Model fill in if that VIN is already on file.</p>}

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
              <label>Labor $ (optional — per line)</label>
              <input type="number" min="0" step="0.01" value={line.labor_amount || ''} disabled={readOnly} placeholder="0.00" onChange={(e) => updateLine(i, { labor_amount: Number(e.target.value) || 0 })} />
            </div>
            <div>
              <label>Taxable</label>
              <input type="checkbox" style={{ width: 'auto' }} checked={!!line.taxable} disabled={readOnly} onChange={(e) => updateLine(i, { taxable: e.target.checked })} /> Taxable (7.74% on parts only)
            </div>
          </div>
          <div className="row-between">
            <strong>Amount: ${money(lineTotal(line))}{laborAmount(line) ? ` + Labor $${money(laborAmount(line))}` : ''}</strong>
            {!readOnly && <button type="button" className="btn secondary" onClick={() => { setLines(lines.filter((_, idx) => idx !== i)); setStatus('unsaved') }}>Remove line</button>}
          </div>
        </div>
      ))}
      {!readOnly && <button type="button" className="btn secondary" onClick={() => { setLines([...lines, emptyLine()]); setStatus('unsaved') }}>+ Add line</button>}

      <h3>Totals</h3>
      <table>
        <tbody>
          <tr><td>Subtotal</td><td style={{ textAlign: 'right' }}>${money(totals.subtotal)}</td></tr>
          <tr><td>Tax ({(taxRate * 100).toFixed(2)}%) — taxable lines only</td><td style={{ textAlign: 'right' }}>${money(totals.taxTotal)}</td></tr>
          <tr><td>Labor (sum of the Labor $ on each line)</td><td style={{ textAlign: 'right' }}>${money(totals.labor)}</td></tr>
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
        {initial && onConvert && <button className="btn" type="button" onClick={onConvert}>Convert to invoice</button>}
        <button className="btn secondary" type="button" onClick={onCancel}>Close</button>
      </div>
      {initial && onDelete && (
        <div className="danger-zone">
          {!confirmDelete ? (
            <button className="btn secondary small" type="button" onClick={() => setConfirmDelete(true)}>Delete this {isQuote ? 'quote' : 'draft invoice'}…</button>
          ) : (
            <span>
              Delete this {isQuote ? 'quote' : 'draft invoice'}? This cannot be undone.{' '}
              <button className="btn danger small" type="button" onClick={onDelete}>Yes, delete</button>{' '}
              <button className="btn secondary small" type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}
      {!initial && <p className="muted small">Saving assigns the number automatically ({isQuote ? 'quotes QT-A…' : 'invoices INV-…'}) — numbers are never typed in by hand.{prefill ? ` This is a copy of ${prefill.sourceLabel}; the original is unchanged.` : ''}</p>}
    </form>
  )
}
