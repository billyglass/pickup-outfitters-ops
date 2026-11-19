import { useEffect, useState } from 'react'
import { store } from '../lib/store.js'
import { fmtDate, money, roundCents, todayStr, isCodTicket } from '../lib/tickets.js'

// Payments on an invoice (Phase 3, payments piece). A deposit is just a
// payment: COD accounts need one when product is ordered, terms accounts
// don't, and the amount is whatever the customer puts down — no fixed
// amount, no percentage. A customer may pay a deposit, come back and pay
// a little more, then pay the rest, so an invoice takes as many partial
// payments as they make. Each payment lowers the balance; the status
// follows on its own (Issued -> Partially Paid -> Paid). Record is any
// active user; deleting a payment is Admin-only, with a confirm.
// Lives inside TicketForm's <form>, so every button is type="button" and
// Enter in a field records the payment instead of saving the ticket.
const METHODS = ['Cash', 'Check', 'Card', 'Other']
const RECORDABLE = ['Draft', 'Issued', 'Partially Paid']

export default function InvoicePayments({ invoice, isAdmin, userId, readOnly, onInvoiceUpdated }) {
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [amount, setAmount] = useState('')
  const [payDate, setPayDate] = useState(todayStr())
  const [method, setMethod] = useState('Cash')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmOverpay, setConfirmOverpay] = useState(null) // { amount, over } or null
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  const invoiceId = invoice?.id
  const total = roundCents(Number(invoice?.total) || 0)
  const paid = roundCents(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0))
  const balance = roundCents(total - paid)
  const canRecord = !readOnly && RECORDABLE.includes(invoice?.status)
  // Deposit due: COD terms (or a walk-in — cash on the spot) with no
  // payment recorded yet, on a Draft or Issued invoice. A reminder only —
  // it never blocks saving. Terms accounts never show it.
  const depositDue = invoiceId && isCodTicket(invoice) && payments.length === 0 &&
    ['Draft', 'Issued'].includes(invoice?.status)

  async function load() {
    if (!invoiceId) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      setPayments(await store.listPayments(invoiceId))
    } catch (err) {
      setError(err.message || 'Could not load payments.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [invoiceId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function doRecord(amountToRecord) {
    setError('')
    setBusy(true)
    try {
      const { payment, invoice: updated } = await store.recordPayment(invoiceId, {
        amount: amountToRecord,
        payment_date: payDate || todayStr(),
        method,
        reference,
        note,
      }, userId)
      setPayments((ps) => [payment, ...ps])
      setAmount('')
      setReference('')
      setNote('')
      setConfirmOverpay(null)
      if (updated && onInvoiceUpdated) onInvoiceUpdated(updated)
    } catch (err) {
      setError(err.message || 'Could not record payment.')
    } finally {
      setBusy(false)
    }
  }

  function record() {
    const amt = roundCents(Number(amount) || 0)
    if (!(amt > 0)) { setError('Enter a payment amount greater than $0.'); return }
    // Overpayment guard: more than the balance due is allowed (credit
    // balances are real), but say so with the numbers and ask once.
    if (amt > balance) {
      setConfirmOverpay({ amount: amt, over: roundCents(amt - balance) })
      return
    }
    doRecord(amt)
  }

  async function remove(payment) {
    setError('')
    try {
      const { invoice: updated } = await store.deletePayment(payment.id, isAdmin)
      setPayments((ps) => ps.filter((p) => p.id !== payment.id))
      setConfirmDeleteId(null)
      if (updated && onInvoiceUpdated) onInvoiceUpdated(updated)
    } catch (err) {
      setError(err.message || 'Delete failed.')
    }
  }

  // Brand-new / duplicated invoice — nothing to pay against until it is
  // saved and has a number.
  if (!invoiceId) {
    return (
      <section className="ticket-section">
        <h3>Payments</h3>
        <p className="muted">Save the invoice first, then record payments.</p>
      </section>
    )
  }

  return (
    <section className="ticket-section">
      <h3>Payments</h3>
      {depositDue && (
        <div className="flag-banner">⚠ Deposit due — COD account. No payment recorded yet.</div>
      )}
      <p style={{ marginTop: 0 }}>
        <strong>Paid so far:</strong> ${money(paid)} · <strong>Balance due:</strong> ${money(balance)}
        {balance < 0 && <span className="muted"> (overpaid by ${money(-balance)})</span>}
      </p>
      {error && <div className="error">{error}</div>}
      {loading ? (
        <p className="muted">Loading payments…</p>
      ) : payments.length === 0 ? (
        <p className="muted">No payments recorded yet.</p>
      ) : (
        payments.map((p) => (
          <div key={p.id} style={{ borderTop: '1px solid #eee', padding: '10px 0' }}>
            <div className="row-between">
              <span><strong>{fmtDate(p.payment_date)}</strong> · ${money(p.amount)} · {p.method || '—'}{p.reference ? ` · #${p.reference}` : ''}{p.note ? ` · ${p.note}` : ''}</span>
              {isAdmin && !readOnly ? (
                confirmDeleteId === p.id ? (
                  <span>
                    Delete this payment? The balance goes back up.{' '}
                    <button className="btn danger small" type="button" onClick={() => remove(p)}>Yes, delete</button>{' '}
                    <button className="btn secondary small" type="button" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                  </span>
                ) : (
                  <button className="btn secondary small" type="button" onClick={() => setConfirmDeleteId(p.id)}>Delete</button>
                )
              ) : null}
            </div>
          </div>
        ))
      )}
      {canRecord && (
        <>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div>
              <label>Amount *</label>
              <input
                type="number" min="0" step="0.01" placeholder="0.00" value={amount}
                onChange={(e) => { setAmount(e.target.value); setConfirmOverpay(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); record() } }}
              />
            </div>
            <div>
              <label>Date</label>
              <input
                type="date" value={payDate}
                onChange={(e) => setPayDate(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); record() } }}
              />
            </div>
            <div>
              <label>Method</label>
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label>Reference (check number, optional)</label>
              <input
                value={reference} autoComplete="off" placeholder="e.g. check 1234"
                onChange={(e) => setReference(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); record() } }}
              />
            </div>
            <div>
              <label>Note (optional)</label>
              <input
                value={note} autoComplete="off" placeholder="e.g. deposit on order"
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); record() } }}
              />
            </div>
          </div>
          {confirmOverpay ? (
            <div className="warn" style={{ marginTop: 12 }}>
              This is ${money(confirmOverpay.over)} more than the balance due of ${money(balance)}.
              The balance will show as overpaid.{' '}
              <button className="btn small" type="button" disabled={busy} onClick={() => doRecord(confirmOverpay.amount)}>{busy ? 'Recording…' : 'Record it anyway'}</button>{' '}
              <button className="btn secondary small" type="button" onClick={() => setConfirmOverpay(null)}>Cancel</button>
            </div>
          ) : (
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" type="button" disabled={busy || !(Number(amount) > 0)} onClick={record}>{busy ? 'Recording…' : 'Record payment'}</button>
            </div>
          )}
        </>
      )}
      {!canRecord && invoice?.status === 'Paid' && (
        <p className="muted">Paid in full — no further payments to record.</p>
      )}
      {!canRecord && invoice?.status === 'Void' && (
        <p className="muted">Void invoice — payments are history only.</p>
      )}
    </section>
  )
}
