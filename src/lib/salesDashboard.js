// Sales dashboard aggregations (Nov 24) — pure functions over the
// already-loaded data. No money anywhere in this file: only counts,
// units, and dates. The Admin-only numbers live in adminMetrics.js;
// this module is for sections everyone sees.
import { addDays } from './tickets.js'
import { normalizeMake } from './adminMetrics.js'

const SOLD_STATUSES = ['Issued', 'Partially Paid', 'Paid']

// Open quotes whose follow-up date is today or earlier, most overdue first.
export function followUpsDue(quotes, today) {
  return (quotes || [])
    .filter((q) => q.status === 'Open' && !q.converted_invoice_id && q.follow_up_on && q.follow_up_on <= today)
    .sort((a, b) => String(a.follow_up_on).localeCompare(String(b.follow_up_on)))
}

// Open quotes expiring within 7 days, including ones already past
// expiry, soonest expiry first.
export function expiringQuotes(quotes, today) {
  const horizon = addDays(today, 7)
  return (quotes || [])
    .filter((q) => q.status === 'Open' && !q.converted_invoice_id && q.expires_on && q.expires_on <= horizon)
    .sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on)))
}

// Draft invoices, newest first, capped at 8.
export function draftInvoices(invoices) {
  return (invoices || [])
    .filter((i) => i.status === 'Draft')
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, 8)
}

// Display units: whole numbers without a decimal point, fractions trimmed.
export function fmtUnits(n) {
  const v = Number(n) || 0
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
}

// The 5 most-used catalog products by total units across invoice lines
// on sold invoices (Issued / Partially Paid / Paid — Void and Draft
// lines are not sales yet). Lines match a catalog product by part
// number (trimmed, case-insensitive); lines with no catalog match group
// by their description text.
export function topProducts(invoices, invoiceLines, products) {
  const soldIds = new Set(
    (invoices || []).filter((i) => SOLD_STATUSES.includes(i.status)).map((i) => i.id)
  )
  const byPart = new Map()
  for (const p of products || []) {
    const key = String(p.part_number || '').trim().toUpperCase()
    if (key && !byPart.has(key)) byPart.set(key, p)
  }
  const groups = new Map()
  for (const line of invoiceLines || []) {
    if (!soldIds.has(line.invoice_id)) continue
    const partKey = String(line.part_number || '').trim().toUpperCase()
    const matched = partKey ? byPart.get(partKey) : null
    const name = matched ? matched.name : (String(line.description || '').trim() || 'Untitled line')
    const gkey = matched ? `p:${matched.id}` : `d:${name.toLowerCase()}`
    let g = groups.get(gkey)
    if (!g) { g = { key: gkey, name, units: 0, tickets: new Set() }; groups.set(gkey, g) }
    g.units += Number(line.quantity) || 0
    g.tickets.add(line.invoice_id)
  }
  return [...groups.values()]
    .map((g) => ({ key: g.key, name: g.name, units: g.units, tickets: g.tickets.size }))
    .sort((a, b) => b.units - a.units || String(a.name).localeCompare(String(b.name)))
    .slice(0, 5)
}

// The 5 most recently added active products/services.
export function newInCatalog(products) {
  return (products || [])
    .filter((p) => p.active !== false)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, 5)
}

// All-time vehicle counts by make, reusing the Admin metrics
// normalization (Chevy/Chevrolet → Chevrolet, blank → Unknown).
export function makesCount(vehicles) {
  const counts = new Map()
  for (const v of vehicles || []) {
    const make = normalizeMake(v?.make)
    counts.set(make, (counts.get(make) || 0) + 1)
  }
  return {
    total: (vehicles || []).length,
    makes: [...counts.entries()]
      .map(([make, count]) => ({ make, count }))
      .sort((a, b) => b.count - a.count || String(a.make).localeCompare(String(b.make))),
  }
}

// Customers carrying a flag, A–Z by company, capped at 8.
export function flaggedCustomers(customers) {
  return (customers || [])
    .filter((c) => String(c.flag || '').trim())
    .sort((a, b) => String(a.company || '').localeCompare(String(b.company || '')))
    .slice(0, 8)
}
