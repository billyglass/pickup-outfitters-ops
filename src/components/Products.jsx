import { useState } from 'react'
import { store } from '../lib/store.js'
import { money } from '../lib/tickets.js'

// Admin-managed reusable products / services / labor. No cost anywhere
// here — cost lives only in the Admin-only product_costs table and is
// never shown to Sales. The TicketForm picker uses this catalog; custom
// one-time lines are always allowed alongside it.
export default function Products({ data, isAdmin, onReload, onError }) {
  const [editing, setEditing] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [form, setForm] = useState({ part_number: '', name: '', description: '', default_price: 0, taxable: true, type: 'part', active: true })

  function startNew() {
    setEditing('new')
    setConfirmDelete(false)
    setForm({ part_number: '', name: '', description: '', default_price: 0, taxable: true, type: 'part', active: true })
  }
  function startEdit(p) {
    setEditing(p.id)
    setConfirmDelete(false)
    setForm({ ...p })
  }
  async function save(e) {
    e?.preventDefault()
    if (!form.name.trim()) { onError('Product name is required.'); return }
    try {
      await store.saveProduct({ ...form, id: editing === 'new' ? null : editing, version: editing === 'new' ? undefined : data.products.find((p) => p.id === editing)?.version }, isAdmin)
      setEditing(null)
      await onReload()
    } catch (err) { onError(err.message || 'Save failed.') }
  }
  async function remove(p) {
    // The edit form already asks before calling this — one deliberate
    // confirm is enough. It stays on existing tickets as a line item.
    try { await store.deleteProduct(p.id, isAdmin); setEditing(null); setConfirmDelete(false); await onReload() } catch (err) { onError(err.message || 'Delete failed.') }
  }

  return (
    <div className="card">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Products &amp; services ({(data.products || []).length})</h2>
        <button className="btn" onClick={startNew}>+ New product</button>
      </div>
      <p className="muted small">Admin only. Reusable parts, services, and labor with default prices. Costs are kept in a separate Admin-only table and never appear here or in search.</p>
      {editing && (
        <form className="card" onSubmit={save}>
          <div className="form-grid">
            <div><label>Name *</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label>Part number</label><input value={form.part_number || ''} onChange={(e) => setForm({ ...form, part_number: e.target.value })} /></div>
            <div><label>Type</label><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="part">Part</option><option value="labor">Labor</option><option value="service">Service</option></select></div>
            <div><label>Default price</label><input type="number" min="0" step="0.01" value={form.default_price} onChange={(e) => setForm({ ...form, default_price: Number(e.target.value) })} /></div>
            <div><label>Description</label><input value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div><label>Taxable</label><input type="checkbox" style={{ width: 'auto' }} checked={!!form.taxable} onChange={(e) => setForm({ ...form, taxable: e.target.checked })} /> Taxable</div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit">Save product</button>
            <button className="btn secondary" type="button" onClick={() => { setEditing(null); setConfirmDelete(false) }}>Cancel</button>
          </div>
          {editing !== 'new' && (
            <div className="danger-zone">
              {!confirmDelete ? (
                <button className="btn secondary small" type="button" onClick={() => setConfirmDelete(true)}>Delete this product…</button>
              ) : (
                <span>
                  Delete “{form.name}”? It stays on existing tickets as a line item.{' '}
                  <button className="btn danger small" type="button" onClick={() => remove(data.products.find((p) => p.id === editing))}>Yes, delete product</button>{' '}
                  <button className="btn secondary small" type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </span>
              )}
            </div>
          )}
        </form>
      )}
      <table>
        <thead><tr><th>Part No.</th><th>Name</th><th>Type</th><th>Price</th><th>Taxable</th><th></th></tr></thead>
        <tbody>
          {(data.products || []).map((p) => (
            <tr key={p.id}>
              <td>{p.part_number || '—'}</td>
              <td><strong>{p.name}</strong>{p.description ? <div className="muted small">{p.description}</div> : ''}</td>
              <td>{p.type}</td>
              <td>${money(p.default_price)}</td>
              <td>{p.taxable ? 't' : ''}</td>
              <td><button className="btn secondary" onClick={() => startEdit(p)}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {(data.products || []).length === 0 && <p className="muted">No products yet — add the ones you reuse, or just type custom lines on each ticket.</p>}
    </div>
  )
}
