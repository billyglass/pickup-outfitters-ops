import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase, supabaseConfigured } from './lib/supabase.js'
import { getSession, getProfile, signOut, enrollMfa, verifyMfaEnroll, listMfaFactors, updatePassword, isInviteOrRecoveryCallback, clearAuthHash } from './lib/auth.js'
import { store, globalSearch } from './lib/store.js'
import { customerTypeOf, ticketCustomerName, fmtDate } from './lib/tickets.js'
import { normalizeVin } from './lib/csv.js'
import Login, { SetPassword } from './components/Login.jsx'
import CustomerForm from './components/CustomerForm.jsx'
import VehicleForm from './components/VehicleForm.jsx'
import ImportCustomers from './components/ImportCustomers.jsx'
import Quotes from './components/Quotes.jsx'
import Invoices from './components/Invoices.jsx'
import Products from './components/Products.jsx'
import ComboBox from './components/ComboBox.jsx'

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
  const [customerTypeFilter, setCustomerTypeFilter] = useState('') // '' = All, 'Retail', 'Fleet'
  const [vehicleFilter, setVehicleFilter] = useState('')
  const [selectedCustomerId, setSelectedCustomerId] = useState(null)
  const [editingCustomer, setEditingCustomer] = useState(undefined) // undefined = list, null = new, object = edit
  const [editingVehicle, setEditingVehicle] = useState(undefined)
  // Vehicles tab: expanded vehicle (full ticket history) + deep-link to open
  // a specific invoice/quote clicked from a vehicle row.
  const [expandedVehicleId, setExpandedVehicleId] = useState(null)
  const [openInvoiceId, setOpenInvoiceId] = useState(null)
  const [openQuoteId, setOpenQuoteId] = useState(null)
  const [preselectedCustomerId, setPreselectedCustomerId] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [searchFilters, setSearchFilters] = useState({ type: '', status: '', customerId: '', customerType: '', salespersonId: '', from: '', to: '' })
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

  async function runSearchFor(q) {
    const query = String(q || '').trim()
    if (!query) return
    setSearchQuery(query)
    setSearching(true)
    setError('')
    setSearchSuggestOpen(false)
    try {
      setSearchResults(await globalSearch(query, data, searchFilters))
      setTab('search')
    } catch (err) {
      setError(err.message || 'Search failed.')
    } finally {
      setSearching(false)
    }
  }

  async function runSearch(e) {
    e?.preventDefault()
    await runSearchFor(searchQuery)
  }

  // Dashboard search suggestions: customers matching what was typed,
  // starting-with first — click one to search that customer (their
  // quotes, invoices, and vehicles come up with them).
  const [searchSuggestOpen, setSearchSuggestOpen] = useState(false)
  const [searchHi, setSearchHi] = useState(0)
  const searchSuggestions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (q.length < 2) return []
    const scored = data.customers.map((c) => {
      const names = [c.company, ...(data.contacts || []).filter((ct) => ct.customer_id === c.id).map((ct) => ct.name || '')]
      const hay = names.map((n) => (n || '').toLowerCase())
      return { c, starts: hay.some((n) => n.startsWith(q)), contains: hay.some((n) => n.includes(q)) }
    }).filter((s) => s.contains)
    scored.sort((a, b) => (b.starts - a.starts) || a.c.company.localeCompare(b.c.company))
    return scored.map((s) => s.c).slice(0, 6)
  }, [searchQuery, data.customers, data.contacts])

  async function handleDeleteCustomer(id, company) {
    // The edit form already asks "Delete this customer and all of its
    // vehicles?" before calling this, so no second popup.
    try {
      await store.deleteCustomer(id)
      setEditingCustomer(undefined)
      setSelectedCustomerId(null)
      await loadData()
    } catch (err) {
      setError(err.message || 'Delete failed.')
    }
  }

  async function handleDeleteVehicle(id) {
    // The edit form already asks "Delete this vehicle?" before calling
    // this, so no second popup — one deliberate confirm is enough.
    try {
      await store.deleteVehicle(id)
      setEditingVehicle(undefined)
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
    (!customerTypeFilter || customerTypeOf(c) === customerTypeFilter) &&
    (!customerFilter.trim() ||
    c.company.toLowerCase().includes(customerFilter.toLowerCase()))
  )
  const vehicles = data.vehicles.filter((v) => {
    const q = vehicleFilter.trim().toLowerCase()
    if (!q) return true
    return [v.vin_normalized, v.vin, v.fleet_unit, v.bed_size, v.color, v.make, v.model]
      .some((f) => String(f || '').toLowerCase().includes(q))
  })
  const selectedCustomer = data.customers.find((c) => c.id === selectedCustomerId) || null
  const customerName = (id) => id ? data.customers.find((c) => c.id === id)?.company || '—' : 'Walk-in'
  // Dashboard (the sales home page): today's tickets, and the open quotes
  // to chase. Dates use the shop's local day, not UTC — an evening ticket
  // still counts as today.
  const localDay = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const todayStr = localDay(new Date().toISOString())
  const todaysTickets = [
    ...data.quotes.map((t) => ({ type: 'quote', t })),
    ...data.invoices.map((t) => ({ type: 'invoice', t })),
  ]
    .filter(({ t }) => localDay(t.created_at || t.issue_date) === todayStr)
    .sort((a, b) => String(b.t.created_at || '').localeCompare(String(a.t.created_at || '')))
  const chaseQuotes = data.quotes
    .filter((q) => q.status === 'Open' && !q.converted_invoice_id)
    .sort((a, b) => {
      const dueA = a.follow_up_on && a.follow_up_on <= todayStr ? 0 : 1
      const dueB = b.follow_up_on && b.follow_up_on <= todayStr ? 0 : 1
      if (dueA !== dueB) return dueA - dueB
      const da = a.issue_date || (a.created_at || '').slice(0, 10) || ''
      const db = b.issue_date || (b.created_at || '').slice(0, 10) || ''
      return da < db ? -1 : da > db ? 1 : 0
    })

  // Tickets tied to a vehicle: by vehicle_id, or by the VIN in the ticket's
  // snapshot (covers older tickets saved before the link was stored).
  const ticketsForVehicle = (v) => {
    const vin = normalizeVin(v.vin || '')
    const match = (t) => t.vehicle_id === v.id || (vin !== '' && normalizeVin(t.vehicle_snapshot?.vin || '') === vin)
    const newestFirst = (a, b) =>
      String(b.issue_date || b.created_at || '').localeCompare(String(a.issue_date || a.created_at || '')) ||
      String(b.number || '').localeCompare(String(a.number || ''))
    return {
      invoices: data.invoices.filter(match).sort(newestFirst),
      quotes: data.quotes.filter(match).sort(newestFirst),
    }
  }

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
          <div className="combo" style={{ flex: '1 1 520px', maxWidth: 560 }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setSearchSuggestOpen(false) }}>
            <input
              className="searchbox"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSearchSuggestOpen(true); setSearchHi(0) }}
              onFocus={() => { setSearchSuggestOpen(true); setSearchHi(0) }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSearchSuggestOpen(true); setSearchHi((h) => Math.min(h + 1, searchSuggestions.length - 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchHi((h) => Math.max(h - 1, 0)) }
                else if (e.key === 'Enter' && searchSuggestOpen && searchSuggestions[searchHi]) { e.preventDefault(); runSearchFor(searchSuggestions[searchHi].company) }
                else if (e.key === 'Escape') { setSearchSuggestOpen(false) }
              }}
              placeholder="Search customers, VIN (full / last 6 / last 8), fleet/unit, quote, invoice, PO…"
              aria-label="Global search"
              autoComplete="off"
            />
            {searchSuggestOpen && searchQuery.trim().length >= 2 && (
              <div className="combo-list" role="listbox">
                {searchSuggestions.map((c, i) => (
                  <div
                    key={c.id} role="option" aria-selected={i === searchHi}
                    className={`combo-item${i === searchHi ? ' active' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); runSearchFor(c.company) }}
                    onMouseEnter={() => setSearchHi(i)}
                  >
                    <strong>{c.company}</strong> <span className="pill">{customerTypeOf(c)}</span>
                    <span className="muted small"> · {c.payment_terms}{c.tax_exempt ? ' · Tax exempt' : ''}</span>
                  </div>
                ))}
                <div
                  className="combo-item"
                  onMouseDown={(e) => { e.preventDefault(); runSearchFor(searchQuery) }}
                >
                  Search for “{searchQuery.trim()}” — all results
                </div>
              </div>
            )}
          </div>
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
              <div className="tile"><div className="num">{data.quotes.filter((q) => q.status === 'Open' && !q.converted_invoice_id).length}</div><div className="label">Open quotes</div></div>
              <div className="tile"><div className="num">{data.invoices.filter((i) => ['Draft', 'Issued', 'Partially Paid'].includes(i.status)).length}</div><div className="label">Open invoices</div></div>
              {isAdmin && (
                <>
                  <div className="tile"><div className="num">${data.quotes.filter((q) => q.status === 'Open' && !q.converted_invoice_id).reduce((s, q) => s + Number(q.total || 0), 0).toFixed(2)}</div><div className="label">Open quote value</div></div>
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
            <div className="card">
              <div className="row-between">
                <h2 style={{ margin: 0 }}>Today's tickets ({todaysTickets.length})</h2>
                <span className="muted small">{fmtDate(todayStr)}</span>
              </div>
              <p className="muted small">Quotes and invoices created today — newest first. Click Open to pick one up.</p>
              {todaysTickets.length === 0 && <p className="muted">No tickets created today yet.</p>}
              {todaysTickets.map(({ type, t }) => (
                <div key={`${type}-${t.id}`} className="row-between" style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
                  <span><strong>{ticketCustomerName(t, data.customers)}</strong> · {t.number} <span className="pill">{type === 'quote' ? 'Quote' : 'Invoice'}</span> · {t.status} · ${Number(t.total || 0).toFixed(2)}</span>
                  <button className="btn secondary" onClick={() => { if (type === 'quote') { setOpenQuoteId(t.id); setTab('quotes') } else { setOpenInvoiceId(t.id); setTab('invoices') } }}>Open</button>
                </div>
              ))}
            </div>
            <div className="card">
              <div className="row-between">
                <h2 style={{ margin: 0 }}>Open quotes to chase ({chaseQuotes.length})</h2>
                <button className="btn secondary" onClick={() => setTab('quotes')}>All quotes →</button>
              </div>
              <p className="muted small">Follow-up due first, then oldest — the ones waiting longest get chased first.</p>
              {chaseQuotes.length === 0 && <p className="muted">No open quotes. Nothing to chase.</p>}
              {chaseQuotes.slice(0, 8).map((q) => (
                <div key={q.id} className="row-between" style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
                  <span><strong>{ticketCustomerName(q, data.customers)}</strong> · {q.number} · {q.follow_up_on ? `follow up ${fmtDate(q.follow_up_on)}` : `opened ${fmtDate(q.issue_date || (q.created_at || '').slice(0, 10))}`} · ${Number(q.total || 0).toFixed(2)}</span>
                  <button className="btn secondary" onClick={() => { setOpenQuoteId(q.id); setTab('quotes') }}>Open</button>
                </div>
              ))}
              {chaseQuotes.length > 8 && <p className="muted small">{chaseQuotes.length - 8} more open — see All quotes.</p>}
            </div>
          </>
        )}

        {tab === 'search' && searchResults && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Search results for “{searchQuery}”</h2>
            <p className="muted small">Searches inside quotes and invoices too — VIN (full / last 6 / last 8), part numbers, line-item descriptions, numbers, and PO numbers.</p>
            <div className="row filters" style={{ marginBottom: 12 }}>
              <select value={searchFilters.type} onChange={(e) => setSearchFilters({ ...searchFilters, type: e.target.value })}>
                <option value="">Quotes + invoices</option>
                <option value="quote">Quotes only</option>
                <option value="invoice">Invoices only</option>
              </select>
              <select value={searchFilters.status} onChange={(e) => setSearchFilters({ ...searchFilters, status: e.target.value })}>
                <option value="">Any status</option>
                {['Open', 'Lost', 'Issued', 'Partially Paid', 'Paid', 'Void'].map((s) => <option key={s}>{s}</option>)}
              </select>
              <ComboBox
                value={searchFilters.customerId}
                onChange={(v) => setSearchFilters({ ...searchFilters, customerId: v })}
                placeholder="Search customers…"
                ariaLabel="Filter search by customer"
                emptyText="No customers match that — try fewer letters."
                options={[
                  { value: '', label: 'Any customer' },
                  { value: 'walk-in', label: 'Walk-in (no customer record)' },
                  ...data.customers.map((c) => ({ value: c.id, label: c.company, tag: customerTypeOf(c) })),
                ]}
              />
              <select value={searchFilters.customerType} onChange={(e) => setSearchFilters({ ...searchFilters, customerType: e.target.value })}>
                <option value="">Retail + Fleet</option>
                <option value="Retail">Retail only</option>
                <option value="Fleet">Fleet only</option>
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
              <div key={`${r.type}-${r.ticket.id}`} className="row-between" style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
                <span>
                  <strong>{r.ticket.number}</strong> · {r.type === 'quote' ? 'Quote' : 'Invoice'} · {r.ticket.status} · {r.customer} · VIN {r.vin || '—'} · {fmtDate(r.ticket.issue_date || (r.ticket.created_at || '').slice(0, 10))} · {r.salesperson || '—'} · ${Number(r.ticket.total || 0).toFixed(2)}
                  <div className="muted small">Matched: {r.match}</div>
                </span>
                <button className="btn secondary" onClick={() => { if (r.type === 'quote') { setOpenQuoteId(r.ticket.id); setTab('quotes') } else { setOpenInvoiceId(r.ticket.id); setTab('invoices') } }}>Open</button>
              </div>
            ))}
            <h3>Customers ({searchResults.customers.length})</h3>
            {searchResults.customers.length === 0 && <p className="muted">No customers matched.</p>}
            {searchResults.customers.map((c) => (
              <div key={c.id} className="row-between" style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
                <span><strong>{c.company}</strong> <span className="pill">{customerTypeOf(c)}</span> · {c.payment_terms} {c.tax_exempt ? '· Tax exempt' : ''}</span>
                <button className="btn secondary" onClick={() => { setSelectedCustomerId(c.id); setTab('customers') }}>Open</button>
              </div>
            ))}
            <h3>Vehicles ({searchResults.vehicles.length})</h3>
            {searchResults.vehicles.length === 0 && <p className="muted">No vehicles matched. Try the full VIN, or just the last 6 or 8 characters.</p>}
            {searchResults.vehicles.map((v) => (
              <div key={v.id} className="row-between" style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
                <span><strong>{v.year || ''} {v.make || ''} {v.model || ''}{v.bed_size ? ` · ${v.bed_size}` : ''}</strong> · VIN {v.vin || '—'} · Unit {v.fleet_unit || '—'}{v.color ? ` · ${v.color}` : ''} · {customerName(v.customer_id)}</span>
                <button className="btn secondary" onClick={() => { setEditingVehicle(v); setTab('vehicles') }}>Open</button>
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
                isAdmin={isAdmin}
                onSaved={async (saved) => { setEditingCustomer(undefined); setSelectedCustomerId(saved.id); await loadData() }}
                onCancel={() => setEditingCustomer(undefined)}
                onDelete={isAdmin && editingCustomer?.id ? () => handleDeleteCustomer(editingCustomer.id, editingCustomer.company) : undefined}
              />
            ) : selectedCustomer ? (
              <div className="card">
                <div className="row-between">
                  <h2 style={{ margin: 0 }}>{selectedCustomer.company} <span className="pill">{customerTypeOf(selectedCustomer)}</span></h2>
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
                    <span><strong>{v.year || ''} {v.make || ''} {v.model || ''}{v.bed_size ? ` · ${v.bed_size}` : ''}</strong> · VIN {v.vin || '—'} · Unit {v.fleet_unit || '—'}{v.color ? ` · ${v.color}` : ''}</span>
                    <button className="btn secondary" onClick={() => { setEditingVehicle(v); setTab('vehicles') }}>Edit</button>
                  </div>
                ))}
                <h3>History — everything they've bought ({data.quotes.filter((q) => q.customer_id === selectedCustomer.id).length + data.invoices.filter((i) => i.customer_id === selectedCustomer.id).length})</h3>
                {[...data.quotes.filter((q) => q.customer_id === selectedCustomer.id).map((q) => ({ type: 'Quote', t: q })),
                  ...data.invoices.filter((i) => i.customer_id === selectedCustomer.id).map((i) => ({ type: 'Invoice', t: i }))]
                  .sort((a, b) => String(b.t.issue_date || b.t.created_at || '').localeCompare(String(a.t.issue_date || a.t.created_at || '')))
                  .map(({ type, t }) => (
                    <div key={`${type}-${t.id}`} style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
                      <strong>{t.number}</strong> · {type} · {t.status} · {fmtDate(t.issue_date || (t.created_at || '').slice(0, 10))} · ${Number(t.total || 0).toFixed(2)}
                      {t.vehicle_snapshot?.vin ? <span className="muted small"> · VIN {t.vehicle_snapshot.vin}</span> : ''}
                    </div>
                  ))}
                {data.quotes.filter((q) => q.customer_id === selectedCustomer.id).length + data.invoices.filter((i) => i.customer_id === selectedCustomer.id).length === 0 && (
                  <p className="muted">No quotes or invoices for this customer yet.</p>
                )}
                <div className="row" style={{ marginTop: 16 }}>
                  <button className="btn" onClick={() => setEditingCustomer(selectedCustomer)}>Edit customer</button>
                </div>
              </div>
            ) : (
              <div className="card">
                <div className="row-between">
                  <h2 style={{ margin: 0 }}>Customers ({customers.length})</h2>
                  <button className="btn" onClick={() => setEditingCustomer(null)}>+ New customer</button>
                </div>
                <input value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} placeholder="Filter by company name…" style={{ marginTop: 12 }} />
                <div className="row" style={{ marginTop: 12 }} role="group" aria-label="Customer type filter">
                  <button type="button" className={customerTypeFilter === '' ? 'btn' : 'btn secondary'} onClick={() => setCustomerTypeFilter('')}>All ({data.customers.length})</button>
                  <button type="button" className={customerTypeFilter === 'Retail' ? 'btn' : 'btn secondary'} onClick={() => setCustomerTypeFilter('Retail')}>Retail ({data.customers.filter((c) => customerTypeOf(c) === 'Retail').length})</button>
                  <button type="button" className={customerTypeFilter === 'Fleet' ? 'btn' : 'btn secondary'} onClick={() => setCustomerTypeFilter('Fleet')}>Fleet ({data.customers.filter((c) => customerTypeOf(c) === 'Fleet').length})</button>
                </div>
                <table>
                  <thead><tr><th>Company</th><th>Type</th><th>Terms</th><th>Tax</th><th>Vehicles</th><th></th></tr></thead>
                  <tbody>
                    {customers.map((c) => (
                      <tr key={c.id}>
                        <td><strong>{c.company}</strong></td>
                        <td><span className="pill">{customerTypeOf(c)}</span></td>
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
                isAdmin={isAdmin}
                onSaved={async () => { setEditingVehicle(undefined); setPreselectedCustomerId(''); await loadData() }}
                onCancel={() => { setEditingVehicle(undefined); setPreselectedCustomerId('') }}
                onDelete={isAdmin && editingVehicle?.id ? () => handleDeleteVehicle(editingVehicle.id) : undefined}
              />
            ) : (
              <div className="card">
                <div className="row-between">
                  <h2 style={{ margin: 0 }}>Vehicles ({vehicles.length})</h2>
                </div>
                <p className="muted">Vehicles are created automatically from quotes and invoices — enter the VIN and Year/Make/Model on the ticket and it shows up here. Use Edit below to correct a typo on a vehicle record.</p>
                <input value={vehicleFilter} onChange={(e) => setVehicleFilter(e.target.value)} placeholder="Filter by VIN, fleet/unit, make…" style={{ marginTop: 12 }} />
                <table>
                  <thead><tr><th>Vehicle</th><th>VIN</th><th>Fleet / unit</th><th>Customer</th><th>Invoices</th><th></th></tr></thead>
                  <tbody>
                    {vehicles.map((v) => {
                      const { invoices: vInvoices, quotes: vQuotes } = ticketsForVehicle(v)
                      const shown = vInvoices.slice(0, 3)
                      const expanded = expandedVehicleId === v.id
                      const openInvoice = (inv) => { setOpenInvoiceId(inv.id); setTab('invoices') }
                      const openQuote = (q) => { setOpenQuoteId(q.id); setTab('quotes') }
                      return (
                        <Fragment key={v.id}>
                          <tr>
                            <td>{v.year || ''} {v.make || ''} {v.model || ''}{v.bed_size ? ` · ${v.bed_size}` : ''}</td>
                            <td>{v.vin || '—'}</td>
                            <td>{v.fleet_unit ? `Unit ${v.fleet_unit}` : '—'}{v.color ? ` · ${v.color}` : ''}</td>
                            <td>{customerName(v.customer_id)}</td>
                            <td>
                              {vInvoices.length === 0 ? (
                                <span className="muted">—</span>
                              ) : (
                                <>
                                  {shown.map((inv, i) => (
                                    <span key={inv.id}>
                                      {i > 0 ? ', ' : ''}
                                      <button type="button" onClick={() => openInvoice(inv)} style={{ background: 'none', border: 0, padding: 0, color: 'var(--orange-dark)', textDecoration: 'underline', font: 'inherit', cursor: 'pointer' }}>{inv.number}</button>
                                    </span>
                                  ))}
                                  {vInvoices.length > 3 && (
                                    <button type="button" className="btn secondary" style={{ marginLeft: 6 }} onClick={() => setExpandedVehicleId(v.id)}>+{vInvoices.length - 3} more</button>
                                  )}
                                </>
                              )}
                            </td>
                            <td>
                              <button className="btn secondary" onClick={() => setExpandedVehicleId(expanded ? null : v.id)}>{expanded ? 'Hide history' : 'History'}</button>{' '}
                              <button className="btn secondary" onClick={() => setEditingVehicle(v)}>Edit</button>
                            </td>
                          </tr>
                          {expanded && (
                            <tr>
                              <td colSpan={6} style={{ background: '#fafafa' }}>
                                <h3 style={{ marginTop: 0 }}>History — {v.year || ''} {v.make || ''} {v.model || ''} · VIN {v.vin || '—'}</h3>
                                <h4 style={{ margin: '8px 0 4px' }}>Invoices ({vInvoices.length})</h4>
                                {vInvoices.length === 0 && <p className="muted">No invoices tied to this vehicle yet.</p>}
                                {vInvoices.map((inv) => (
                                  <div key={inv.id} style={{ borderTop: '1px solid #eee', padding: '6px 0' }}>
                                    <button type="button" onClick={() => openInvoice(inv)} style={{ background: 'none', border: 0, padding: 0, color: 'var(--orange-dark)', textDecoration: 'underline', font: 'inherit', fontWeight: 700, cursor: 'pointer' }}>{inv.number}</button>
                                    {' '}· {inv.status} · {fmtDate(inv.issue_date || (inv.created_at || '').slice(0, 10))} · {ticketCustomerName(inv, data.customers)} · ${Number(inv.total || 0).toFixed(2)}
                                  </div>
                                ))}
                                <h4 style={{ margin: '12px 0 4px' }}>Quotes ({vQuotes.length})</h4>
                                {vQuotes.length === 0 && <p className="muted">No quotes tied to this vehicle yet.</p>}
                                {vQuotes.map((q) => (
                                  <div key={q.id} style={{ borderTop: '1px solid #eee', padding: '6px 0' }}>
                                    <button type="button" onClick={() => openQuote(q)} style={{ background: 'none', border: 0, padding: 0, color: 'var(--orange-dark)', textDecoration: 'underline', font: 'inherit', fontWeight: 700, cursor: 'pointer' }}>{q.number}</button>
                                    {' '}· {q.status} · {fmtDate(q.issue_date || (q.created_at || '').slice(0, 10))} · {ticketCustomerName(q, data.customers)} · ${Number(q.total || 0).toFixed(2)}
                                  </div>
                                ))}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
                {vehicles.length === 0 && <p className="muted">No vehicles yet — create a quote or invoice and enter the VIN and Year/Make/Model on the ticket, and the vehicle will appear here.</p>}
              </div>
            )}
          </>
        )}

        {tab === 'quotes' && (
          <Quotes data={data} user={user} profile={profile} isAdmin={isAdmin} settings={data.settings} onReload={loadData} onError={setError} openQuoteId={openQuoteId} onOpened={() => setOpenQuoteId(null)} onOpenInvoice={(inv) => { setOpenInvoiceId(inv.id); setTab('invoices') }} />
        )}
        {tab === 'invoices' && (
          <Invoices data={data} user={user} profile={profile} isAdmin={isAdmin} settings={data.settings} onReload={loadData} onError={setError} openInvoiceId={openInvoiceId} onOpened={() => setOpenInvoiceId(null)} />
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
              Quote validity: {data.settings?.quote_validity_days || '—'} days ·<br />
              Quotes and invoices have separate numbering — quotes QT-A1001…, invoices INV-1001… — so a quote and an invoice can share the same numeric part and still be different numbers.
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
