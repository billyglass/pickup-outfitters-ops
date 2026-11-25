import { useMemo, useState } from 'react'
import { fmtDate, money, ticketCustomerName, customerTypeOf, displayInvoiceStatus } from '../lib/tickets.js'
import { agingBucket, agingBucketLabel, agingSummary, daysPastDue, isAgingInvoice, AGING_BUCKETS } from '../lib/arAging.js'
import ComboBox from './ComboBox.jsx'

// Accounts receivable — Admin-only aging report (Phase 3, Nov 25). One
// page: how much is owed, and how far past due it is. Aging runs off the
// due date, which only starts counting when an invoice is billed
// (Complete & bill) — an Open invoice that hasn't been billed yet sits in
// "Not yet billed", not in Current. Admin-only tab (the App.jsx gate),
// so summed dollars are allowed here; Sales never sees this tab.
// Deliberately NOT built here: payment allocations across invoices,
// customer statements, credit/refund workflows, and export — those are
// separate follow-ups. A second list below the aging table shows what was
// billed today (Nov 25): an invoice counts when its billing date
// (issue_date) is today — Complete & bill hit, or a Draft issued —
// whatever its status now (a job billed and paid in full today still
// counts as pushed through today). Void is excluded; Drafts never qualify
// because they have no billing date yet.
export default function AccountsReceivable({ data, today, onOpenInvoice }) {
  const [bucket, setBucket] = useState('')
  const [fCustomer, setFCustomer] = useState('')

  const aging = useMemo(() => (data.invoices || []).filter(isAgingInvoice), [data.invoices])
  const summary = useMemo(() => agingSummary(data.invoices || [], today), [data.invoices, today])
  const billedToday = useMemo(() => (data.invoices || [])
    .filter((inv) => inv.status !== 'Void' && String(inv.issue_date || '').slice(0, 10) === today)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))), [data.invoices, today])
  const billedTodayTotal = useMemo(() => billedToday.reduce((s, inv) => s + (Number(inv.total) || 0), 0), [billedToday])

  const filtered = useMemo(() => {
    const rows = aging.filter((inv) => {
      if (bucket && agingBucket(inv, today) !== bucket) return false
      if (fCustomer === 'walk-in') return !inv.customer_id
      if (fCustomer) return inv.customer_id === fCustomer
      return true
    })
    // Most overdue first; not-yet-billed rows last (nothing is due on them).
    return rows.sort((a, b) => {
      const da = daysPastDue(a, today)
      const db = daysPastDue(b, today)
      const ka = da === null ? -Infinity : da
      const kb = db === null ? -Infinity : db
      return kb - ka
    })
  }, [aging, bucket, fCustomer, today])

  const hasFilters = bucket || fCustomer
  const clearFilters = () => { setBucket(''); setFCustomer('') }
  const linkStyle = { background: 'none', border: 0, padding: 0, color: 'var(--orange-dark)', textDecoration: 'underline', font: 'inherit', fontWeight: 700, cursor: 'pointer' }

  return (
    <>
    <div className="card">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Accounts receivable — {filtered.length}{filtered.length !== aging.length ? ` of ${aging.length}` : ''} invoices</h2>
      </div>
      <p className="muted small">Open invoices by how far past due they are. Due dates only start counting once an invoice is billed — an open invoice that hasn&apos;t been billed yet shows as Not yet billed. Click an invoice number to open that invoice.</p>
      <div className="stat-strip">
        <div className="stat"><span className="num">${money(summary.total)}</span><span className="label">Total open</span></div>
        {AGING_BUCKETS.map((b) => (
          <div className="stat" key={b}><span className="num">${money(summary.buckets[b])}</span><span className="label">{agingBucketLabel(b)}</span></div>
        ))}
      </div>
      {summary.creditsTotal > 0 && (
        <p className="muted small">Credits (overpaid): ${money(summary.creditsTotal)}</p>
      )}
      <div className="row filters" style={{ marginTop: 12 }}>
        <select value={bucket} onChange={(e) => setBucket(e.target.value)} aria-label="Filter by aging bucket">
          <option value="">All buckets</option>
          {AGING_BUCKETS.map((b) => <option key={b} value={b}>{agingBucketLabel(b)}</option>)}
        </select>
        <ComboBox
          value={fCustomer}
          onChange={setFCustomer}
          placeholder="Search customers…"
          ariaLabel="Filter by customer"
          emptyText="No customers match that — try fewer letters."
          options={[
            { value: '', label: 'All customers' },
            { value: 'walk-in', label: 'Walk-in (no customer record)' },
            ...(data.customers || []).map((c) => ({ value: c.id, label: c.company, tag: customerTypeOf(c) })),
          ]}
        />
        {hasFilters && <button type="button" className="btn secondary" onClick={clearFilters}>Clear filters</button>}
      </div>
      {aging.length === 0 ? (
        <p className="muted">No open balances — nothing is owed right now.</p>
      ) : filtered.length === 0 ? (
        <p className="muted">No invoices match these filters.</p>
      ) : (
        <div className="table-scroll">
          <table className="list wide">
            <thead><tr><th className="nowrap">Invoice</th><th>Customer</th><th className="nowrap">Billed</th><th className="nowrap">Due</th><th className="num">Days past due</th><th>Bucket</th><th className="num">Balance due</th></tr></thead>
            <tbody>
              {filtered.map((inv) => {
                const dpd = daysPastDue(inv, today)
                return (
                  <tr key={inv.id}>
                    <td className="nowrap">
                      <button type="button" onClick={() => onOpenInvoice && onOpenInvoice(inv)} style={linkStyle}>{inv.number}</button>
                    </td>
                    <td>{ticketCustomerName(inv, data.customers)}</td>
                    <td className="nowrap">{fmtDate(inv.issue_date)}</td>
                    <td className="nowrap">{fmtDate(inv.due_date)}</td>
                    <td className="num">{dpd !== null && dpd > 0 ? dpd : '—'}</td>
                    <td>{agingBucketLabel(agingBucket(inv, today))}</td>
                    <td className="num">${money(inv.balance_due ?? inv.total ?? 0)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
    <div className="card">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Billed today ({billedToday.length}) · ${money(billedTodayTotal)} billed</h2>
      </div>
      <p className="muted small">Invoices billed today — Complete &amp; bill hit, or a Draft issued — newest first. Click an invoice number to open that invoice.</p>
      {billedToday.length === 0 ? (
        <p className="muted">Nothing billed yet today.</p>
      ) : (
        <div className="table-scroll">
          <table className="list wide">
            <thead><tr><th className="nowrap">Invoice</th><th>Customer</th><th>Status</th><th className="num">Total</th><th className="num">Balance due</th><th className="nowrap">Due</th></tr></thead>
            <tbody>
              {billedToday.map((inv) => (
                <tr key={inv.id}>
                  <td className="nowrap">
                    <button type="button" onClick={() => onOpenInvoice && onOpenInvoice(inv)} style={linkStyle}>{inv.number}</button>
                  </td>
                  <td>{ticketCustomerName(inv, data.customers)}</td>
                  <td>{inv.status === 'Paid' ? <span style={{ color: '#1e7e34', fontWeight: 700 }}>Paid</span> : displayInvoiceStatus(inv.status)}</td>
                  <td className="num">${money(inv.total)}</td>
                  <td className="num">{inv.status === 'Paid' && Number(inv.balance_due ?? inv.total ?? 0) === 0 ? <span style={{ color: '#1e7e34', fontWeight: 700 }}>PIF</span> : `$${money(inv.balance_due ?? inv.total ?? 0)}`}</td>
                  <td className="nowrap">{fmtDate(inv.due_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </>
  )
}
