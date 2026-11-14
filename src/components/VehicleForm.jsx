import { useEffect, useState } from 'react'
import { store, VersionConflict } from '../lib/store.js'
import { normalizeVin } from '../lib/csv.js'

export default function VehicleForm({ initial, customers, preselectedCustomerId, onSaved, onCancel }) {
  const [vehicle, setVehicle] = useState(
    initial || { customer_id: preselectedCustomerId || '', vin: '', year: '', make: '', model: '', fleet_unit: '', plate: '', notes: '' }
  )
  const [vinMatches, setVinMatches] = useState([])
  const [status, setStatus] = useState('saved')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState('')

  const normalized = normalizeVin(vehicle.vin)

  // VIN duplicate check — warn, do not block. Legitimate exceptions exist.
  useEffect(() => {
    if (!normalized || normalized.length < 6) {
      setVinMatches([])
      return
    }
    const t = setTimeout(async () => {
      try {
        setVinMatches(await store.checkVin(vehicle.vin, vehicle.id))
      } catch {
        setVinMatches([])
      }
    }, 400)
    return () => clearTimeout(t)
  }, [vehicle.vin]) // eslint-disable-line react-hooks/exhaustive-deps

  function markDirty(patch) {
    setVehicle((v) => ({ ...v, ...patch }))
    setStatus('unsaved')
  }

  async function save(e) {
    e?.preventDefault()
    if (!vehicle.customer_id) {
      setError('Choose a customer for this vehicle.')
      return
    }
    setError('')
    setConflict('')
    setStatus('saving')
    try {
      const saved = await store.saveVehicle({
        ...vehicle,
        year: vehicle.year ? Number(vehicle.year) : null,
      })
      setVehicle(saved)
      setStatus('saved')
      onSaved(saved)
    } catch (err) {
      setStatus('unsaved')
      if (err instanceof VersionConflict) setConflict(err.message)
      else setError(err.message || 'Save failed.')
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>{initial ? 'Edit vehicle' : 'New vehicle'}</h2>
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
          <label htmlFor="vf-customer">Customer *</label>
          <select id="vf-customer" value={vehicle.customer_id} onChange={(e) => markDirty({ customer_id: e.target.value })} required>
            <option value="">— Choose customer —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.company}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="vf-vin">VIN</label>
          <input id="vf-vin" value={vehicle.vin || ''} onChange={(e) => markDirty({ vin: e.target.value })} placeholder="Full VIN" autoComplete="off" />
          {normalized && <p className="small muted">Normalized: {normalized} ({normalized.length} chars)</p>}
        </div>
        <div>
          <label htmlFor="vf-year">Year</label>
          <input id="vf-year" type="number" min="1900" max="2100" value={vehicle.year || ''} onChange={(e) => markDirty({ year: e.target.value })} />
        </div>
        <div>
          <label htmlFor="vf-make">Make</label>
          <input id="vf-make" value={vehicle.make || ''} onChange={(e) => markDirty({ make: e.target.value })} placeholder="Ford" />
        </div>
        <div>
          <label htmlFor="vf-model">Model</label>
          <input id="vf-model" value={vehicle.model || ''} onChange={(e) => markDirty({ model: e.target.value })} placeholder="F-250" />
        </div>
        <div>
          <label htmlFor="vf-fleet">Fleet / unit number</label>
          <input id="vf-fleet" value={vehicle.fleet_unit || ''} onChange={(e) => markDirty({ fleet_unit: e.target.value })} />
        </div>
        <div>
          <label htmlFor="vf-plate">License plate</label>
          <input id="vf-plate" value={vehicle.plate || ''} onChange={(e) => markDirty({ plate: e.target.value })} />
        </div>
      </div>
      {vinMatches.length > 0 && (
        <div className="warn">
          <strong>Possible duplicate VIN.</strong> This VIN already exists on{' '}
          {vinMatches.length} other vehicle record{vinMatches.length > 1 ? 's' : ''}:
          {vinMatches.map((m) => (
            <div key={m.id} className="small">
              {m.year || ''} {m.make || ''} {m.model || ''} — unit {m.fleet_unit || '—'}, plate {m.plate || '—'}
            </div>
          ))}
          You can still save — this is a warning, not a block. Check it is not a
          typo or a vehicle already on file before saving.
        </div>
      )}
      <div>
        <label htmlFor="vf-notes">Notes</label>
        <textarea id="vf-notes" rows={3} value={vehicle.notes || ''} onChange={(e) => markDirty({ notes: e.target.value })} />
      </div>
      <div className="row" style={{ marginTop: 20 }}>
        <button className="btn" type="submit" disabled={status === 'saving'}>Save vehicle</button>
        <button className="btn secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
