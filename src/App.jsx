import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase, supabaseConfigured } from './lib/supabase.js'
import { getSession, getProfile, signOut, enrollMfa, verifyMfaEnroll, listMfaFactors, updatePassword, isInviteOrRecoveryCallback, clearAuthHash } from './lib/auth.js'
import { store, globalSearch } from './lib/store.js'
import { customerTypeOf, ticketCustomerName, fmtDate, invoiceFromProduct, salespersonNamesOf } from './lib/tickets.js'
import { normalizeVin } from './lib/csv.js'
import { formatPhone } from './lib/phones.js'
import Login, { SetPassword } from './components/Login.jsx'
import CustomerForm from './components/CustomerForm.jsx'
import CustomerNotes from './components/CustomerNotes.jsx'
import CustomerPhotos from './components/CustomerPhotos.jsx'
import VehicleForm from './components/VehicleForm.jsx'
import ImportCustomers from './components/ImportCustomers.jsx'
import Quotes from './components/Quotes.jsx'
import Invoices from './components/Invoices.jsx'
import Products from './components/Products.jsx'
import ComboBox from './components/ComboBox.jsx'
import AdminMetrics from './components/AdminMetrics.jsx'
import SalesDashboard from './components/SalesDashboard.jsx'

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'customers', label: 'Customers' },
  { id: 'vehicles', label: 'Vehicles' },
  { id: 'quotes', label: 'Quotes' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'products', label: 'Products & services' },
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
  // Customer profile: each history section (Invoices / Vehicles / Quotes)
  // shows the most recent 5, expanding to the full list independently.
  const [showAllProfileInvoices, setShowAllProfileInvoices] = useState(false)
  const [showAllProfileVehicles, setShowAllProfileVehicles] = useState(false)
  const [showAllProfileQuotes, setShowAllProfileQuotes] = useState(false)
  const [editingCustomer, setEditingCustomer] = useState(undefined) // undefined = list, null = new, object = edit
  const [editingVehicle, setEditingVehicle] = useState(undefined)
  // Vehicles tab: expanded vehicle (full ticket history) + deep-link to open
  // a specific invoice/quote clicked from a vehicle row.
  const [expandedVehicleId, setExpandedVehicleId] = useState(null)
  const [openInvoiceId, setOpenInvoiceId] = useState(null)
  const [openQuoteId, setOpenQuoteId] = useState(null)
  // How a deep-linked ticket opens: 'view' (the print version — the
  // default) or 'edit' (the form). Plus the tab we came from, so closing
  // the print view takes us back there instead of dumping us on the list.
  const [openMode, setOpenMode] = useState('view')
  const [returnTab, setReturnTab] = useState(null)
  // Bumped by the dashboard "+ New invoice" button; Invoices opens a blank
  // new-invoice form whenever this changes.
  const [newInvoiceSignal, setNewInvoiceSignal] = useState(0)
  // Added from the Products catalog: a new Draft invoice prefilled with
  // one line from the product/service. Consumed by the Invoices tab.
  const [productInvoicePrefill, setProductInvoicePrefill] = useState(null)
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

  // Switching to another customer collapses all three history sections.
  // NOTE: this effect must live above the early returns below (Loading /
  // password setup / Login). A hook placed after an early return makes
  // React throw "Rendered more hooks than during the previous render"
  // (minified error #310) on the first render after sign-in, which
  // unmounts the whole app to a blank white page. That is what broke
  // sign-in on 2026-11-20.
  useEffect(() => {
    setShowAllProfileInvoices(false)
    setShowAllProfileVehicles(false)
    setShowAllProfileQuotes(false)
  }, [selectedCustomerId])

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

  // Opening a ticket from search, the dashboard, or a vehicle row:
  // View shows the print version first (the default); Edit opens the
  // form. The tab we came from is remembered so closing the print view
  // takes us back there. The return is only set for View opens — an Edit
  // open lands on the list when the form closes, as before.
  function openTicket(type, id, mode = 'view') {
    if (mode === 'view') setReturnTab(tab)
    setOpenMode(mode)
    if (type === 'quote') { setOpenQuoteId(id); setTab('quotes') }
    else { setOpenInvoiceId(id); setTab('invoices') }
  }
  // The print view closed: go back where the ticket was opened from, if
  // it was opened from somewhere else. Consumed once.
  function handleViewClosed() {
    if (returnTab) { const t = returnTab; setReturnTab(null); setTab(t) }
  }
  // The user left the view flow (e.g. Edit from the print view, or a nav
  // click) — the stored return is void, so a later View from the list
  // doesn't yank them back to an old tab.
  function clearReturnTab() {
    if (returnTab) setReturnTab(null)
  }

  async function runSearchFor(q) {
    const query = String(q || '').trim()
    if (!query) return
    setSearchQuery(query)
    setSearching(true)
    setError('')
    setSearchSuggestOpen(false)
    setReturnTab(null)
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
  // Profile history, newest first — Invoices and Quotes by issue date,
  // Vehicles by when they were added. The profile shows the most recent
  // 5 of each; the rest are one click away (see the expand buttons).
  const byNewestTicket = (a, b) => String(b.issue_date || b.created_at || '').localeCompare(String(a.issue_date || a.created_at || ''))
  const profileInvoices = selectedCustomer ? data.invoices.filter((i) => i.customer_id === selectedCustomer.id).sort(byNewestTicket) : []
  const profileQuotes = selectedCustomer ? data.quotes.filter((q) => q.customer_id === selectedCustomer.id).sort(byNewestTicket) : []
  const profileVehicles = selectedCustomer ? data.vehicles.filter((v) => v.customer_id === selectedCustomer.id).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))) : []
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
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => { setTab(t.id); setEditingCustomer(undefined); setEditingVehicle(undefined); setReturnTab(null) }}>
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
        <form onSubmit={runSearch} className="row global-search" style={{ marginBottom: 16 }}>
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
            <div className="row-between">
              <h1 style={{ margin: 0 }}>Dashboard</h1>
              <button className="btn" onClick={() => { setNewInvoiceSignal((n) => n + 1); setTab('invoices') }}>+ New invoice</button>
            </div>
            <p className="muted">Quotes and invoices are live. Receivables, payables, and reports arrive in Phases 3–4.</p>
            <div className="stat-strip">
              <button type="button" className="stat" onClick={() => setTab('customers')} title="Open Customers"><span className="num">{data.customers.length}</span><span className="label">Customers</span></button>
              <button type="button" className="stat" onClick={() => setTab('vehicles')} title="Open Vehicles"><span className="num">{data.vehicles.length}</span><span className="label">Vehicles</span></button>
              <button type="button" className="stat" onClick={() => setTab('quotes')} title="Open Quotes"><span className="num">{data.quotes.filter((q) => q.status === 'Open' && !q.converted_invoice_id).length}</span><span className="label">Open quotes</span></button>
              <button type="button" className="stat" onClick={() => setTab('invoices')} title="Open Invoices"><span className="num">{data.invoices.filter((i) => ['Draft', 'Issued', 'Partially Paid'].includes(i.status)).length}</span><span className="label">Open invoices</span></button>
              {isAdmin && (
                <>
                  <button type="button" className="stat" onClick={() => setTab('quotes')} title="Open Quotes"><span className="num">${data.quotes.filter((q) => q.status === 'Open' && !q.converted_invoice_id).reduce((s, q) => s + Number(q.total || 0), 0).toFixed(2)}</span><span className="label">Open quote value</span></button>
                  <button type="button" className="stat" onClick={() => setTab('invoices')} title="Open Invoices"><span className="num">${data.invoices.filter((i) => ['Draft', 'Issued', 'Partially Paid'].includes(i.status)).reduce((s, i) => s + Number(i.balance_due ?? i.total ?? 0), 0).toFixed(2)}</span><span className="label">Open invoice balance</span></button>
                </>
              )}
            </div>
            {data.settings && (
              <p className="muted small">
                Tax rate: {(Number(data.settings.tax_rate) * 100).toFixed(2)}% · Terms: {data.settings.default_payment_terms} · Quote validity: {data.settings.quote_validity_days} days
              </p>
            )}
            <p className="muted small">
              Sales users see no revenue, margin, or report data anywhere in this system — those areas are Admin-only and blocked in the database. Product costs are shared with everyone (Nov 19) so any salesman can price a service.
            </p>
            <div className="card">
              <div className="row-between">
                <h2 style={{ margin: 0 }}>Today's tickets ({todaysTickets.length})</h2>
                <span className="muted small">{fmtDate(todayStr)}</span>
              </div>
              <p className="muted small">Quotes and invoices created today — newest first. View shows the print version; Edit opens the form.</p>
              {todaysTickets.length === 0 && <p className="muted">No tickets created today yet.</p>}
              {todaysTickets.map(({ type, t }) => (
                <div key={`${type}-${t.id}`} className="row-between" style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
                  <span><strong>{ticketCustomerName(t, data.customers)}</strong> · {t.number} <span className="pill">{type === 'quote' ? 'Quote' : 'Invoice'}</span> · {t.status} · {salespersonNamesOf(t, data.profiles)} · ${Number(t.total || 0).toFixed(2)}</span>
                  <span>
                    <button className="btn small" onClick={() => openTicket(type, t.id, 'view')}>View</button>{' '}
                    <button className="btn secondary small" onClick={() => openTicket(type, t.id, 'edit')}>Edit</button>
                  </span>
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
                  <span><strong>{ticketCustomerName(q, data.customers)}</strong> · {q.number} · {salespersonNamesOf(q, data.profiles)} · {q.follow_up_on ? `follow up ${fmtDate(q.follow_up_on)}` : `opened ${fmtDate(q.issue_date || (q.created_at || '').slice(0, 10))}`} · ${Number(q.total || 0).toFixed(2)}</span>
                  <span>
                    <button className="btn small" onClick={() => openTicket('quote', q.id, 'view')}>View</button>{' '}
                    <button className="btn secondary small" onClick={() => openTicket('quote', q.id, 'edit')}>Edit</button>
                  </span>
                </div>
              ))}
              {chaseQuotes.length > 8 && <p className="muted small">{chaseQuotes.length - 8} more open — see All quotes.</p>}
            </div>
            <SalesDashboard data={data} today={todayStr} onOpenTicket={openTicket} onOpenCustomer={(id) => { setSelectedCustomerId(id); setTab('customers') }} onOpenProducts={() => setTab('products')} />
            {isAdmin && (
              <AdminMetrics data={data} today={todayStr} onOpenCustomer={(id) => { setSelectedCustomerId(id); setTab('customers') }} />
            )}
          </>
        )}

        {tab === 'search' && searchResults && (
          <>
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
          </div>
          <div className="result-group">
            <h3>Tickets ({(searchResults.tickets || []).length})</h3>
            {(searchResults.tickets || []).length === 0 && <p className="muted">No quotes or invoices matched.</p>}
            {(searchResults.tickets || []).map((r) => (
              <div key={`${r.type}-${r.ticket.id}`} className="result-row">
                <div>
                  <div className="result-title"><strong>{r.ticket.number}</strong> <span className="pill">{r.type === 'quote' ? 'Quote' : 'Invoice'}</span> <span className="pill">{r.ticket.status}</span></div>
                  <div className="result-meta">{r.customer} · VIN {r.vin || '—'} · {fmtDate(r.ticket.issue_date || (r.ticket.created_at || '').slice(0, 10))} · {r.salesperson || '—'}</div>
                  <div className="muted small">Matched: {r.match}</div>
                </div>
                <div className="result-side">
                  <strong>${Number(r.ticket.total || 0).toFixed(2)}</strong>
                  <span>
                    <button className="btn small" onClick={() => openTicket(r.type, r.ticket.id, 'view')}>View</button>{' '}
                    <button className="btn secondary small" onClick={() => openTicket(r.type, r.ticket.id, 'edit')}>Edit</button>
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="result-group">
            <h3>Customers ({searchResults.customers.length})</h3>
            {searchResults.customers.length === 0 && <p className="muted">No customers matched.</p>}
            {searchResults.customers.map((c) => (
              <div key={c.id} className="result-row">
                <div>
                  <div className="result-title"><strong>{c.company}</strong> <span className="pill">{customerTypeOf(c)}</span></div>
                  <div className="result-meta">{c.payment_terms}{c.tax_exempt ? ' · Tax exempt' : ''}</div>
                </div>
                <button className="btn secondary" onClick={() => { setSelectedCustomerId(c.id); setTab('customers') }}>Open</button>
              </div>
            ))}
          </div>
          <div className="result-group">
            <h3>Vehicles ({searchResults.vehicles.length})</h3>
            {searchResults.vehicles.length === 0 && <p className="muted">No vehicles matched. Try the full VIN, or just the last 6 or 8 characters.</p>}
            {searchResults.vehicles.map((v) => (
              <div key={v.id} className="result-row">
                <div>
                  <div className="result-title"><strong>{v.year || ''} {v.make || ''} {v.model || ''}{v.bed_size ? ` · ${v.bed_size}` : ''}</strong>{v.fleet_unit ? <span className="pill">Unit {v.fleet_unit}</span> : ''}{v.color ? <span className="pill">{v.color}</span> : ''}</div>
                  <div className="result-meta">VIN {v.vin || '—'} · {customerName(v.customer_id)}</div>
                </div>
                <button className="btn secondary" onClick={() => { setEditingVehicle(v); setTab('vehicles') }}>Open</button>
              </div>
            ))}
          </div>
          </>
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
              <>
              <div className="profile-wrap">
                {selectedCustomer.flag && (
                  <div className="flag-banner">⚠ Flag: <strong>{selectedCustomer.flag}</strong>{selectedCustomer.flag_note ? ` — ${selectedCustomer.flag_note}` : ''}</div>
                )}
                <div className="ticket-section profile-header">
                  <div className="row-between">
                    <h2 style={{ margin: 0, fontSize: 20 }}>{selectedCustomer.company} <span className="pill">{customerTypeOf(selectedCustomer)}</span></h2>
                    <button className="btn secondary" onClick={() => setSelectedCustomerId(null)}>← All customers</button>
                  </div>
                  <p className="muted" style={{ marginBottom: 4 }}>
                    Terms: {selectedCustomer.payment_terms} · {selectedCustomer.tax_exempt ? 'Tax exempt' : 'Taxable'}
                    {selectedCustomer.tax_exempt_doc_note ? ` · ${selectedCustomer.tax_exempt_doc_note}` : ''}
                    {selectedCustomer.po_requirements ? ` · PO: ${selectedCustomer.po_requirements}` : ''}
                  </p>
                  <div className="profile-header-grid">
                    <div>
                      <h3>Contacts</h3>
                      {data.contacts.filter((c) => c.customer_id === selectedCustomer.id).map((c) => (
                        <div key={c.id}>{c.name} {c.title ? `(${c.title})` : ''} · {formatPhone(c.phone) || '—'} · {c.email || '—'}</div>
                      ))}
                      {data.contacts.filter((c) => c.customer_id === selectedCustomer.id).length === 0 && <p className="muted">No contacts yet.</p>}
                    </div>
                    <div>
                      <h3>Addresses</h3>
                      {data.addresses.filter((a) => a.customer_id === selectedCustomer.id).map((a) => (
                        <div key={a.id}>{a.address_type}: {a.line1 || ''} {a.city || ''} {a.state || ''} {a.zip || ''}</div>
                      ))}
                      {data.addresses.filter((a) => a.customer_id === selectedCustomer.id).length === 0 && <p className="muted">No addresses yet.</p>}
                    </div>
                  </div>
                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="btn" onClick={() => setEditingCustomer(selectedCustomer)}>Edit customer</button>
                  </div>
                </div>
                <div className="profile-duo">
                  <CustomerNotes key={selectedCustomer.id} customerId={selectedCustomer.id} userId={user?.id} profiles={data.profiles} />
                  <CustomerPhotos key={selectedCustomer.id} customerId={selectedCustomer.id} userId={user?.id} />
                </div>
                <div className="ticket-section">
                  <h3>Invoices ({profileInvoices.length})</h3>
                  {(showAllProfileInvoices ? profileInvoices : profileInvoices.slice(0, 5)).map((t) => (
                    <div key={t.id} className="row-between" style={{ borderTop: '1px solid #f0e8de', padding: '8px 0' }}>
                      <span><strong>{t.number}</strong> · {t.status} · {salespersonNamesOf(t, data.profiles)} · {fmtDate(t.issue_date || (t.created_at || '').slice(0, 10))} · ${Number(t.total || 0).toFixed(2)}
                      {t.vehicle_snapshot?.vin ? <span className="muted small"> · VIN {t.vehicle_snapshot.vin}</span> : ''}</span>
                      <span>
                        <button className="btn small" onClick={() => openTicket('invoice', t.id, 'view')}>View</button>{' '}
                        <button className="btn secondary small" onClick={() => openTicket('invoice', t.id, 'edit')}>Edit</button>
                      </span>
                    </div>
                  ))}
                  {profileInvoices.length === 0 && <p className="muted">No invoices for this customer yet.</p>}
                  {profileInvoices.length > 5 && (
                    <div className="row" style={{ marginTop: 10 }}>
                      <button className="btn secondary small" onClick={() => setShowAllProfileInvoices(!showAllProfileInvoices)}>
                        {showAllProfileInvoices ? 'Show less' : `View all invoices (${profileInvoices.length})`}
                      </button>
                    </div>
                  )}
                </div>
                <div className="ticket-section">
                  <h3>Vehicles ({profileVehicles.length})</h3>
                  {(showAllProfileVehicles ? profileVehicles : profileVehicles.slice(0, 5)).map((v) => (
                    <div key={v.id} className="row-between" style={{ borderTop: '1px solid #f0e8de', padding: '8px 0' }}>
                      <span><strong>{v.year || ''} {v.make || ''} {v.model || ''}{v.bed_size ? ` · ${v.bed_size}` : ''}</strong> · VIN {v.vin || '—'} · Unit {v.fleet_unit || '—'}{v.color ? ` · ${v.color}` : ''}</span>
                      <button className="btn secondary small" onClick={() => { setEditingVehicle(v); setTab('vehicles') }}>Edit</button>
                    </div>
                  ))}
                  {profileVehicles.length === 0 && <p className="muted">No vehicles for this customer yet.</p>}
                  {profileVehicles.length > 5 && (
                    <div className="row" style={{ marginTop: 10 }}>
                      <button className="btn secondary small" onClick={() => setShowAllProfileVehicles(!showAllProfileVehicles)}>
                        {showAllProfileVehicles ? 'Show less' : `View all vehicles (${profileVehicles.length})`}
                      </button>
                    </div>
                  )}
                </div>
                <div className="ticket-section">
                  <h3>Quotes ({profileQuotes.length})</h3>
                  {(showAllProfileQuotes ? profileQuotes : profileQuotes.slice(0, 5)).map((t) => (
                    <div key={t.id} className="row-between" style={{ borderTop: '1px solid #f0e8de', padding: '8px 0' }}>
                      <span><strong>{t.number}</strong> · {t.status} · {salespersonNamesOf(t, data.profiles)} · {fmtDate(t.issue_date || (t.created_at || '').slice(0, 10))} · ${Number(t.total || 0).toFixed(2)}
                      {t.vehicle_snapshot?.vin ? <span className="muted small"> · VIN {t.vehicle_snapshot.vin}</span> : ''}</span>
                      <span>
                        <button className="btn small" onClick={() => openTicket('quote', t.id, 'view')}>View</button>{' '}
                        <button className="btn secondary small" onClick={() => openTicket('quote', t.id, 'edit')}>Edit</button>
                      </span>
                    </div>
                  ))}
                  {profileQuotes.length === 0 && <p className="muted">No quotes for this customer yet.</p>}
                  {profileQuotes.length > 5 && (
                    <div className="row" style={{ marginTop: 10 }}>
                      <button className="btn secondary small" onClick={() => setShowAllProfileQuotes(!showAllProfileQuotes)}>
                        {showAllProfileQuotes ? 'Show less' : `View all quotes (${profileQuotes.length})`}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              </>
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
                        <td><strong>{c.company}</strong>{c.flag ? <span className="flag-pill" style={{ marginLeft: 6 }}>{c.flag}</span> : ''}</td>
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
                      const openInvoice = (inv) => openTicket('invoice', inv.id, 'view')
                      const openQuote = (q) => openTicket('quote', q.id, 'view')
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
          <Quotes data={data} user={user} profile={profile} isAdmin={isAdmin} settings={data.settings} onReload={loadData} onError={setError} openQuoteId={openQuoteId} openMode={openMode} onOpened={() => setOpenQuoteId(null)} onOpenInvoice={(inv) => openTicket('invoice', inv.id, 'view')} onViewClosed={handleViewClosed} onClearReturn={clearReturnTab} />
        )}
        {tab === 'invoices' && (
          <Invoices data={data} user={user} profile={profile} isAdmin={isAdmin} settings={data.settings} onReload={loadData} onError={setError} openInvoiceId={openInvoiceId} openMode={openMode} onOpened={() => setOpenInvoiceId(null)} productPrefill={productInvoicePrefill} onProductPrefillConsumed={() => setProductInvoicePrefill(null)} onViewClosed={handleViewClosed} onClearReturn={clearReturnTab} createNewSignal={newInvoiceSignal} onCreateNewConsumed={() => setNewInvoiceSignal(0)} />
        )}
        {tab === 'products' && (
          <Products data={data} user={user} isAdmin={isAdmin} onReload={loadData} onError={setError} onAddToInvoice={(p) => { setProductInvoicePrefill(invoiceFromProduct(p, user?.id, data.settings)); setTab('invoices') }} />
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
