import { useMemo, useState } from 'react'
import { store } from '../lib/store.js'
import { money } from '../lib/tickets.js'
import ProductNotes from './ProductNotes.jsx'
import ProductPhotos from './ProductPhotos.jsx'
import CollapsibleCard from './CollapsibleCard.jsx'

// Shared products-and-services catalog (Nov 19, 2026 — Bill's decision):
// EVERY active user (Sales + Admin) can view, add, edit, AND delete
// products and services, INCLUDING the cost, so a salesman can price a
// custom service when Bill isn't there. Cost lives in the separate
// product_costs table and is merged onto each product by the store. The
// delete BUTTON lives only in the edit form's danger zone behind a
// two-step confirm, never on a list row — the same pattern as customers,
// vehicles, quotes, and invoices.
// Click a row to open the detail view: all fields, a dated notes log, a
// photo gallery, and an "Add to invoice" button that opens a new Draft
// invoice with one line prefilled from this product/service.
export const TYPE_LABELS = { part: 'Product', service: 'Service', labor: 'Labor' }
export const typeLabel = (t) => TYPE_LABELS[t] || 'Product'

export default function Products({ data, user, isAdmin, onReload, onError, onAddToInvoice }) {
  const [selected, setSelected] = useState(null) // product in the detail view, or null = list
  const [editing, setEditing] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [form, setForm] = useState({ part_number: '', name: '', description: '', default_price: 0, cost: 0, taxable: true, type: 'part', active: true })
  const [fSearch, setFSearch] = useState('')
  const [fType, setFType] = useState('') // '' = All, 'part', 'service', 'labor'
  const [busy, setBusy] = useState(false)

  const filtered = useMemo(() => {
    const q = fSearch.trim().toLowerCase()
    return (data.products || []).filter((p) => {
      if (fType && p.type !== fType) return false
      if (!q) return true
      return [p.name, p.description, p.part_number].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    })
  }, [data.products, fSearch, fType])

  function startNew() {
    setEditing('new')
    setConfirmDelete(false)
    setForm({ part_number: '', name: '', description: '', default_price: 0, cost: 0, taxable: true, type: 'part', active: true })
  }
  function startEdit(p) {
    setEditing(p.id)
    setConfirmDelete(false)
    setForm({ ...p, cost: Number(p.cost) || 0, default_price: Number(p.default_price) || 0 })
  }
  async function save(e) {
    e?.preventDefault()
    if (!form.name.trim()) { onError('Product name is required.'); return }
    setBusy(true)
    try {
      const saved = await store.saveProduct({ ...form, id: editing === 'new' ? null : editing, version: editing === 'new' ? undefined : data.products.find((p) => p.id === editing)?.version }, isAdmin, user?.id)
      setEditing(null)
      if (selected) setSelected(saved)
      await onReload()
    } catch (err) { onError(err.message || 'Save failed.') } finally { setBusy(false) }
  }
  async function remove(p) {
    // The edit form already asks before calling this — one deliberate
    // confirm is enough. It stays on existing tickets as a line item.
    // Any active user may delete (Nov 19); the button only exists in the
    // edit form's danger zone, never on a list row.
    try { await store.deleteProduct(p.id, isAdmin); setEditing(null); setConfirmDelete(false); setSelected(null); await onReload() } catch (err) { onError(err.message || 'Delete failed.') }
  }

  // --- Detail view: click a row to see the product/service, its notes and
  // photos, and add it straight to a new invoice. -------------------------
  if (selected) {
    const p = data.products.find((x) => x.id === selected.id) || selected
    return (
      <div>
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="btn secondary" type="button" onClick={() => { setSelected(null); setEditing(null) }}>← All products &amp; services</button>
        </div>
        <CollapsibleCard id="products-detail" userId={user?.id} title={<>{p.name} <span className="pill" style={{ marginLeft: 8 }}>{typeLabel(p.type)}</span></>} label="Product detail" headerExtra={<div className="row"><button className="btn" type="button" onClick={() => onAddToInvoice?.(p)}>Add to invoice</button><button className="btn secondary" type="button" onClick={() => startEdit(p)}>Edit</button></div>}>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div><label>Part number</label><div>{p.part_number || '—'}</div></div>
            <div><label>Sell price</label><div>${money(p.default_price)}</div></div>
            <div><label>Cost</label><div>${money(p.cost)}</div></div>
            <div><label>Taxable</label><div>{p.taxable ? 'Yes' : 'No'}</div></div>
            <div><label>Status</label><div>{p.active === false ? 'Inactive' : 'Active'}</div></div>
          </div>
          {p.description && <div style={{ marginTop: 12 }}><label>Description</label><div style={{ whiteSpace: 'pre-wrap' }}>{p.description}</div></div>}
          <p className="muted small" style={{ marginTop: 12 }}>“Add to invoice” opens a new Draft invoice with one line already filled in from this {typeLabel(p.type).toLowerCase()} — sell price, part number, and taxable flag — then you pick the customer and save.</p>
        </CollapsibleCard>
        {editing && (
          <form className="card" onSubmit={save}>
            <h3 style={{ marginTop: 0 }}>Edit {typeLabel(form.type).toLowerCase()}</h3>
            <div className="form-grid">
              <div><label>Name *</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div><label>Part number</label><input value={form.part_number || ''} onChange={(e) => setForm({ ...form, part_number: e.target.value })} placeholder="Optional — services usually have none" /></div>
              <div><label>Type</label><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="part">Product</option><option value="service">Service</option><option value="labor">Labor</option></select></div>
              <div><label>Sell price</label><input type="number" min="0" step="0.01" placeholder="0.00" value={form.default_price || ''} onChange={(e) => setForm({ ...form, default_price: e.target.value === '' ? '' : Number(e.target.value) || 0 })} /></div>
              <div><label>Cost</label><input type="number" min="0" step="0.01" placeholder="0.00" value={form.cost || ''} onChange={(e) => setForm({ ...form, cost: e.target.value === '' ? '' : Number(e.target.value) || 0 })} /></div>
              <div><label>Description</label><input value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
              <div><label>Taxable</label><input type="checkbox" style={{ width: 'auto' }} checked={!!form.taxable} onChange={(e) => setForm({ ...form, taxable: e.target.checked })} /> Taxable</div>
              <div><label>Active</label><input type="checkbox" style={{ width: 'auto' }} checked={form.active !== false} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
              <button className="btn secondary" type="button" onClick={() => { setEditing(null); setConfirmDelete(false) }}>Cancel</button>
            </div>
            {editing !== 'new' && (
              <div className="danger-zone">
                {!confirmDelete ? (
                  <button className="btn secondary small" type="button" onClick={() => setConfirmDelete(true)}>Delete this product…</button>
                ) : (
                  <span>
                    Delete “{form.name}”? It stays on existing tickets as a line item.{' '}
                    <button className="btn danger small" type="button" onClick={() => remove(p)}>Yes, delete product</button>{' '}
                    <button className="btn secondary small" type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
                  </span>
                )}
              </div>
            )}
          </form>
        )}
        <ProductNotes productId={p.id} userId={user?.id} profiles={data.profiles || []} />
        <ProductPhotos productId={p.id} userId={user?.id} />
      </div>
    )
  }

  // --- List view ------------------------------------------------------------
  return (
    <CollapsibleCard id="products-list" userId={user?.id} title={<>Products &amp; services ({filtered.length})</>} label="Products list" headerExtra={<button className="btn" onClick={startNew}>+ New product / service</button>}>
      <p className="muted small">Shared catalog — everyone can view, add, and edit products and services, including the cost, so any salesman can price a custom job when Bill isn&apos;t there. Click a row to see its notes and photos, or add it straight to a new invoice. To delete one, open it and use the delete button at the bottom of its edit form.</p>
      <div className="row filters" style={{ marginTop: 12 }}>
        <input value={fSearch} onChange={(e) => setFSearch(e.target.value)} placeholder="Search name, description, part number…" style={{ flex: '1 1 200px' }} />
        <select value={fType} onChange={(e) => setFType(e.target.value)}>
          <option value="">All types</option>
          <option value="part">Product</option>
          <option value="service">Service</option>
          <option value="labor">Labor</option>
        </select>
      </div>
      {editing === 'new' && (
        <form className="card" onSubmit={save}>
          <h3 style={{ marginTop: 0 }}>New product / service</h3>
          <div className="form-grid">
            <div><label>Name *</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label>Part number</label><input value={form.part_number || ''} onChange={(e) => setForm({ ...form, part_number: e.target.value })} placeholder="Optional — services usually have none" /></div>
            <div><label>Type</label><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="part">Product</option><option value="service">Service</option><option value="labor">Labor</option></select></div>
            <div><label>Sell price</label><input type="number" min="0" step="0.01" placeholder="0.00" value={form.default_price || ''} onChange={(e) => setForm({ ...form, default_price: e.target.value === '' ? '' : Number(e.target.value) || 0 })} /></div>
            <div><label>Cost</label><input type="number" min="0" step="0.01" placeholder="0.00" value={form.cost || ''} onChange={(e) => setForm({ ...form, cost: e.target.value === '' ? '' : Number(e.target.value) || 0 })} /></div>
            <div><label>Description</label><input value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div><label>Taxable</label><input type="checkbox" style={{ width: 'auto' }} checked={!!form.taxable} onChange={(e) => setForm({ ...form, taxable: e.target.checked })} /> Taxable</div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save product'}</button>
            <button className="btn secondary" type="button" onClick={() => { setEditing(null); setConfirmDelete(false) }}>Cancel</button>
          </div>
        </form>
      )}
      <table>
        <thead><tr><th>Part No.</th><th>Name</th><th>Type</th><th>Sell price</th><th>Cost</th><th>Taxable</th><th></th></tr></thead>
        <tbody>
          {filtered.map((p) => (
            <tr key={p.id} onClick={() => setSelected(p)} style={{ cursor: 'pointer' }}>
              <td>{p.part_number || '—'}</td>
              <td><strong>{p.name}</strong>{p.description ? <div className="muted small">{p.description}</div> : ''}</td>
              <td><span className="pill">{typeLabel(p.type)}</span></td>
              <td>${money(p.default_price)}</td>
              <td>${money(p.cost)}</td>
              <td>{p.taxable ? 't' : ''}</td>
              <td><button className="btn secondary" onClick={(e) => { e.stopPropagation(); setSelected(p); startEdit(p) }}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {filtered.length === 0 && <p className="muted">No products or services match — add the ones you reuse, or just type custom lines on each ticket.</p>}
    </CollapsibleCard>
  )
}
