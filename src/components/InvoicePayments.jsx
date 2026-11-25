import { useEffect, useState } from 'react'
import { store } from '../lib/store.js'
import { fmtDate, money, roundCents, todayStr, isCodTicket, invoicePaymentSummary } from '../lib/tickets.js'

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

export default function InvoicePayments({ invoice, isAdmin, userId, readOnly, onInvoiceUpdated, pendingPayments, onPendingPaymentsChange, computedTotal }) {
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
  // Record payment already saves the payment on the invoice — no Save
  // changes needed afterwards (Nov 24). Say so outright, or the form's
  // Save button makes it look like the payment is still waiting.
  const [savedMsg, setSavedMsg] = useState('')

  const invoiceId = invoice?.id
  // A new invoice has no saved total yet — the form's live computed total
  // is what the balance is measured against until it is saved. A saved
  // invoice always uses its saved total, even if the lines were edited
  // since (the DB derives the balance from the saved total too).
  const total = roundCents(Number(invoiceId ? (invoice?.total ?? 0) : (computedTotal ?? invoice?.total ?? 0)) || 0)
  const summary = invoicePaymentSummary(total, payments, pendingPayments)
  const paid = summary.paid
  const balance = summary.balance
  // A new invoice can always take a payment — it is staged in the form
  // until Save (see doRecord). A saved invoice follows the same
  // recordable statuses as before.
  const canRecord = !readOnly && (!invoiceId || RECORDABLE.includes(invoice?.status))
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
    // New invoice (Nov 25): no id exists yet, so there is no payment row
    // to write. Stage it in the form instead — TicketForm writes staged
    // payments right after the invoice itself is saved, in the same pass.
    if (!invoiceId) {
      onPendingPaymentsChange?.([...(pendingPayments || []), {
        key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        amount: amountToRecord,
        payment_date: payDate || todayStr(),
        method,
        reference: (reference || '').trim() || null,
        note: (note || '').trim() || null,
      }])
      setAmount('')
      setReference('')
      setNote('')
      setConfirmOverpay(null)
      setSavedMsg('Payment staged — it will be saved with this invoice when you hit Save.')
      return
    }
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
      setSavedMsg(`Payment of $${money(amountToRecord)} recorded and saved on ${invoice?.number || 'this invoice'} — no need to hit Save changes.`)
      if (updated && onInvoiceUpdated) onInvoiceUpdated(updated)
    } catch (err) {
      setError(err.message || 'Could not record payment.')
    } finally {
      setBusy(false)
    }
  }

  // A staged payment that could not be written when the invoice was saved
  // (rare — the invoice saved but the payment insert failed). It stays in
  // the form with a Retry; the invoice exists now, so retry is the live path.
  async function retryPending(p) {
    setError('')
    setBusy(true)
    try {
      const { payment, invoice: updated } = await store.recordPayment(invoiceId, {
        amount: p.amount,
        payment_date: p.payment_date,
        method: p.method,
        reference: p.reference,
        note: p.note,
      }, userId)
      setPayments((ps) => [payment, ...ps])
      onPendingPaymentsChange?.((pendingPayments || []).filter((x) => x.key !== p.key))
      setSavedMsg(`Payment of $${money(p.amount)} recorded and saved on ${invoice?.number || 'this invoice'}.`)
      if (updated && onInvoiceUpdated) onInvoiceUpdated(updated)
    } catch (err) {
      setError(err.message || 'Could not record payment.')
    } finally {
      setBusy(false)
    }
  }

  function removePending(key) {
    onPendingPaymentsChange?.((pendingPayments || []).filter((p) => p.key !== key))
    setSavedMsg('')
  }

  // "Paid in full" checkbox (Nov 25): checked exactly when the amount in
  // the box equals the remaining balance — checking it fills the balance,
  // typing a different amount unchecks it on its own. Unchecking clears
  // the amount so the shortcut can be undone.
  const pifChecked = balance > 0 && roundCents(Number(amount) || 0) === balance
  function togglePif() {
    if (pifChecked) setAmount('')
    else setAmount(balance.toFixed(2))
    setConfirmOverpay(null)
    setSavedMsg('')
  }

  function record() {
    const amt = roundCents(Number(amount) || 0)
    if (!(amt > 0)) { setError('Enter a payment amount greater than $0.'); return }
    // Overpayment guard: more than the balance due is allowed (credit
    // balances are real), but say so with the numbers and ask once. Only
    // on a saved invoice — while writing a new one the total is still
    // provisional (lines not finished), so the warning would be noise;
    // the staged row and the balance shown are the check there.
    if (invoiceId && amt > balance) {
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
      setSavedMsg('Payment deleted — balance updated and saved.')
      if (updated && onInvoiceUpdated) onInvoiceUpdated(updated)
    } catch (err) {
      setError(err.message || 'Delete failed.')
    }
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
        {summary.pendingCount > 0 && <span className="muted"> (includes ${money(summary.pendingTotal)} staged)</span>}
      </p>
      {error && <div className="error">{error}</div>}
      {savedMsg && <p className="saved-ok" style={{ marginTop: 0 }}>{savedMsg}</p>}
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
      {summary.pendingCount > 0 && (
        <div style={{ borderTop: '1px solid #eee', padding: '10px 0' }}>
          <p className="muted" style={{ margin: '0 0 6px' }}>
            {invoiceId
              ? 'These payments could not be saved with the invoice — retry them below.'
              : 'Staged payments — saved with this invoice when you hit Save:'}
          </p>
          {pendingPayments.map((p) => (
            <div key={p.key} style={{ padding: '4px 0' }}>
              <div className="row-between">
                <span><strong>{fmtDate(p.payment_date)}</strong> · ${money(p.amount)} · {p.method || '—'}{p.reference ? ` · #${p.reference}` : ''}{p.note ? ` · ${p.note}` : ''}</span>
                {invoiceId ? (
                  <button className="btn small" type="button" disabled={busy} onClick={() => retryPending(p)}>Retry</button>
                ) : (
                  <button className="btn secondary small" type="button" onClick={() => removePending(p.key)}>Remove</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {canRecord && (
        <>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div>
              <label>Amount *</label>
              <input
                type="number" min="0" step="0.01" placeholder="0.00" value={amount}
                onChange={(e) => { setAmount(e.target.value); setConfirmOverpay(null); setSavedMsg('') }}
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
          {canRecord && balance > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={pifChecked} onChange={togglePif} />
              Paid in full — fill the remaining balance (${money(balance)})
            </label>
          )}
          {confirmOverpay ? (
            <div className="warn" style={{ marginTop: 12 }}>
              This is ${money(confirmOverpay.over)} more than the balance due of ${money(balance)}.
              The balance will show as overpaid.{' '}
              <button className="btn small" type="button" disabled={busy} onClick={() => doRecord(confirmOverpay.amount)}>{busy ? 'Recording…' : 'Record it anyway'}</button>{' '}
              <button className="btn secondary small" type="button" onClick={() => setConfirmOverpay(null)}>Cancel</button>
            </div>
          ) : (
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" type="button" disabled={busy || !(Number(amount) > 0)} onClick={record}>{busy ? 'Recording…' : !invoiceId ? 'Stage payment' : 'Record payment'}</button>
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
