import { useEffect, useMemo, useState } from 'react'
import { store } from '../lib/store.js'
import { fmtDate, money, roundCents, filterPayments, ticketCustomerName } from '../lib/tickets.js'
import CollapsibleCard from './CollapsibleCard.jsx'

// Payments tab (Admin-only, Nov 24) — a separate area from the Invoices
// tab, so Bill's wife can reconcile against QuickBooks. One page, every
// payment anybody has taken, newest first: date, invoice, customer,
// amount, method, reference, who recorded it, note. Recording a payment
// still happens on the invoice itself — this tab is read-only, it just
// shows the money in one place. Admin-only tab, so the "collected in
// this view" total is allowed here (Sales never sees this tab, and never
// sees summed dollars anywhere else either).
const METHODS = ['Cash', 'Check', 'Card', 'Other']

export default function Payments({ data, userId, onOpenInvoice }) {
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [method, setMethod] = useState('')
  const [recordedBy, setRecordedBy] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      setPayments(await store.listAllPayments())
    } catch (err) {
      setError(err.message || 'Could not load payments.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(
    () => filterPayments(payments, { from, to, method, recordedBy }),
    [payments, from, to, method, recordedBy]
  )
  const collected = roundCents(filtered.reduce((s, p) => s + (Number(p.amount) || 0), 0))
  const invoiceById = useMemo(() => new Map((data.invoices || []).map((i) => [i.id, i])), [data.invoices])
  const profileName = (id) => (data.profiles || []).find((p) => p.id === id)?.name || '—'
  const hasFilters = from || to || method || recordedBy
  const clearFilters = () => { setFrom(''); setTo(''); setMethod(''); setRecordedBy('') }

  return (
    <CollapsibleCard id="payments-list" userId={userId} title={<>Payments — {filtered.length}{filtered.length !== payments.length ? ` of ${payments.length}` : ''} · Collected in this view: ${money(collected)}</>} label="Payments list">
      <p className="muted small">Every payment taken, newest first — for reconciling against QuickBooks. Payments are still recorded on the invoice itself; this list just shows them all in one place. Click an invoice number to open that invoice.</p>
      {error && <div className="error">{error}</div>}
      <div className="row filters" style={{ marginTop: 12 }}>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Filter by method">
          <option value="">All methods</option>
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <select value={recordedBy} onChange={(e) => setRecordedBy(e.target.value)} aria-label="Filter by who recorded it">
          <option value="">Recorded by anyone</option>
          {(data.profiles || []).filter((p) => p.active !== false).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {hasFilters && <button type="button" className="btn secondary" onClick={clearFilters}>Clear filters</button>}
      </div>
      {loading ? (
        <p className="muted">Loading payments…</p>
      ) : payments.length === 0 ? (
        <p className="muted">No payments recorded yet — record one from an invoice&apos;s Payments section and it will show up here.</p>
      ) : filtered.length === 0 ? (
        <p className="muted">No payments match these filters.</p>
      ) : (
        <div className="table-scroll">
          <table className="list wide">
            <thead><tr><th className="nowrap">Date</th><th className="nowrap">Invoice</th><th>Customer</th><th className="num">Amount</th><th>Method</th><th>Reference</th><th>Recorded by</th><th>Note</th></tr></thead>
            <tbody>
              {filtered.map((p) => {
                const inv = invoiceById.get(p.invoice_id)
                return (
                  <tr key={p.id}>
                    <td className="nowrap">{fmtDate(p.payment_date)}</td>
                    <td className="nowrap">
                      {inv ? (
                        <button type="button" onClick={() => onOpenInvoice && onOpenInvoice(inv)} style={{ background: 'none', border: 0, padding: 0, color: 'var(--orange-dark)', textDecoration: 'underline', font: 'inherit', fontWeight: 700, cursor: 'pointer' }}>{inv.number}</button>
                      ) : '—'}
                    </td>
                    <td>{inv ? ticketCustomerName(inv, data.customers) : '—'}</td>
                    <td className="num">${money(p.amount)}</td>
                    <td>{p.method || '—'}</td>
                    <td>{p.reference || '—'}</td>
                    <td>{profileName(p.created_by)}</td>
                    <td>{p.note || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </CollapsibleCard>
  )
}
