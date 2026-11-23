import { useState } from 'react'
import { store, VersionConflict } from '../lib/store.js'
import { titleCaseName } from '../lib/names.js'
import { formatPhone } from '../lib/phones.js'

const emptyContact = () => ({ name: '', phone: '', email: '', title: '', is_primary: false })
const emptyAddress = () => ({ address_type: 'billing', line1: '', line2: '', city: '', state: '', zip: '', is_primary: false })

export default function CustomerForm({ initial, contacts: initialContacts, addresses: initialAddresses, isAdmin, onSaved, onCancel, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [customer, setCustomer] = useState(
    initial || { company: '', customer_type: 'Retail', flag: '', flag_note: '', tax_exempt: false, tax_exempt_doc_note: '', payment_terms: 'Net 30', po_requirements: '' }
  )
  const [contacts, setContacts] = useState(
    initialContacts?.length ? initialContacts : [emptyContact()]
  )
  const [addresses, setAddresses] = useState(
    initialAddresses?.length ? initialAddresses : [emptyAddress()]
  )
  const [status, setStatus] = useState('saved') // saved | unsaved | saving
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState('')

  function markDirty(patch) {
    setCustomer((c) => ({ ...c, ...patch }))
    setStatus('unsaved')
  }

  async function save(e) {
    e?.preventDefault()
    if (!customer.company.trim()) {
      setError('Company name is required.')
      return
    }
    setError('')
    setConflict('')
    setStatus('saving')
    try {
      const saved = await store.saveCustomer(customer, contacts, addresses)
      setCustomer(saved)
      setStatus('saved')
      onSaved(saved)
    } catch (err) {
      setStatus('unsaved')
      if (err instanceof VersionConflict) setConflict(err.message)
      else setError(err.message || 'Save failed.')
    }
  }

  function updateContact(i, patch) {
    setContacts((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
    setStatus('unsaved')
  }
  function updateAddress(i, patch) {
    setAddresses((as) => as.map((a, idx) => (idx === i ? { ...a, ...patch } : a)))
    setStatus('unsaved')
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>{initial ? 'Edit customer' : 'New customer'}</h2>
        <span className={`saved ${status === 'saved' ? 'saved-ok' : status === 'saving' ? 'saving' : 'unsaved'}`}>
          {status === 'saved' ? '● Saved' : status === 'saving' ? '● Saving…' : '● Unsaved changes'}
        </span>
      </div>
      {conflict && (
        <div className="error">
          {conflict} <button type="button" className="btn secondary" onClick={onCancel}>Reload</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="form-grid">
        <div>
          <label htmlFor="cf-company">Company *</label>
          <input id="cf-company" value={customer.company} onChange={(e) => markDirty({ company: e.target.value })} onBlur={(e) => { const v = titleCaseName(e.target.value); if (v !== e.target.value) markDirty({ company: v }) }} required />
        </div>
        <div>
          <label htmlFor="cf-terms">Payment terms</label>
          <select id="cf-terms" value={customer.payment_terms || 'Net 30'} onChange={(e) => markDirty({ payment_terms: e.target.value })}>
            <option>Due on receipt</option>
            <option>Net 15</option>
            <option>Net 30</option>
            <option>Net 60</option>
            <option>COD</option>
          </select>
        </div>
      </div>
      <div>
        <label>Customer type</label>
        <div className="row" role="group" aria-label="Customer type">
          <label style={{ margin: 0 }}>
            <input type="radio" name="cf-type" style={{ width: 'auto' }} checked={(customer.customer_type || 'Retail') === 'Retail'} onChange={() => markDirty({ customer_type: 'Retail' })} /> Retail
          </label>
          <label style={{ margin: 0 }}>
            <input type="radio" name="cf-type" style={{ width: 'auto' }} checked={customer.customer_type === 'Fleet'} onChange={() => markDirty({ customer_type: 'Fleet' })} /> Fleet
          </label>
        </div>
        <p className="muted small">Fleet = a business / fleet account. Retail = a regular retail customer. This is how you separate fleet from retail when searching customers.</p>
      </div>
      <div>
        <label htmlFor="cf-flag">Customer flag</label>
        <select id="cf-flag" value={customer.flag || ''} onChange={(e) => markDirty({ flag: e.target.value, flag_note: e.target.value ? customer.flag_note : '' })}>
          <option value="">None — no flag</option>
          <option>Needy</option>
          <option>Slow payer</option>
          <option>VIP</option>
          <option>Check with Bill first</option>
          <option>Do not discount</option>
        </select>
        <p className="muted small">A flag pops up as an amber banner whenever anyone opens this account or makes a quote or invoice for them.</p>
      </div>
      {customer.flag && (
        <div>
          <label htmlFor="cf-flag-note">Flag note</label>
          <input id="cf-flag-note" value={customer.flag_note || ''} onChange={(e) => markDirty({ flag_note: e.target.value })} placeholder="e.g. Calls twice a day, wants updates" />
        </div>
      )}
      <label>
        <input
          type="checkbox"
          checked={!!customer.tax_exempt}
          onChange={(e) => markDirty({ tax_exempt: e.target.checked })}
          style={{ width: 'auto' }}
        />{' '}
        Tax exempt
      </label>
      {customer.tax_exempt && (
        <div>
          <label htmlFor="cf-taxdoc">Tax-exempt documentation (note — file upload comes in Phase 6)</label>
          <input id="cf-taxdoc" value={customer.tax_exempt_doc_note || ''} onChange={(e) => markDirty({ tax_exempt_doc_note: e.target.value })} placeholder="e.g. Exemption certificate on file, dated…" />
        </div>
      )}
      <div>
        <label htmlFor="cf-po">Purchase order requirements</label>
        <input id="cf-po" value={customer.po_requirements || ''} onChange={(e) => markDirty({ po_requirements: e.target.value })} placeholder="e.g. PO required on every invoice" />
      </div>
      <h3>Contacts</h3>
      {contacts.map((c, i) => (
        <div key={i} className="form-grid" style={{ borderTop: '1px solid #eee', paddingTop: 4 }}>
          <div>
            <label>Name</label>
            <input value={c.name || ''} onChange={(e) => updateContact(i, { name: e.target.value })} onBlur={(e) => { const v = titleCaseName(e.target.value); if (v !== (c.name || '')) updateContact(i, { name: v }) }} />
          </div>
          <div>
            <label>Title / role</label>
            <input value={c.title || ''} onChange={(e) => updateContact(i, { title: e.target.value })} />
          </div>
          <div>
            <label>Phone</label>
            <input value={c.phone || ''} onChange={(e) => updateContact(i, { phone: e.target.value })} onBlur={(e) => { const v = formatPhone(e.target.value); if (v !== (c.phone || '')) updateContact(i, { phone: v }) }} />
          </div>
          <div>
            <label>Email</label>
            <input type="email" value={c.email || ''} onChange={(e) => updateContact(i, { email: e.target.value })} />
          </div>
        </div>
      ))}
      <button type="button" className="btn secondary" onClick={() => setContacts([...contacts, emptyContact()])}>+ Add contact</button>

      <h3>Addresses</h3>
      {addresses.map((a, i) => (
        <div key={i} className="form-grid" style={{ borderTop: '1px solid #eee', paddingTop: 4 }}>
          <div>
            <label>Type</label>
            <select value={a.address_type || 'billing'} onChange={(e) => updateAddress(i, { address_type: e.target.value })}>
              <option value="billing">Billing</option>
              <option value="service">Service</option>
              <option value="both">Billing + service</option>
            </select>
          </div>
          <div>
            <label>Street</label>
            <input value={a.line1 || ''} onChange={(e) => updateAddress(i, { line1: e.target.value })} />
          </div>
          <div>
            <label>City</label>
            <input value={a.city || ''} onChange={(e) => updateAddress(i, { city: e.target.value })} />
          </div>
          <div>
            <label>State</label>
            <input value={a.state || ''} onChange={(e) => updateAddress(i, { state: e.target.value })} />
          </div>
          <div>
            <label>ZIP</label>
            <input value={a.zip || ''} onChange={(e) => updateAddress(i, { zip: e.target.value })} />
          </div>
        </div>
      ))}
      <button type="button" className="btn secondary" onClick={() => setAddresses([...addresses, emptyAddress()])}>+ Add address</button>

      <div className="row" style={{ marginTop: 20 }}>
        <button className="btn" type="submit" disabled={status === 'saving'}>Save customer</button>
        <button className="btn secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
      {initial?.id && isAdmin && onDelete && (
        <div className="danger-zone">
          {!confirmDelete ? (
            <button className="btn secondary small" type="button" onClick={() => setConfirmDelete(true)}>Delete this customer…</button>
          ) : (
            <span>
              Delete this customer and all of its vehicles? This cannot be undone.{' '}
              <button className="btn danger small" type="button" onClick={onDelete}>Yes, delete customer</button>{' '}
              <button className="btn secondary small" type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}
    </form>
  )
}
