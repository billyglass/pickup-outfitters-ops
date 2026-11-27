import { useEffect, useState } from 'react'
import { store } from '../lib/store.js'
import { fmtDate } from '../lib/tickets.js'
import { useCollapsed, CollapseButton } from './CollapsibleCard.jsx'

// Dated running log on a product/service record (shared catalog). Notes
// are added right here — no Edit needed — newest first, each with its date
// and the name of whoever wrote it when known. Any active user may delete
// a note (one confirm, same as customer notes and the other delete buttons
// in the app). Mirrors CustomerNotes.jsx.
export default function ProductNotes({ productId, userId, profiles }) {
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [body, setBody] = useState('')
  const [adding, setAdding] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  // Minimize (Nov 27): header stays, the log hides with CSS — never
  // unmounted, so a note being typed is not lost.
  const { collapsed, toggle } = useCollapsed(userId, 'product-notes')

  async function load() {
    if (!store.configured) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      setNotes(await store.listProductNotes(productId))
    } catch (err) {
      setError(err.message || 'Could not load notes.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [productId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!store.configured) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Notes (0)</span>
          <CollapseButton collapsed={collapsed} onToggle={toggle} label="Product notes" />
        </h3>
        <div className="collapse-body" style={collapsed ? { display: 'none' } : undefined}>
        <p className="muted">Notes are available when connected to the live database.</p>
        </div>
      </div>
    )
  }

  async function add() {
    const text = body.trim()
    if (!text) return
    setError('')
    setAdding(true)
    try {
      const saved = await store.addProductNote(productId, text, userId)
      setNotes((ns) => [saved, ...ns])
      setBody('')
    } catch (err) {
      setError(err.message || 'Could not add note.')
    } finally {
      setAdding(false)
    }
  }

  async function remove(note) {
    setError('')
    try {
      await store.deleteProductNote(note.id)
      setNotes((ns) => ns.filter((n) => n.id !== note.id))
      setConfirmDeleteId(null)
    } catch (err) {
      setError(err.message || 'Delete failed.')
    }
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Notes ({notes.length})</span>
        <CollapseButton collapsed={collapsed} onToggle={toggle} label="Product notes" />
      </h3>
      <div className="collapse-body" style={collapsed ? { display: 'none' } : undefined}>
      <div>
        <label>Add a note</label>
        <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="e.g. Custom install — takes about 2 hours, needs the tall ladder rack…" />
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" type="button" disabled={adding || !body.trim()} onClick={add}>{adding ? 'Adding…' : 'Add note'}</button>
      </div>
      {error && <div className="error">{error}</div>}
      {loading ? (
        <p className="muted">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="muted">No notes yet — add the first one above.</p>
      ) : (
        notes.map((n) => {
          const author = (profiles || []).find((p) => p.id === n.created_by)?.name
          return (
            <div key={n.id} className="zebra-row" style={{ borderTop: '1px solid #eee', padding: '10px 0' }}>
              <div className="row-between">
                <span className="muted small"><strong>{fmtDate(n.created_at)}</strong>{author ? ` · ${author}` : ''}</span>
                {confirmDeleteId === n.id ? (
                  <span>
                    Delete this note?{' '}
                    <button className="btn danger small" type="button" onClick={() => remove(n)}>Yes, delete</button>{' '}
                    <button className="btn secondary small" type="button" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                  </span>
                ) : (
                  <button className="btn secondary small" type="button" onClick={() => setConfirmDeleteId(n.id)}>Delete</button>
                )}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{n.body}</div>
            </div>
          )
        })
      )}
      </div>
    </div>
  )
}
