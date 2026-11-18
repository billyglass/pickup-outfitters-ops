import { useEffect, useState } from 'react'
import { supabase, supabaseConfigured } from './lib/supabase.js'
import { getSession, getProfile, signOut, enrollMfa, verifyMfaEnroll, listMfaFactors, updatePassword, isInviteOrRecoveryCallback, clearAuthHash } from './lib/auth.js'
import { store, globalSearch } from './lib/store.js'
import Login, { SetPassword } from './components/Login.jsx'
import CustomerForm from './components/CustomerForm.jsx'
import VehicleForm from './components/VehicleForm.jsx'
import ImportCustomers from './components/ImportCustomers.jsx'
import Quotes from './components/Quotes.jsx'
import Invoices from './components/Invoices.jsx'
import Products from './components/Products.jsx'

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'customers', label: 'Customers' },
  { id: 'vehicles', label: 'Vehicles' },
  { id: 'quotes', label: 'Quotes' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'products', label: 'Products', admin: true },
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
  const [data, setData] = useState({ customers: [], contacts: [], addresses: [], vehicles: [], quotes: [], invoices: [], quoteLines: [], invoiceLines: [], products: [], profiles: [], settings: null })
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
  const [searchFilters, setSearchFilters] = useState({ type: '', status: '', customerId: '', salespersonId: '', from: '', to: '' })
  const [mfaQr, setMfaQr] = useState('')
  const [mfaFactorId, setMfaFactorId] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaMsg, setMfaMsg] = useState('')
  // Invite / password-reset callback: user has a session from the link but
  // no password yet — show Set-password instead of the Dashboard.
  const [passwordSetup, setPasswordSetup] = useState(false)
  // Settings > Change password
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState('')
  const [pwError, setPwError] = useState('')

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
        // Invite / reset link landed here: session exists, but the user
        // has no password yet — show Set-password, not the Dashboard.
        // (Supabase parses the #access_token=...&type=invite|recovery
        // hash into the session on load; see lib/supabase.js.)
        if (isInviteOrRecoveryCallback()) {
          setUser(session.user)
          setPasswordSetup(true)
        } else {
          const p = await getProfile(session.user.id)
          if (p && p.active) {
            setUser(session.user)
            setProfile(p)
          }
        }
      }
      setAuthChecked(true)
    }
    init()
    // A PASSWORD_RECOVERY event can also arrive after load (e.g. the
    // reset link was opened in this tab) — route it to Set-password too.
    if (!supabaseConfigured) return undefined
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setPasswordSetup(true)
    })
    return () => subscription.unsubscribe()
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
      setSearchResults(await globalSearch(searchQuery, data, searchFilters))
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
  // Invite / reset callback: session exists, password not set yet.
  if (passwordSetup && user) {
    return (
      <SetPassword
        user={user}
        onDone={(u, p) => { setPasswordSetup(false); clearAuthHash(); onAuthed(u, p) }}
        onSignOut={async () => { setPasswordSetup(false); clearAuthHash(); await doSignOut() }}
      />
    )
  }
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
  const customerName = (id) => id ? data.customers.find((c) => c.id === id)?.company || '—' : 'Walk-in'

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
            <p className="muted">Quotes and invoices are live. Receivables, payables, and reports arrive in Phases 3–4.</p>
            <div className="grid">
              <div className="tile"><div className="num">{data.customers.length}</div><div className="label">Customers</div></div>
              <div className="tile"><div className="num">{data.vehicles.length}</div><div className="label">Vehicles</div></div>
              <div className="tile"><div className="num">{data.quotes.filter((q) => ['Draft', 'Sent', 'Accepted'].includes(q.status)).length}</div><div className="label">Outstanding quotes</div></div>
              <div className="tile"><div className="num">{data.invoices.filter((i) => ['Draft', 'Issued', 'Partially Paid'].includes(i.status)).length}</div><div className="label">Open invoices</div></div>
              {isAdmin && (
                <>
                  <div className="tile"><div className="num">${data.quotes.filter((q) => ['Draft', 'Sent', 'Accepted'].includes(q.status)).reduce((s, q) => s + Number(q.total || 0), 0).toFixed(2)}</div><div className="label">Outstanding quote value</div></div>
                  <div className="tile"><div className="num">${data.invoices.filter((i) => ['Draft', 'Issued', 'Partially Paid'].includes(i.status)).reduce((s, i) => s + Number(i.balance_due ?? i.total ?? 0), 0).toFixed(2)}</div><div className="label">Open invoice balance</div></div>
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
            <p className="muted small">Searches inside quotes and invoices too — VIN (full / last 6 / last 8), part numbers, line-item descriptions, numbers, and PO numbers.</p>
            <div className="row" style={{ marginBottom: 12 }}>
              <select value={searchFilters.type} onChange={(e) => setSearchFilters({ ...searchFilters, type: e.target.value })}>
                <option value="">Quotes + invoices</option>
                <option value="quote">Quotes only</option>
                <option value="invoice">Invoices only</option>
              </select>
              <select value={searchFilters.status} onChange={(e) => setSearchFilters({ ...searchFilters, status: e.target.value })}>
                <option value="">Any status</option>
                {['Draft', 'Sent', 'Accepted', 'Declined', 'Expired', 'Issued', 'Partially Paid', 'Paid', 'Void'].map((s) => <option key={s}>{s}</option>)}
              </select>
              <select value={searchFilters.customerId} onChange={(e) => setSearchFilters({ ...searchFilters, customerId: e.target.value })}>
                <option value="">Any customer</option>
                <option value="walk-in">Walk-in (no customer record)</option>
                {data.customers.map((c) => <option key={c.id} value={c.id}>{c.company}</option>)}
              </select>
              <select value={searchFilters.salespersonId} onChange={(e) => setSearchFilters({ ...searchFilters, salespersonId: e.target.value })}>
                <option value="">Any salesperson</option>
                {(data.profiles || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input type="date" value={searchFilters.from} onChange={(e) => setSearchFilters({ ...searchFilters, from: e.target.value })} aria-label="From date" />
              <input type="date" value={searchFilters.to} onChange={(e) => setSearchFilters({ ...searchFilters, to: e.target.value })} aria-label="To date" />
              <button className="btn secondary" onClick={runSearch}>Apply filters</button>
            </div>
            <h3>Tickets ({(searchResults.tickets || []).length})</h3>
            {(searchResults.tickets || []).length === 0 && <p className="muted">No quotes or invoices matched.</p>}
            {(searchResults.tickets || []).map((r) => (
              <div key={`${r.type}-${r.ticket.id}`} style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
                <strong>{r.ticket.number}</strong> · {r.type === 'quote' ? 'Quote' : 'Invoice'} · {r.ticket.status} · {r.customer} · VIN {r.vin || '—'} · {r.ticket.issue_date || (r.ticket.created_at || '').slice(0, 10)} · {r.salesperson || '—'} · ${Number(r.ticket.total || 0).toFixed(2)}
                <div className="muted small">Matched: {r.match}</div>
              </div>
            ))}
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
            {editingVehicle ? (
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
                </div>
                <p className="muted">Vehicles are created automatically from quotes and invoices — enter the VIN and Year/Make/Model on the ticket and it shows up here. Use Edit below to correct a typo on a vehicle record.</p>
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
                {vehicles.length === 0 && <p className="muted">No vehicles yet — create a quote or invoice and enter the VIN and Year/Make/Model on the ticket, and the vehicle will appear here.</p>}
              </div>
            )}
          </>
        )}

        {tab === 'quotes' && (
          <Quotes data={data} user={user} profile={profile} isAdmin={isAdmin} settings={data.settings} onReload={loadData} onError={setError} />
        )}
        {tab === 'invoices' && (
          <Invoices data={data} user={user} profile={profile} isAdmin={isAdmin} settings={data.settings} onReload={loadData} onError={setError} />
        )}
        {tab === 'products' && isAdmin && (
          <Products data={data} isAdmin={isAdmin} onReload={loadData} onError={setError} />
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
              A settings editor UI is not built yet — numbering is managed with those SQL functions.
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
            <h3>Change password</h3>
            <p className="muted small">Signed in as {user?.email}. At least 8 characters.</p>
            {pwMsg && <div className="success">{pwMsg}</div>}
            {pwError && <div className="error">{pwError}</div>}
            <div className="row">
              <input
                type="password"
                autoComplete="new-password"
                placeholder="New password"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
                style={{ maxWidth: 220 }}
              />
              <input
                type="password"
                autoComplete="new-password"
                placeholder="Confirm new password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                style={{ maxWidth: 220 }}
              />
              <button
                className="btn"
                disabled={pwBusy || !supabaseConfigured}
                onClick={async () => {
                  setPwMsg('')
                  setPwError('')
                  if (pwNew.length < 8) { setPwError('Password must be at least 8 characters.'); return }
                  if (pwNew !== pwConfirm) { setPwError('Passwords do not match.'); return }
                  setPwBusy(true)
                  try {
                    await updatePassword(pwNew)
                    setPwMsg('Password changed.')
                    setPwNew('')
                    setPwConfirm('')
                  } catch (err) {
                    setPwError(err.message || 'Could not change password.')
                  } finally {
                    setPwBusy(false)
                  }
                }}
              >
                {pwBusy ? 'Saving…' : 'Change password'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
