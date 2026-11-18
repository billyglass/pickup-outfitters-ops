import { useEffect, useMemo, useRef, useState } from 'react'
import { store } from '../lib/store.js'
import { ageDays, duplicateTicket, ticketCustomerName, isWalkInTicket, customerTypeOf } from '../lib/tickets.js'
import TicketForm from './TicketForm.jsx'
import TicketPrint from './TicketPrint.jsx'
import SaveWalkInAsCustomer from './SaveWalkInAsCustomer.jsx'

const STATUSES = ['Draft', 'Sent', 'Accepted', 'Declined', 'Expired']

export default function Quotes({ data, user, profile, isAdmin, settings, onReload, onError, openQuoteId, onOpened, onOpenInvoice }) {
  const [editing, setEditing] = useState(undefined) // undefined=list, null=new, object=edit
  // Open a specific quote on mount (e.g. clicked from the Vehicles tab).
  const openedRef = useRef(false)
  useEffect(() => {
    if (!openQuoteId || openedRef.current) return
    const q = data.quotes.find((x) => x.id === openQuoteId)
    if (q) { openedRef.current = true; setEditing(q); onOpened?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [duplicating, setDuplicating] = useState(null) // { ticket, lines, sourceLabel } or null
  const [printing, setPrinting] = useState(null)
  const [fCustomer, setFCustomer] = useState('')
  const [fSales, setFSales] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fAge, setFAge] = useState('')
  const [outstandingOnly, setOutstandingOnly] = useState(true)
  const [busy, setBusy] = useState('')
  const [convertMsg, setConvertMsg] = useState('')
  const [convertedInvoice, setConvertedInvoice] = useState(null) // { id, number } of the invoice just created / already linked
  const [saveAs, setSaveAs] = useState(null) // walk-in quote to save as a customer

  const nameOf = (id) => data.profiles?.find((p) => p.id === id)?.name || '—'
  // Walk-in quotes show the buyer's name from the snapshot, with a tag.
  const customerOf = (q) => ticketCustomerName(q, data.customers)
  const linesOf = (id) => (data.quoteLines || []).filter((l) => l.quote_id === id)

  const filtered = useMemo(() => {
    return data.quotes.filter((q) => {
      if (outstandingOnly && !['Draft', 'Sent', 'Accepted'].includes(q.status)) return false
      if (fCustomer === 'walk-in' && q.customer_id) return false
      if (fCustomer && fCustomer !== 'walk-in' && q.customer_id !== fCustomer) return false
      if (fSales && q.salesperson_id !== fSales) return false
      if (fStatus && q.status !== fStatus) return false
      if (fAge) {
        const age = ageDays(q.issue_date || (q.created_at || '').slice(0, 10)) ?? 0
        if (fAge === '<7' && age >= 7) return false
        if (fAge === '7-30' && (age < 7 || age > 30)) return false
        if (fAge === '31-60' && (age < 31 || age > 60)) return false
        if (fAge === '60+' && age < 60) return false
      }
      return true
    })
  }, [data.quotes, outstandingOnly, fCustomer, fSales, fStatus, fAge])

  const outstanding = data.quotes.filter((q) => ['Draft', 'Sent', 'Accepted'].includes(q.status))
  const outstandingValue = outstanding.reduce((s, q) => s + Number(q.total || 0), 0)

  async function setStatus(q, status) {
    setBusy(q.id)
    try {
      await store.setTicketStatus('quote', q, status, user?.id)
      await onReload()
    } catch (err) { onError(err.message || 'Status change failed.') } finally { setBusy('') }
  }

  // Convert is on EVERY open quote, not just Accepted ones — Bill couldn't
  // find the button because Draft/Sent quotes had none. Draft/Sent quotes
  // convert too, but only after confirming they should be marked Accepted.
  // Declined/Expired quotes never convert. Already-converted quotes show
  // the invoice instead of converting again.
  const canConvert = (q) => !q.converted_invoice_id && !['Declined', 'Expired'].includes(q.status)
  const convertedInvoiceOf = (q) => data.invoices.find((i) => i.id === q.converted_invoice_id) || null

  async function convert(q, opts = {}) {
    if (q.converted_invoice_id) {
      const existing = convertedInvoiceOf(q)
      setConvertedInvoice(existing ? { id: existing.id, number: existing.number } : null)
      setConvertMsg(`This quote was already converted${existing ? ` to invoice ${existing.number}` : ''}.`)
      return
    }
    if (['Declined', 'Expired'].includes(q.status)) return
    if (q.status !== 'Accepted') {
      if (!window.confirm(`Quote ${q.number} hasn't been accepted yet. Convert it to an invoice anyway and mark it Accepted?${opts.fromForm ? ' Save your changes first — unsaved edits on this form won\'t be included.' : ''}`)) return
    } else if (!window.confirm(`Convert quote ${q.number} to an invoice? A new invoice number (INV-…) will be assigned from the invoice sequence. This cannot create a duplicate — if it was already converted, the existing invoice is shown instead.${opts.fromForm ? ' Save your changes first — unsaved edits on this form won\'t be included.' : ''}`)) return
    setBusy(`convert-${q.id}`)
    setConvertMsg('')
    setConvertedInvoice(null)
    try {
      // Draft/Sent quotes become Accepted as part of the conversion.
      const quoteToConvert = q.status === 'Accepted' ? q : { ...q, status: 'Accepted' }
      if (q.status !== 'Accepted') await store.setTicketStatus('quote', q, 'Accepted', user?.id)
      const invoice = await store.convertQuoteToInvoice(quoteToConvert, linesOf(q.id), user?.id, data)
      setConvertedInvoice({ id: invoice.id, number: invoice.number })
      setConvertMsg(`Converted to invoice ${invoice.number}.`)
      await onReload()
    } catch (err) { onError(err.message || 'Conversion failed.') } finally { setBusy('') }
  }

  async function handleDelete(q) {
    if (!isAdmin) return
    if (!window.confirm(`Delete quote ${q.number}? Drafts only — this cannot be undone.`)) return
    try { await store.deleteTicket('quote', q.id, true); await onReload() } catch (err) { onError(err.message || 'Delete failed.') }
  }

  // Fleet duplicate: opens a NEW Draft prefilled from the source — nothing
  // is saved until the user clicks Save, which assigns a new QT-A number.
  function duplicate(q) {
    setEditing(undefined)
    setDuplicating(duplicateTicket('quote', q, linesOf(q.id), user?.id, settings))
  }

  if (printing) {
    const q = printing
    return (
      <TicketPrint
        kind="quote" ticket={q} lines={linesOf(q.id)}
        customer={data.customers.find((c) => c.id === q.customer_id)}
        vehicle={data.vehicles.find((v) => v.id === q.vehicle_id)}
        salespersonName={nameOf(q.salesperson_id)} settings={settings}
        onClose={() => setPrinting(null)}
      />
    )
  }
  if (duplicating) {
    return (
      <TicketForm
        key={`dup-${duplicating.sourceLabel}`}
        kind="quote"
        initial={null}
        prefill={duplicating.ticket}
        lines={duplicating.lines}
        customers={data.customers} vehicles={data.vehicles} contacts={data.contacts} addresses={data.addresses}
        products={data.products || []} profiles={data.profiles || []}
        user={user} profile={profile} isAdmin={isAdmin} settings={settings}
        onSaved={async () => { setDuplicating(null); await onReload() }}
        onCancel={() => setDuplicating(null)}
      />
    )
  }
  if (editing !== undefined) {
    return (
      <TicketForm
        key={editing ? `edit-${editing.id}` : 'new-quote'}
        kind="quote"
        initial={editing}
        lines={editing ? linesOf(editing.id) : undefined}
        customers={data.customers} vehicles={data.vehicles} contacts={data.contacts} addresses={data.addresses}
        products={data.products || []} profiles={data.profiles || []}
        user={user} profile={profile} isAdmin={isAdmin} settings={settings}
        onSaved={async (saved, extra) => {
          setEditing(undefined)
          if (extra?.savedAsCustomer) {
            setConvertMsg(extra.linkedExisting
              ? `Linked ${saved.number} to existing customer ${extra.savedAsCustomer.company} — same phone/email. Their history now includes this quote.`
              : `Saved ${extra.savedAsCustomer.company} as a customer and linked ${saved.number} to them.`)
          }
          await onReload()
        }}
        onCancel={() => setEditing(undefined)}
        onPrint={editing ? () => setPrinting(editing) : undefined}
        onDuplicate={editing ? () => duplicate(editing) : undefined}
        onConvert={editing && canConvert(editing) ? () => convert(editing, { fromForm: true }) : undefined}
      />
    )
  }

  if (saveAs) {
    return (
      <SaveWalkInAsCustomer
        kind="quote" ticket={saveAs} data={data} user={user}
        onDone={async (message) => { setSaveAs(null); setConvertMsg(message); await onReload() }}
        onError={onError}
        onCancel={() => setSaveAs(null)}
      />
    )
  }

  return (
    <div className="card">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Quotes — Outstanding ({outstanding.length}) · ${outstandingValue.toFixed(2)}</h2>
        <button className="btn" onClick={() => setEditing(null)}>+ New quote</button>
      </div>
      <p className="muted small">Outstanding = Draft, Sent, or Accepted. Expires {settings?.quote_validity_days ?? 15} days after the issue date. Every open quote has a Convert to invoice button — converting an Accepted quote creates the invoice with no retyping, and it can only be converted once. A Draft or Sent quote asks first and is marked Accepted when converted. Quotes and invoices have separate numbering — quotes QT-A1001…, invoices INV-1001… — so a quote and an invoice can share the same numeric part and still be different numbers.</p>
      {convertMsg && (
        <div className="success">
          {convertMsg}{' '}
          {convertedInvoice && onOpenInvoice && (
            <button className="btn secondary" style={{ marginLeft: 8 }} onClick={() => onOpenInvoice(convertedInvoice)}>Open invoice {convertedInvoice.number}</button>
          )}
        </div>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <label style={{ margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={outstandingOnly} onChange={(e) => setOutstandingOnly(e.target.checked)} /> Outstanding only</label>
        <select value={fCustomer} onChange={(e) => setFCustomer(e.target.value)}>
          <option value="">All customers</option>
          <option value="walk-in">Walk-in (no customer record)</option>
          {data.customers.map((c) => <option key={c.id} value={c.id}>{c.company} ({customerTypeOf(c)})</option>)}
        </select>
        <select value={fSales} onChange={(e) => setFSales(e.target.value)}>
          <option value="">All salespeople</option>
          {(data.profiles || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={fAge} onChange={(e) => setFAge(e.target.value)}>
          <option value="">Any age</option>
          <option value="<7">&lt; 7 days</option>
          <option value="7-30">7–30 days</option>
          <option value="31-60">31–60 days</option>
          <option value="60+">60+ days</option>
        </select>
      </div>
      <table>
        <thead><tr><th>Quote</th><th>Customer</th><th>Vehicle / VIN</th><th>Date</th><th>Age</th><th>Expires</th><th>Salesperson</th><th>Status</th><th>Total</th><th></th></tr></thead>
        <tbody>
          {filtered.map((q) => {
            const v = data.vehicles.find((x) => x.id === q.vehicle_id)
            const vin = q.vehicle_snapshot?.vin || v?.vin || '—'
            const age = ageDays(q.issue_date || (q.created_at || '').slice(0, 10))
            return (
              <tr key={q.id}>
                <td><strong>{q.number}</strong>{q.converted_invoice_id ? <div className="muted small">→ converted</div> : ''}</td>
                <td>{customerOf(q)}{isWalkInTicket(q) && <div className="muted small">Walk-in</div>}</td>
                <td>{v ? `${v.year || ''} ${v.make || ''} ${v.model || ''}` : '—'}<div className="muted small">VIN {vin}</div></td>
                <td>{q.issue_date || (q.created_at || '').slice(0, 10)}</td>
                <td>{age ?? '—'}d</td>
                <td>{q.expires_on || '—'}</td>
                <td>{nameOf(q.salesperson_id)}</td>
                <td>{q.status}</td>
                <td>${Number(q.total || 0).toFixed(2)}</td>
                <td>
                  <div className="row">
                    <button className="btn secondary" onClick={() => setEditing(q)}>Open</button>
                    <button className="btn secondary" onClick={() => setPrinting(q)}>Print</button>
                    <button className="btn secondary" onClick={() => duplicate(q)}>Duplicate</button>
                    {isWalkInTicket(q) && <button className="btn secondary" onClick={() => setSaveAs(q)}>Save as customer</button>}
                    {q.status === 'Draft' && <button className="btn secondary" disabled={busy === q.id} onClick={() => setStatus(q, 'Sent')}>Send</button>}
                    {q.status === 'Sent' && <button className="btn secondary" disabled={busy === q.id} onClick={() => setStatus(q, 'Accepted')}>Accept</button>}
                    {['Draft', 'Sent'].includes(q.status) && <button className="btn secondary" disabled={busy === q.id} onClick={() => setStatus(q, 'Declined')}>Decline</button>}
                    {canConvert(q) && (
                      <button className="btn" disabled={busy === `convert-${q.id}`} onClick={() => convert(q)}>Convert to invoice</button>
                    )}
                    {q.converted_invoice_id && (
                      convertedInvoiceOf(q) && onOpenInvoice ? (
                        <button className="btn secondary" onClick={() => onOpenInvoice(convertedInvoiceOf(q))}>Converted — {convertedInvoiceOf(q).number}</button>
                      ) : (
                        <span className="muted small">Converted</span>
                      )
                    )}
                    {isAdmin && q.status === 'Draft' && <button className="btn danger" onClick={() => handleDelete(q)}>Delete</button>}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {filtered.length === 0 && <p className="muted">No quotes match these filters.</p>}
    </div>
  )
}
