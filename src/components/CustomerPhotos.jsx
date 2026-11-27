import { useEffect, useState } from 'react'
import { store } from '../lib/store.js'
import { useCollapsed, CollapseButton } from './CollapsibleCard.jsx'

// Mini-CRM photo gallery on a customer profile. Files live in the private
// 'customer-photos' Storage bucket and are shown via 1-hour signed URLs —
// the bucket is never public. Any active user may delete a photo (one
// confirm, same as the other delete buttons in the app).
export default function CustomerPhotos({ customerId, userId }) {
  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [caption, setCaption] = useState('')
  const [uploading, setUploading] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  // Minimize (Nov 27): header stays, the gallery hides with CSS — never
  // unmounted, so an in-progress upload is not lost.
  const { collapsed, toggle } = useCollapsed(userId, 'profile-photos')

  async function load() {
    if (!store.configured) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      setPhotos(await store.listPhotos(customerId))
    } catch (err) {
      setError(err.message || 'Could not load photos.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!store.configured) {
    return (
      <div className="ticket-section">
        <h3 style={{ marginTop: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Photos (0)</span>
          <CollapseButton collapsed={collapsed} onToggle={toggle} label="Customer photos" />
        </h3>
        <div className="collapse-body" style={collapsed ? { display: 'none' } : undefined}>
        <p className="muted">Photos are available when connected to the live database.</p>
        </div>
      </div>
    )
  }

  async function onFiles(e) {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    if (!files.length) return
    setError('')
    setUploading(true)
    try {
      for (const f of files) {
        const saved = await store.uploadPhoto(customerId, f, caption, userId)
        setPhotos((ps) => [saved, ...ps])
      }
      setCaption('')
    } catch (err) {
      setError(err.message || 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  async function remove(photo) {
    setError('')
    try {
      await store.deletePhoto(photo)
      setPhotos((ps) => ps.filter((p) => p.id !== photo.id))
      setConfirmDeleteId(null)
    } catch (err) {
      setError(err.message || 'Delete failed.')
    }
  }

  return (
    <div className="ticket-section">
      <h3 style={{ marginTop: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Photos ({photos.length})</span>
        <CollapseButton collapsed={collapsed} onToggle={toggle} label="Customer photos" />
      </h3>
      <div className="collapse-body" style={collapsed ? { display: 'none' } : undefined}>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div>
          <label>Caption (optional — applies to this upload)</label>
          <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="e.g. Shop front, fleet yard…" />
        </div>
        <div>
          <label>Upload photos</label>
          <input type="file" accept="image/*" multiple disabled={uploading} onChange={onFiles} />
        </div>
      </div>
      <p className="muted small">Images only, up to 5 MB each. Click a photo to open the full image in a new tab.</p>
      {uploading && <p className="muted">Uploading…</p>}
      {error && <div className="error">{error}</div>}
      {loading ? (
        <p className="muted">Loading photos…</p>
      ) : photos.length === 0 ? (
        <p className="muted">No photos yet — upload the first one above.</p>
      ) : (
        <div className="photo-grid">
          {photos.map((p) => (
            <div key={p.id} className="photo-item">
              <a href={p.signedUrl || '#'} target="_blank" rel="noreferrer">
                {p.signedUrl
                  ? <img src={p.signedUrl} alt={p.caption || p.file_name || 'Customer photo'} />
                  : <div className="photo-missing">Preview unavailable</div>}
              </a>
              {p.caption && <div className="photo-caption">{p.caption}</div>}
              <div className="photo-actions">
                {confirmDeleteId === p.id ? (
                  <span>
                    Delete this photo?{' '}
                    <button className="btn danger small" type="button" onClick={() => remove(p)}>Yes, delete</button>{' '}
                    <button className="btn secondary small" type="button" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                  </span>
                ) : (
                  <button className="btn secondary small" type="button" onClick={() => setConfirmDeleteId(p.id)}>Delete</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  )
}
