// Customers page CRM helpers (Nov 27, 2026): the Customers page works
// like a small CRM with two views — Companies and People. Contacts
// already live in their own table (name, title, phone, email,
// is_primary, customer_id), so no data change was needed — these pure
// helpers just shape what the page shows.
//
// Money rule: the per-company open balance is Admin-only. Sales see the
// open-invoice COUNT only, never dollars — the component enforces that;
// openInvoicesSummary returns both and the caller shows what the role
// allows.

import { phoneMatches } from './phones.js'

// --- View preference (Companies | People), remembered per user ---
// Same per-user localStorage map shape as the collapse state
// (po_ops_collapsed_v1 in collapse.js): one key, keyed by user id, so
// Jeff staying in People view does not change Bill's view. Only the
// non-default ('people') is stored; 'companies' is the default and is
// stored as absence, so the map only ever holds a real preference.
export const LS_CUSTOMERS_VIEW = 'po_ops_customers_view_v1'
export const CUSTOMERS_VIEW_FALLBACK_USER = 'shared'

export function readCustomersViewMap() {
  try {
    const raw = localStorage.getItem(LS_CUSTOMERS_VIEW)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function writeCustomersViewMap(map) {
  try {
    localStorage.setItem(LS_CUSTOMERS_VIEW, JSON.stringify(map || {}))
  } catch {
    // Private mode / storage full / unavailable — the view just won't
    // persist for this session. Never throw on a UI preference.
  }
}

export function getCustomersView(map, userId) {
  const v = (map || {})[userId || CUSTOMERS_VIEW_FALLBACK_USER]
  return v === 'people' ? 'people' : 'companies'
}

export function withCustomersView(map, userId, view) {
  const key = userId || CUSTOMERS_VIEW_FALLBACK_USER
  const next = { ...(map || {}) }
  if (view === 'people') next[key] = 'people'
  else delete next[key]
  return next
}

// Primary contact: the is_primary contact, else the first contact listed
// for the company; null when the company has no contacts.
export function primaryContact(contacts) {
  const list = (contacts || []).filter(Boolean)
  return list.find((c) => c.is_primary) || list[0] || null
}

// --- Alphabetical sorting (Nov 27) ---
// Both views sort A–Z by default; clicking the Company / Name column
// header flips to Z–A. localeCompare orders by the letters first (so
// 'apple' sorts before 'Banana') and only uses case to break an exact
// letter tie. A missing name sorts first in A–Z and last in Z–A.
export function alphaCompare(a, b) {
  return String(a || '').localeCompare(String(b || ''))
}

export function sortCompaniesAlpha(companies, dir = 'asc') {
  const sorted = [...(companies || [])].sort((a, b) => alphaCompare(a.company, b.company))
  return dir === 'desc' ? sorted.reverse() : sorted
}

export function sortPeopleAlpha(rows, dir = 'asc', key = 'name') {
  const sorted = [...(rows || [])].sort((a, b) =>
    key === 'company'
      ? alphaCompare(a.company?.company, b.company?.company) || alphaCompare(a.contact?.name, b.contact?.name)
      : alphaCompare(a.contact?.name, b.contact?.name) || alphaCompare(a.company?.company, b.company?.company))
  return dir === 'desc' ? sorted.reverse() : sorted
}

// One row per person, A–Z by name. A contact whose company isn't in the
// list is skipped — a People row must be able to open its company.
export function peopleRows(customers, contacts) {
  const byId = new Map((customers || []).map((c) => [c.id, c]))
  return sortPeopleAlpha((contacts || [])
    .filter((ct) => ct && byId.has(ct.customer_id))
    .map((ct) => ({ contact: ct, company: byId.get(ct.customer_id) })))
}

// People filter: name, title, company, email (plain text), phone
// (digits — typing 314892 finds (314) 892-0032).
export function peopleMatchesFilter(row, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return true
  const { contact, company } = row
  if ([contact.name, contact.title, company.company, contact.email]
    .some((f) => String(f || '').toLowerCase().includes(q))) return true
  return phoneMatches(query, contact.phone)
}

// Company filter: company name, any contact's name, or any contact's
// phone digits.
export function companyMatchesFilter(company, companyContacts, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return true
  if (String(company.company || '').toLowerCase().includes(q)) return true
  return (companyContacts || []).some((ct) =>
    String(ct.name || '').toLowerCase().includes(q) || phoneMatches(query, ct.phone))
}

// Open invoices for one company: Draft / Issued / Billed / Partially Paid
// count, plus the open balance (balance_due, falling back to total — the
// same fallback the Invoices list uses). Paid and Void are excluded.
export const OPEN_INVOICE_STATUSES = ['Draft', 'Issued', 'Billed', 'Partially Paid']

export function openInvoicesSummary(invoices, customerId) {
  let count = 0
  let balance = 0
  for (const inv of invoices || []) {
    if (inv.customer_id !== customerId || !OPEN_INVOICE_STATUSES.includes(inv.status)) continue
    count += 1
    balance += Number(inv.balance_due ?? inv.total ?? 0)
  }
  return { count, balance }
}
