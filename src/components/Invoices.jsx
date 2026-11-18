import { useEffect, useMemo, useRef, useState } from 'react'
import { store } from '../lib/store.js'
import { isOverdue, duplicateTicket, ticketCustomerName, isWalkInTicket, customerTypeOf } from '../lib/tickets.js'
import TicketForm from './TicketForm.jsx'
import TicketPrint from './TicketPrint.jsx'
import SaveWalkInAsCustomer from './SaveWalkInAsCustomer.jsx'

const STATUSES = ['Draft', 'Issued', 'Partially Paid', 'Paid', 'Void']

export default function Invoices({ data, user, profile, isAdmin, settings, onReload, onError, openInvoiceId, onOpened }) {
  const [editing, setEditing] = useState(undefined)
  // Open a specific invoice on mount (e.g. clicked from the Vehicles tab).
  const openedRef = useRef(false)
  useEffect(() => {
    if (!openInvoiceId || openedRef.current) return
    const inv = data.invoices.find((i) => i.id === openInvoiceId)
    if (inv) { openedRef.current = true; setEditing(inv); onOpened?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [duplicating, setDuplicating] = useState(null) // { ticket, lines, sourceLabel } or null
  const [printing, setPrinting] = useState(null)
  const [fCustomer, setFCustomer] = useState('')
  const [fSales, setFSales] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fFrom, setFFrom] = useState('')
  const [fTo, setFTo] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [voiding, setVoiding] = useState(null)
  const [voidReason, setVoidReason] = useState('')
  const [busy, setBusy] = useState('')
  const [saveAs, setSaveAs] = useState(null) // walk-in invoice to save as a customer
  const [msg, setMsg] = useState('')

  const nameOf = (id) => data.profiles?.find((p) => p.id === id)?.name || '—'
  // Walk-in invoices show the buyer's name from the snapshot, with a tag.
  const customerOf = (inv) => ticketCustomerName(inv, data.customers)
  const linesOf = (id) => (data.invoiceLines || []).filter((l) => l.invoice_id === id)

  const filtered = useMemo(() => {
    return data.invoices.filter((inv) => {
      if (fCustomer === 'walk-in' && inv.customer_id) return false
      if (fCustomer && fCustomer !== 'walk-in' && inv.customer_id !== fCustomer) return false
      if (fSales && inv.salesperson_id !== fSales) return false
      if (fStatus && inv.status !== fStatus) return false
      const d = inv.issue_date || (inv.created_at || '').slice(0, 10)
      if (fFrom && d < fFrom) return false
      if (fTo && d > fTo) return false
      if (overdueOnly && !isOverdue(inv)) return false
      return true
    })
  }, [data.invoices, fCustomer, fSales, fStatus, fFrom, fTo, overdueOnly])

  const open = data.invoices.filter((i) => ['Draft', 'Issued', 'Partially Paid'].includes(i.status))
  const openValue = open.reduce((s, i) => s + Number(i.balance_due ?? i.total ?? 0), 0)
  const overdue = data.invoices.filter((i) => isOverdue(i))

  async function issue(inv) {
    setBusy(inv.id)
    try { await store.setTicketStatus('invoice', inv, 'Issued', user?.id); await onReload() }
    catch (err) { onError(err.message || 'Issue failed.') } finally { setBusy('') }
  }

  async function doVoid() {
    if (!voiding || !voidReason.trim()) { onError('A reason is required to void an invoice.'); return }
    setBusy(`void-${voiding.id}`)
    try {
      // Void keeps the record, its number, and its history — it is never
      // renumbered and its number is never recycled.
      await store.setTicketStatus('invoice', voiding, 'Void', user?.id, { void_reason: voidReason.trim() })
      setVoiding(null); setVoidReason('')
      await onReload()
    } catch (err) { onError(err.message || 'Void failed.') } finally { setBusy('') }
  }

  async function handleDelete(inv) {
    if (!isAdmin) return
    if (!window.confirm(`Delete draft invoice ${inv.number}? Drafts only — this cannot be undone.`)) return
    try { await store.deleteTicket('invoice', inv.id, true); await onReload() } catch (err) { onError(err.message || 'Delete failed.') }
  }

  // Fleet duplicate: opens a NEW Draft prefilled from the source — nothing
  // is saved until the user clicks Save, which assigns a new INV- number.
  // Void / Paid sources are fine to copy; the copy is always a fresh Draft.
  function duplicate(inv) {
    setEditing(undefined)
    setDuplicating(duplicateTicket('invoice', inv, linesOf(inv.id), user?.id, settings))
  }

  if (printing) {
    const inv = printing
    return (
      <TicketPrint
        kind="invoice" ticket={inv} lines={linesOf(inv.id)}
        customer={data.customers.find((c) => c.id === inv.customer_id)}
        vehicle={data.vehicles.find((v) => v.id === inv.vehicle_id)}
        salespersonName={nameOf(inv.salesperson_id)} settings={settings}
        onClose={() => setPrinting(null)}
      />
    )
  }
  if (duplicating) {
    return (
      <TicketForm
        key={`dup-${duplicating.sourceLabel}`}
        kind="invoice"
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
        key={editing ? `edit-${editing.id}` : 'new-invoice'}
        kind="invoice"
        initial={editing}
        lines={editing ? linesOf(editing.id) : undefined}
        customers={data.customers} vehicles={data.vehicles} contacts={data.contacts} addresses={data.addresses}
        products={data.products || []} profiles={data.profiles || []}
        user={user} profile={profile} isAdmin={isAdmin} settings={settings}
        onSaved={async (saved, extra) => {
          setEditing(undefined)
          if (extra?.savedAsCustomer) {
            setMsg(extra.linkedExisting
              ? `Linked ${saved.number} to existing customer ${extra.savedAsCustomer.company} — same phone/email. Their history now includes this invoice.`
              : `Saved ${extra.savedAsCustomer.company} as a customer and linked ${saved.number} to them.`)
          }
          await onReload()
        }}
        onCancel={() => setEditing(undefined)}
        onPrint={editing ? () => setPrinting(editing) : undefined}
        onDuplicate={editing ? () => duplicate(editing) : undefined}
      />
    )
  }

  if (saveAs) {
    return (
      <SaveWalkInAsCustomer
        kind="invoice" ticket={saveAs} data={data} user={user}
        onDone={async (message) => { setSaveAs(null); setMsg(message); await onReload() }}
        onError={onError}
        onCancel={() => setSaveAs(null)}
      />
    )
  }

  return (
    <div className="card">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Invoices — Open ({open.length}) · ${openValue.toFixed(2)} · Overdue ({overdue.length})</h2>
        <button className="btn" onClick={() => setEditing(null)}>+ New invoice</button>
      </div>
      <p className="muted small">Numbers are assigned atomically on save from the invoice sequence (INV-1001…), separate from quotes (QT-A1001…). Voiding keeps the record, its number, and its history — numbers are never reused and other records are never renumbered. Payments are Phase 3 (Admin only). Duplicate opens a new Draft with everything copied — change the vehicle / VIN for the next fleet unit, then Save.</p>
      {msg && <div className="success">{msg}</div>}
      {voiding && (
        <div className="card" style={{ border: '2px solid #b3261e' }}>
          <h3 style={{ marginTop: 0 }}>Void invoice {voiding.number}?</h3>
          <p className="muted">Voiding is for issued or paid invoices that must not be deleted. The record, number, and history stay in the system.</p>
          <label>Reason (required)</label>
          <input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="e.g. Issued in error — reissued as INV-…" />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn danger" disabled={busy === `void-${voiding.id}`} onClick={doVoid}>Void invoice</button>
            <button className="btn secondary" onClick={() => { setVoiding(null); setVoidReason('') }}>Cancel</button>
          </div>
        </div>
      )}
      <div className="row filters" style={{ marginTop: 12 }}>
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
        <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} aria-label="From date" />
        <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} aria-label="To date" />
        <label style={{ margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Overdue only</label>
      </div>
      <div className="table-scroll">
      <table className="list">
        <thead><tr><th className="nowrap">Invoice</th><th>Customer</th><th>Vehicle / VIN</th><th className="nowrap">Issued</th><th className="nowrap">Due</th><th className="nowrap">Salesperson</th><th className="nowrap">Status</th><th className="num">Total</th><th className="num">Balance</th><th></th></tr></thead>
        <tbody>
          {filtered.map((inv) => {
            const v = data.vehicles.find((x) => x.id === inv.vehicle_id)
            const vin = inv.vehicle_snapshot?.vin || v?.vin || '—'
            const overdue = isOverdue(inv)
            return (
              <tr key={inv.id}>
                <td className="nowrap"><strong>{inv.number}</strong>{inv.quote_id && <div className="muted small">from quote</div>}{inv.previous_numbers?.length ? <div className="muted small">was {inv.previous_numbers.join(', ')}</div> : ''}</td>
                <td className="customer" title={customerOf(inv)}>{customerOf(inv)}{isWalkInTicket(inv) && <div className="muted small">Walk-in</div>}</td>
                <td className="vehicle">{v ? `${v.year || ''} ${v.make || ''} ${v.model || ''}` : '—'}<div className="muted small sub">VIN {vin}</div></td>
                <td className="nowrap">{inv.issue_date || (inv.created_at || '').slice(0, 10)}</td>
                <td className="nowrap">{inv.due_date || '—'}{overdue && <div className="pill" style={{ background: '#fdecea', color: '#b3261e' }}>Overdue</div>}</td>
                <td className="nowrap">{nameOf(inv.salesperson_id)}</td>
                <td className="nowrap">{inv.status}{inv.accounting_period_closed ? ' · closed' : ''}</td>
                <td className="num">${Number(inv.total || 0).toFixed(2)}</td>
                <td className="num">${Number(inv.balance_due ?? inv.total ?? 0).toFixed(2)}</td>
                <td>
                  <div className="row actions">
                    <button className="btn secondary small" onClick={() => setEditing(inv)}>Open</button>
                    <button className="btn secondary small" onClick={() => setPrinting(inv)}>Print</button>
                    <button className="btn secondary small" onClick={() => duplicate(inv)}>Duplicate</button>
                    {isWalkInTicket(inv) && <button className="btn secondary small" onClick={() => setSaveAs(inv)}>Save as customer</button>}
                    {inv.status === 'Draft' && <button className="btn secondary small" disabled={busy === inv.id} onClick={() => issue(inv)}>Issue</button>}
                    {isAdmin && inv.status === 'Draft' && <button className="btn danger small" onClick={() => handleDelete(inv)}>Delete</button>}
                    {isAdmin && ['Issued', 'Partially Paid', 'Paid'].includes(inv.status) && (
                      <button className="btn danger small" onClick={() => setVoiding(inv)}>Void…</button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
      {filtered.length === 0 && <p className="muted">No invoices match these filters.</p>}
    </div>
  )
}
