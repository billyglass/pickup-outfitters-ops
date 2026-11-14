import { useEffect, useState } from 'react'
import { supabase, supabaseConfigured } from './lib/supabase.js'
import { getSession, getProfile, signOut, enrollMfa, verifyMfaEnroll, listMfaFactors } from './lib/auth.js'
import { store, globalSearch } from './lib/store.js'
import Login from './components/Login.jsx'
import CustomerForm from './components/CustomerForm.jsx'
import VehicleForm from './components/VehicleForm.jsx'
import ImportCustomers from './components/ImportCustomers.jsx'

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'customers', label: 'Customers' },
  { id: 'vehicles', label: 'Vehicles' },
  { id: 'quotes', label: 'Quotes', phase: 'Phase 2' },
  { id: 'invoices', label: 'Invoices', phase: 'Phase 2' },
  { id: 'ar', label: 'Receivables', phase: 'Phase 3', admin: true },
  { id: 'ap', label: 'Payables', phase: 'Phase 3', admin: true },
  { id: 'reports', label: 'Reports', phase: 'Phase 4', admin: true },
  { id: 'import', label: 'Import', admin: true },
  { id: 'settings', label: 'Settings', admin: true },
]

function Placeholder({ title, phase, children }) {
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p className="pill">{phase} — coming next</p>
      <p className="muted">{children}</p>
      <p className="muted">No data is shown here yet, and no placeholder or fake numbers are used.</p>
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [tab, setTab] = useState('dashboard')
  const [data, setData] = useState({ customers: [], contacts: [], addresses: [], vehicles: [], quotes: [], invoices: [], settings: null })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [customerFilter, setCustomerFilter] = useState('')
  const [vehicleFilter, setVehicleFilter] = useState('')
  const [selectedCustomerId, setSelectedCustomerId] = useState(null)
  const [editingCustomer, setEditingCustomer] = useState(undefined) // undefined = list, null = new, object = edit
  const [editingVehicle, setEditingVehicle] = useState(undefined)
  const [preselectedCustomerId, setPreselectedCustomerId] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [mfaQr, setMfaQr] = useState('')
  const [mfaFactorId, setMfaFactorId] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaMsg, setMfaMsg] = useState('')

  const isAdmin = profile?.role === 'admin'

  async function loadData() {
    setLoading(true)
    setError('')
    try {
      setData(await store.load())
    } catch (err) {
      setError(err.message || 'Failed to load data.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    async function init() {
      if (!supabaseConfigured) {
        setAuthChecked(true)
        return
      }
      const session = await getSession()
      if (session?.user) {
        const p = await getProfile(session.user.id)
        if (p && p.active) {
          setUser(session.user)
          setProfile(p)
        }
      }
      setAuthChecked(true)
    }
    init()
  }, [])

  useEffect(() => {
    if (profile) loadData()
  }, [profile]) // eslint-disable-line react-hooks/exhaustive-deps

  function onAuthed(u, p) {
    setUser(u)
    setProfile(p)
  }

  async function doSignOut() {
    if (supabaseConfigured) await signOut()
    setUser(null)
    setProfile(null)
    setTab('dashboard')
  }

  async function runSearch(e) {
    e?.preventDefault()
    if (!searchQuery.trim()) return
    setSearching(true)
    setError('')
    try {
      setSearchResults(await globalSearch(searchQuery, data))
      setTab('search')
    } catch (err) {
      setError(err.message || 'Search failed.')
    } finally {
      setSearching(false)
    }
  }

  async function handleDeleteCustomer(id, company) {
    if (!window.confirm(`Delete customer "${company}" and all of its vehicles? This cannot be undone. Admin only.`)) return
    try {
      await store.deleteCustomer(id)
      setSelectedCustomerId(null)
      await loadData()
    } catch (err) {
      setError(err.message || 'Delete failed.')
    }
  }

  async function handleDeleteVehicle(id) {
    if (!window.confirm('Delete this vehicle? This cannot be undone. Admin only.')) return
    try {
      await store.deleteVehicle(id)
      await loadData()
    } catch (err) {
      setError(err.message || 'Delete failed.')
    }
  }

  if (!authChecked) return <div className="container"><p>Loading…</p></div>
  if (!profile) {
    return (
      <div>
        {!supabaseConfigured && (
          <div className="banner">
            <strong>Local mode — Supabase not connected.</strong> Data saves only in this
            browser. Connect Supabase (see README.md) for the shared shop database.
          </div>
        )}
        <Login onAuthed={onAuthed} />
      </div>
    )
  }

  const customers = data.customers.filter((c) =>
    !customerFilter.trim() ||
    c.company.toLowerCase().includes(customerFilter.toLowerCase())
  )
  const vehicles = data.vehicles.filter((v) => {
    const q = vehicleFilter.trim().toLowerCase()
    if (!q) return true
    return [v.vin_normalized, v.vin, v.fleet_unit, v.plate, v.make, v.model]
      .some((f) => String(f || '').toLowerCase().includes(q))
  })
  const selectedCustomer = data.customers.find((c) => c.id === selectedCustomerId) || null
  const customerName = (id) => data.customers.find((c) => c.id === id)?.company || '—'

  return (
    <div>
      <header className="topbar">
        <div className="brand">PICKUP <span>OUTFITTERS</span></div>
        <nav>
          {TABS.filter((t) => !t.admin || isAdmin).map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => { setTab(t.id); setEditingCustomer(undefined); setEditingVehicle(undefined) }}>
              {t.label}{t.phase ? ` (${t.phase})` : ''}
            </button>
          ))}
        </nav>
        <div className="user">
          <span>{profile.name} <span className={`pill ${profile.role}`}>{profile.role}</span></span>
          <button onClick={doSignOut}>Sign out</button>
        </div>
      </header>

      {!supabaseConfigured && (
        <div className="banner">
          <strong>Local mode — Supabase not connected.</strong> Data saves only in this
          browser. Connect Supabase (see README.md) for the shared shop database.
        </div>
      )}
      {isAdmin && !profile.mfa_enrolled && supabaseConfigured && (
        <div className="banner">
          <strong>Admin MFA not enrolled.</strong> Enroll TOTP in Settings before daily use.
        </div>
      )}

      <div className="container">
        <form onSubmit={runSearch} className="row" style={{ marginBottom: 16 }}>
          <input
            className="searchbox"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search customers, VIN (full / last 6 / last 8), fleet/unit, quote, invoice, PO…"
            aria-label="Global search"
          />
          <button className="btn" type="submit" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
        </form>

        {error && <div className="error">{error}</div>}
        {loading && <p className="muted">Loading…</p>}

        {tab === 'dashboard' && (
          <>
            <h1>Dashboard</h1>
            <p className="muted">Phase 1 — customers and vehicles. Quotes, invoices, receivables, payables, and reports arrive in Phases 2–4.</p>
            <div className="grid">
              <div className="tile"><div className="num">{data.customers.length}</div><div className="label">Customers</div></div>
              <div className="tile"><div className="num">{data.vehicles.length}</div><div className="label">Vehicles</div></div>
              <div className="tile"><div className="num">{data.quotes.length}</div><div className="label">Quotes (Phase 2)</div></div>
              <div className="tile"><div className="num">{data.invoices.length}</div><div className="label">Invoices (Phase 2)</div></div>
              {isAdmin && (
                <>
                  <div className="tile"><div className="num">—</div><div className="label">Receivables — Phase 3 (Admin)</div></div>
                  <div className="tile"><div className="num">—</div><div className="label">Payables — Phase 3 (Admin)</div></div>
                </>
              )}
            </div>
            {data.settings && (
              <p className="muted small">
                Tax rate: {(Number(data.settings.tax_rate) * 100).toFixed(2)}% · Terms: {data.settings.default_payment_terms} · Quote validity: {data.settings.quote_validity_days} days
              </p>
            )}
            <p className="muted small">
              Sales users see no revenue, margin, cost, or report data anywhere in this system — those areas are Admin-only and blocked in the database.
            </p>
          </>
        )}

        {tab === 'search' && searchResults && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Search results for “{searchQuery}”</h2>
            <h3>Customers ({searchResults.customers.length})</h3>
            {searchResults.customers.length === 0 && <p className="muted">No customers matched.</p>}
            {searchResults.customers.map((c) => (
              <div key={c.id} className="row-between" style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
                <span><strong>{c.company}</strong> · {c.payment_terms} {c.tax_exempt ? '· Tax exempt' : ''}</span>
                <button className="btn secondary" onClick={() => { setSelectedCustomerId(c.id); setTab('customers') }}>Open</button>
              </div>
            ))}
            <h3>Vehicles ({searchResults.vehicles.length})</h3>
            {searchResults.vehicles.length === 0 && <p className="muted">No vehicles matched. Try the full VIN, or just the last 6 or 8 characters.</p>}
            {searchResults.vehicles.map((v) => (
              <div key={v.id} style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
                <strong>{v.year || ''} {v.make || ''} {v.model || ''}</strong> · VIN {v.vin || '—'} · Unit {v.fleet_unit || '—'} · Plate {v.plate || '—'} · {customerName(v.customer_id)}
              </div>
            ))}
            <h3>Quotes ({searchResults.quotes.length}) · Invoices ({searchResults.invoices.length})</h3>
            {searchResults.quotes.map((q) => (
              <div key={q.id}>{q.number} · {q.status} · {customerName(q.customer_id)}</div>
            ))}
            {searchResults.invoices.map((inv) => (
              <div key={inv.id}>{inv.number} · {inv.status} · {customerName(inv.customer_id)}</div>
            ))}
            {(searchResults.quotes.length === 0 && searchResults.invoices.length === 0) && (
              <p className="muted">No quotes or invoices matched yet — those tables are Phase 2 scaffolding and are empty in Phase 1.</p>
            )}
          </div>
        )}

        {tab === 'customers' && (
          <>
            {editingCustomer !== undefined ? (
              <CustomerForm
                key={editingCustomer?.id || 'new'}
                initial={editingCustomer}
                contacts={editingCustomer ? data.contacts.filter((c) => c.customer_id === editingCustomer.id) : []}
                addresses={editingCustomer ? data.addresses.filter((a) => a.customer_id === editingCustomer.id) : []}
                onSaved={async (saved) => { setEditingCustomer(undefined); setSelectedCustomerId(saved.id); await loadData() }}
                onCancel={() => setEditingCustomer(undefined)}
              />
            ) : selectedCustomer ? (
              <div className="card">
                <div className="row-between">
                  <h2 style={{ margin: 0 }}>{selectedCustomer.company}</h2>
                  <button className="btn secondary" onClick={() => setSelectedCustomerId(null)}>← All customers</button>
                </div>
                <p className="muted">
                  Terms: {selectedCustomer.payment_terms} · {selectedCustomer.tax_exempt ? 'Tax exempt' : 'Taxable'}
                  {selectedCustomer.tax_exempt_doc_note ? ` · ${selectedCustomer.tax_exempt_doc_note}` : ''}
                </p>
                {selectedCustomer.po_requirements && <p><strong>PO requirements:</strong> {selectedCustomer.po_requirements}</p>}
                {selectedCustomer.notes && <p><strong>Notes:</strong> {selectedCustomer.notes}</p>}
                <h3>Contacts</h3>
                {data.contacts.filter((c) => c.customer_id === selectedCustomer.id).map((c) => (
                  <div key={c.id}>{c.name} {c.title ? `(${c.title})` : ''} · {c.phone || '—'} · {c.email || '—'}</div>
                ))}
                {data.contacts.filter((c) => c.customer_id === selectedCustomer.id).length === 0 && <p className="muted">No contacts yet.</p>}
                <h3>Addresses</h3>
                {data.addresses.filter((a) => a.customer_id === selectedCustomer.id).map((a) => (
                  <div key={a.id}>{a.address_type}: {a.line1 || ''} {a.city || ''} {a.state || ''} {a.zip || ''}</div>
                ))}
                {data.addresses.filter((a) => a.customer_id === selectedCustomer.id).length === 0 && <p className="muted">No addresses yet.</p>}
                <h3>Vehicles ({data.vehicles.filter((v) => v.customer_id === selectedCustomer.id).length})</h3>
                {data.vehicles.filter((v) => v.customer_id === selectedCustomer.id).map((v) => (
                  <div key={v.id} className="row-between" style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
                    <span><strong>{v.year || ''} {v.make || ''} {v.model || ''}</strong> · VIN {v.vin || '—'} · Unit {v.fleet_unit || '—'} · Plate {v.plate || '—'}</span>
                    <button className="btn secondary" onClick={() => { setEditingVehicle(v); setTab('vehicles') }}>Edit</button>
                  </div>
                ))}
                <div className="row" style={{ marginTop: 16 }}>
                  <button className="btn" onClick={() => setEditingCustomer(selectedCustomer)}>Edit customer</button>
                  <button className="btn secondary" onClick={() => { setPreselectedCustomerId(selectedCustomer.id); setEditingVehicle(null); setTab('vehicles') }}>+ Add vehicle</button>
                  {isAdmin && <button className="btn danger" onClick={() => handleDeleteCustomer(selectedCustomer.id, selectedCustomer.company)}>Delete customer</button>}
                </div>
              </div>
            ) : (
              <div className="card">
                <div className="row-between">
                  <h2 style={{ margin: 0 }}>Customers ({customers.length})</h2>
                  <button className="btn" onClick={() => setEditingCustomer(null)}>+ New customer</button>
                </div>
                <input value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} placeholder="Filter by company name…" style={{ marginTop: 12 }} />
                <table>
                  <thead><tr><th>Company</th><th>Terms</th><th>Tax</th><th>Vehicles</th><th></th></tr></thead>
                  <tbody>
                    {customers.map((c) => (
                      <tr key={c.id}>
                        <td><strong>{c.company}</strong></td>
                        <td>{c.payment_terms}</td>
                        <td>{c.tax_exempt ? 'Exempt' : 'Taxable'}</td>
                        <td>{data.vehicles.filter((v) => v.customer_id === c.id).length}</td>
                        <td><button className="btn secondary" onClick={() => setSelectedCustomerId(c.id)}>Open</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {customers.length === 0 && <p className="muted">No customers yet. Start fresh, or import from QuickBooks (Admin → Import tab).</p>}
              </div>
            )}
          </>
        )}

        {tab === 'vehicles' && (
          <>
            {editingVehicle !== undefined ? (
              <VehicleForm
                key={editingVehicle?.id || `new-${preselectedCustomerId}`}
                initial={editingVehicle}
                customers={data.customers}
                preselectedCustomerId={preselectedCustomerId}
                onSaved={async () => { setEditingVehicle(undefined); setPreselectedCustomerId(''); await loadData() }}
                onCancel={() => { setEditingVehicle(undefined); setPreselectedCustomerId('') }}
              />
            ) : (
              <div className="card">
                <div className="row-between">
                  <h2 style={{ margin: 0 }}>Vehicles ({vehicles.length})</h2>
                  <button className="btn" onClick={() => { setPreselectedCustomerId(''); setEditingVehicle(null) }}>+ New vehicle</button>
                </div>
                <input value={vehicleFilter} onChange={(e) => setVehicleFilter(e.target.value)} placeholder="Filter by VIN, fleet/unit, plate, make…" style={{ marginTop: 12 }} />
                <table>
                  <thead><tr><th>Vehicle</th><th>VIN</th><th>Fleet / unit</th><th>Plate</th><th>Customer</th><th></th></tr></thead>
                  <tbody>
                    {vehicles.map((v) => (
                      <tr key={v.id}>
                        <td>{v.year || ''} {v.make || ''} {v.model || ''}</td>
                        <td>{v.vin || '—'}</td>
                        <td>{v.fleet_unit || '—'}</td>
                        <td>{v.plate || '—'}</td>
                        <td>{customerName(v.customer_id)}</td>
                        <td>
                          <button className="btn secondary" onClick={() => setEditingVehicle(v)}>Edit</button>{' '}
                          {isAdmin && <button className="btn secondary" onClick={() => handleDeleteVehicle(v.id)}>Delete</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {vehicles.length === 0 && <p className="muted">No vehicles yet.</p>}
              </div>
            )}
          </>
        )}

        {tab === 'quotes' && (
          <Placeholder title="Quotes" phase="Phase 2">
            Draft / Sent / Accepted / Declined / Expired, with line items, an outstanding-quotes screen,
            expiration and follow-up dates, and conversion to invoice without retyping.
          </Placeholder>
        )}
        {tab === 'invoices' && (
          <Placeholder title="Invoices" phase="Phase 2">
            Atomic numbering from INV-1001, quote conversion, snapshots so later edits never rewrite
            an issued invoice, and version-conflict protection.
          </Placeholder>
        )}
        {tab === 'ar' && isAdmin && (
          <Placeholder title="Accounts receivable" phase="Phase 3">
            Open invoices, aging (Current, 1–30, 31–60, 61–90, 90+), partial payments, deposits,
            credits, refunds, allocations across invoices, and customer statements.
          </Placeholder>
        )}
        {tab === 'ap' && isAdmin && (
          <Placeholder title="Accounts payable" phase="Phase 3">
            Vendor records, vendor bills, due dates, payment history, and duplicate-bill warnings.
          </Placeholder>
        )}
        {tab === 'reports' && isAdmin && (
          <Placeholder title="Reports" phase="Phase 4">
            Sales invoiced vs. payments collected, aging, customer and salesperson reporting,
            quote conversion, AP totals, tax summaries, and gross profit only where cost is known.
          </Placeholder>
        )}
        {tab === 'import' && isAdmin && (
          <ImportCustomers
            existingCustomers={data.customers}
            existingContacts={data.contacts}
            onImported={loadData}
          />
        )}
        {tab === 'settings' && isAdmin && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Settings (Admin only)</h2>
            <p className="muted">
              Tax rate: {data.settings ? `${(Number(data.settings.tax_rate) * 100).toFixed(2)}%` : '—'} ·
              Terms: {data.settings?.default_payment_terms || '—'} ·
              Quote validity: {data.settings?.quote_validity_days || '—'} days ·
              Invoice numbers start INV-1001 · Quote numbers start QT-1001.
            </p>
            <p className="muted">
              Numbering prefixes and next numbers live in the <code>settings</code> table and the
              Postgres sequences — change them with the SQL functions in <code>supabase/schema.sql</code>{' '}
              (<code>admin_set_next_invoice_number</code> / <code>admin_set_next_quote_number</code>).
              A settings editor UI is Phase 2.
            </p>
            <h3>Admin MFA (TOTP)</h3>
            {mfaMsg && <div className="success">{mfaMsg}</div>}
            {!mfaQr ? (
              <button
                className="btn secondary"
                disabled={!supabaseConfigured}
                onClick={async () => {
                  try {
                    const d = await enrollMfa()
                    setMfaFactorId(d.id)
                    setMfaQr(d.totp?.qr_code || '')
                  } catch (err) {
                    setError(err.message || 'MFA enroll failed.')
                  }
                }}
              >
                Enroll MFA (authenticator app)
              </button>
            ) : (
              <div>
                <p>Scan this code in your authenticator app, then enter the 6-digit code.</p>
                <div dangerouslySetInnerHTML={{ __html: mfaQr }} />
                <div className="row">
                  <input value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="123456" style={{ maxWidth: 160 }} />
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        await verifyMfaEnroll(mfaFactorId, mfaCode)
                        setMfaMsg('MFA enrolled. Mark mfa_enrolled=true on your profiles row (see README.md).')
                        setMfaQr('')
                      } catch (err) {
                        setError(err.message || 'MFA verification failed.')
                      }
                    }}
                  >
                    Verify &amp; finish
                  </button>
                </div>
              </div>
            )}
            <p className="small muted">
              MFA status is also visible via Supabase Auth. <button className="btn secondary" disabled={!supabaseConfigured} onClick={async () => { const d = await listMfaFactors(); setMfaMsg(`Enrolled factors: ${d?.totp?.length || 0}`) }}>Check enrolled factors</button>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
