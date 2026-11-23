import { useState } from 'react'
import { store } from '../lib/store.js'
import { findCustomerByPhoneOrEmail, customerTypeOf } from '../lib/tickets.js'
import { formatPhone } from '../lib/phones.js'

// "Save as customer" for an already-saved walk-in ticket. Renders a small
// inline card: pick Retail / Fleet, confirm, and the walk-in buyer becomes
// a customer record (or links to the existing customer with the same phone
// / email) and the ticket links to them — so their history builds up from
// this ticket onward. Used by the Quotes and Invoices lists.
export default function SaveWalkInAsCustomer({ kind, ticket, data, user, onDone, onError, onCancel }) {
  const [type, setType] = useState('Retail')
  const [busy, setBusy] = useState(false)
  const snap = ticket.customer_snapshot || {}
  const existing = findCustomerByPhoneOrEmail(data.customers, data.contacts, snap.phone, snap.email)

  async function confirm() {
    setBusy(true)
    try {
      const { customer, linkedExisting } = await store.saveWalkInAsCustomer(kind, ticket, type, user?.id)
      onDone(
        linkedExisting
          ? `Linked ${ticket.number} to existing customer ${customer.company} (${customerTypeOf(customer)}) — same phone/email. Their history now includes this ticket.`
          : `Saved ${customer.company} as a ${customerTypeOf(customer)} customer and linked ${ticket.number} to them.`
      )
    } catch (err) {
      onError(err.message || 'Save as customer failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ border: '2px solid #e67e22' }}>
      <h3 style={{ marginTop: 0 }}>Save walk-in {ticket.number} as a customer?</h3>
      <p className="muted">
        Buyer: <strong>{snap.contact_name || snap.company || 'Walk-in'}</strong> · {formatPhone(snap.phone) || '—'} · {snap.email || ''}
      </p>
      {existing ? (
        <p className="muted">
          A customer with this phone/email already exists ({existing.company} — {customerTypeOf(existing)}).
          Confirming links this ticket to them instead of creating a duplicate.
        </p>
      ) : (
        <>
          <label>Customer type</label>
          <div className="row" role="group" aria-label="New customer type">
            <label style={{ margin: 0 }}>
              <input type="radio" name="sac-type" style={{ width: 'auto' }} checked={type === 'Retail'} onChange={() => setType('Retail')} /> Retail
            </label>
            <label style={{ margin: 0 }}>
              <input type="radio" name="sac-type" style={{ width: 'auto' }} checked={type === 'Fleet'} onChange={() => setType('Fleet')} /> Fleet
            </label>
          </div>
          <p className="muted small">
            A {type} customer record is created from this name + phone, and this ticket links to it —
            so next time they come back you can look up everything they've bought.
          </p>
        </>
      )}
      <div className="row">
        <button className="btn" disabled={busy} onClick={confirm}>
          {busy ? 'Saving…' : existing ? `Link to ${existing.company}` : 'Save as customer'}
        </button>
        <button className="btn secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
