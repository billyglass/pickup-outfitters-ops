import { useState } from 'react'
import { parseCsv, rowsToObjects, downloadQbTemplate, QB_TEMPLATE_HEADERS, normalizePhone } from '../lib/csv.js'
import { store } from '../lib/store.js'

// Admin-only QuickBooks customer CSV import.
// Flow: download template -> export from QuickBooks -> upload here ->
// preview + duplicate check -> select rows -> import. Nothing is imported
// until the Admin confirms in the preview. No live QuickBooks API in Phase 1.
export default function ImportCustomers({ existingCustomers, existingContacts, onImported }) {
  const [rows, setRows] = useState([])
  const [selected, setSelected] = useState({})
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  const [fileName, setFileName] = useState('')

  function isDuplicate(row) {
    const company = String(row.Company || '').trim().toLowerCase()
    if (!company) return 'Missing company name'
    if (existingCustomers.some((c) => String(c.company || '').trim().toLowerCase() === company)) {
      return 'Same company already exists'
    }
    const phone = normalizePhone(row.Phone || '')
    const email = String(row.Email || '').trim().toLowerCase()
    if (phone && existingContacts.some((c) => normalizePhone(c.phone || '') === phone && phone.length >= 7)) {
      return 'Same phone already on file'
    }
    if (email && existingContacts.some((c) => String(c.email || '').trim().toLowerCase() === email)) {
      return 'Same email already on file'
    }
    return ''
  }

  async function onFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setSuccess('')
    setFileName(file.name)
    const text = await file.text()
    const parsed = rowsToObjects(parseCsv(text))
    const withCompany = parsed.filter((r) => String(r.Company || '').trim() !== '')
    if (!withCompany.length) {
      setError('No rows with a Company name were found. Check the column headers against the template — see docs/QUICKBOOKS_IMPORT.md.')
      setRows([])
      return
    }
    setRows(withCompany)
    const sel = {}
    withCompany.forEach((r, i) => {
      sel[i] = !isDuplicate(r)
    })
    setSelected(sel)
  }

  async function doImport() {
    const chosen = rows.filter((_, i) => selected[i])
    if (!chosen.length) {
      setError('Select at least one row to import.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const created = await store.importCustomers(chosen)
      setSuccess(`Imported ${created.length} customer${created.length === 1 ? '' : 's'}.`)
      setRows([])
      onImported()
    } catch (err) {
      setError(err.message || 'Import failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Import customers from QuickBooks (CSV)</h2>
      <p className="muted">
        Admin only. Export customers from QuickBooks as a CSV, upload it here,
        review the preview, then import. Duplicates are flagged — they are
        unchecked by default, not imported silently. No invoices are imported
        in Phase 1; this is customers only, for accounts receivable.
      </p>
      <div className="row">
        <button className="btn secondary" type="button" onClick={downloadQbTemplate}>
          Download CSV template
        </button>
        <label className="btn secondary" style={{ cursor: 'pointer' }}>
          Choose CSV file…
          <input type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: 'none' }} />
        </label>
        <span className="small muted">{fileName}</span>
      </div>
      <p className="small muted">
        Expected columns: {QB_TEMPLATE_HEADERS.join(', ')}. Full QBO / QB Desktop
        export mapping is in <code>docs/QUICKBOOKS_IMPORT.md</code>.
      </p>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}
      {rows.length > 0 && (
        <>
          <p className="small">
            {rows.length} rows in file — {Object.values(selected).filter(Boolean).length} selected for import.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th></th><th>Company</th><th>Contact</th><th>Phone</th><th>Email</th><th>Terms</th><th>Tax exempt</th><th>Duplicate check</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const dup = isDuplicate(r)
                  return (
                    <tr key={i}>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!selected[i]}
                          onChange={(e) => setSelected({ ...selected, [i]: e.target.checked })}
                          style={{ width: 'auto' }}
                        />
                      </td>
                      <td>{r.Company}</td>
                      <td>{r.Contact}</td>
                      <td>{r.Phone}</td>
                      <td>{r.Email}</td>
                      <td>{r.Terms}</td>
                      <td>{r['Tax Exempt']}</td>
                      <td>{dup ? <span className="pill">⚠ {dup}</span> : <span className="pill">OK</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" onClick={doImport} disabled={busy}>
              {busy ? 'Importing…' : 'Import selected customers'}
            </button>
            <button className="btn secondary" onClick={() => { setRows([]); setFileName('') }}>Clear preview</button>
          </div>
        </>
      )}
    </div>
  )
}
