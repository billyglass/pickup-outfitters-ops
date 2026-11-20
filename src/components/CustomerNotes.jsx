import { useEffect, useState } from 'react'
import { store } from '../lib/store.js'
import { fmtDate } from '../lib/tickets.js'

// Dated running log on a customer profile (mini-CRM). Notes are added
// right here — no Edit needed — newest first, each with its date and the
// name of whoever wrote it when known. Imported notes (from the old
// single notes box) have no author, so they show just the date. Any
// active user may delete a note (one confirm, same as photos and the
// other delete buttons in the app).
export default function CustomerNotes({ customerId, userId, profiles }) {
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [body, setBody] = useState('')
  const [adding, setAdding] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  async function load() {
    if (!store.configured) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      setNotes(await store.listNotes(customerId))
    } catch (err) {
      setError(err.message || 'Could not load notes.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!store.configured) {
    return (
      <div className="ticket-section">
        <h3 style={{ marginTop: 0 }}>Notes (0)</h3>
        <p className="muted">Notes are available when connected to the live database.</p>
      </div>
    )
  }

  async function add() {
    const text = body.trim()
    if (!text) return
    setError('')
    setAdding(true)
    try {
      const saved = await store.addNote(customerId, text, userId)
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
      await store.deleteNote(note.id)
      setNotes((ns) => ns.filter((n) => n.id !== note.id))
      setConfirmDeleteId(null)
    } catch (err) {
      setError(err.message || 'Delete failed.')
    }
  }

  return (
    <div className="ticket-section">
      <h3 style={{ marginTop: 0 }}>Notes ({notes.length})</h3>
      <div>
        <label>Add a note</label>
        <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="e.g. Called 11/19 — wants the upfit done before deer season…" />
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
            <div key={n.id} style={{ borderTop: '1px solid #eee', padding: '10px 0' }}>
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
  )
}
