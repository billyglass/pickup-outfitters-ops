// Admin dashboard metrics (Nov 24) — pure aggregation over the already-loaded
// data. No DB queries, no new columns, no cost/margin data anywhere: these
// are billed / collected / open-balance totals only. All money math reuses
// the tickets.js helpers; dates are YYYY-MM-DD strings, bucketed by
// issue_date (fallback created_at date) — no date library.
import {
  addDays,
  isOverdue,
  isWalkInTicket,
  money,
  roundCents,
  salespersonIdsOf,
  ticketCustomerName,
  todayStr,
} from './tickets.js'

export { money }

// --- Vehicle make normalization -------------------------------------------
// Chevy/Chevrolet/Chevy all land in one bucket; blank/missing is Unknown;
// anything else is title-cased as-is.
const MAKE_MAP = {
  chevrolet: 'Chevrolet',
  chevy: 'Chevrolet',
  ford: 'Ford',
  dodge: 'Dodge',
  ram: 'Ram',
  gmc: 'GMC',
  toyota: 'Toyota',
  jeep: 'Jeep',
  nissan: 'Nissan',
  honda: 'Honda',
}

function titleCaseWord(w) {
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w
}

export function normalizeMake(make) {
  const raw = String(make || '').trim()
  if (!raw) return 'Unknown'
  const key = raw.toLowerCase()
  if (MAKE_MAP[key]) return MAKE_MAP[key]
  return raw.split(/\s+/).map(titleCaseWord).join(' ')
}

// --- Periods ---------------------------------------------------------------
// 'all' has no bounds (everything counts). The others end today and start
// at the first day of this year / this month / 29 days ago (last 30 days
// inclusive).
export const METRIC_PERIODS = [
  { id: 'all', label: 'All time' },
  { id: 'year', label: 'This year' },
  { id: 'month', label: 'This month' },
  { id: '30d', label: 'Last 30 days' },
]

export function periodBounds(period, today) {
  const t = today || todayStr()
  if (period === 'year') return { start: `${t.slice(0, 4)}-01-01`, end: t }
  if (period === 'month') return { start: `${t.slice(0, 7)}-01`, end: t }
  if (period === '30d') return { start: addDays(t, -29), end: t }
  return { start: null, end: null }
}

export function ticketDate(ticket) {
  return ticket?.issue_date || (ticket?.created_at || '').slice(0, 10) || ''
}

export function inPeriod(dateStr, start, end) {
  if (!start) return true
  return dateStr >= start && dateStr <= end
}

// --- Month buckets ----------------------------------------------------------
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthKeyOf(dateStr) {
  return String(dateStr || '').slice(0, 7)
}

function addMonth(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00`)
  d.setMonth(d.getMonth() + n)
  return d.toISOString().slice(0, 10)
}

// Month keys from start to end, clamped to the last 12 months ending today
// (so "All time" shows a 12-month chart, not every month since the shop
// opened). A narrower period shows just its own months.
export function monthsInRange(start, end, today) {
  const t = today || todayStr()
  const endKey = monthKeyOf(end || t)
  const floorKey = monthKeyOf(addMonth(t, -11))
  let startKey = start ? monthKeyOf(start) : floorKey
  if (startKey < floorKey) startKey = floorKey
  const out = []
  let k = startKey
  while (k <= endKey) {
    const [y, m] = k.split('-').map(Number)
    out.push({ key: k, label: MONTH_NAMES[(m || 1) - 1] })
    k = monthKeyOf(addMonth(`${k}-01`, 1))
  }
  return out
}

// --- The aggregation --------------------------------------------------------
// data: { invoices, quotes, customers, vehicles, profiles } (already loaded).
// Returns { kpis, salesmen, customers, makes, monthly, vehicleTotal }.
// Every division and every max is guarded — thin data renders zeros and
// empty lists, never NaN.
export function computeAdminMetrics(data, period, today) {
  const t = today || todayStr()
  const { start, end } = periodBounds(period, t)
  const inP = (ticket) => inPeriod(ticketDate(ticket), start, end)
  const invoices = (data?.invoices || []).filter((i) => i.status !== 'Void' && inP(i))
  const quotes = (data?.quotes || []).filter((q) => inP(q))
  const profiles = data?.profiles || []
  const customers = data?.customers || []

  // KPI tiles — Void excluded everywhere.
  let billed = 0
  let collected = 0
  let open = 0
  let overdue = 0
  for (const inv of invoices) {
    const total = Number(inv.total || 0)
    const bal = Number(inv.balance_due ?? inv.total ?? 0)
    billed = roundCents(billed + total)
    open = roundCents(open + bal)
    collected = roundCents(collected + (total - bal))
    if (isOverdue(inv, t)) overdue = roundCents(overdue + bal)
  }
  const kpis = {
    billed,
    collected,
    open,
    overdue,
    avg: invoices.length ? roundCents(billed / invoices.length) : 0,
    count: invoices.length,
  }

  // Salesman leaderboard — a ticket shared by two salesmen counts IN FULL
  // for each of them (Bill's rule: both get credit). Unknown profile ids
  // are skipped, not shown as "—".
  const byPerson = new Map()
  const person = (id) => {
    const profile = profiles.find((p) => p.id === id)
    if (!profile) return null
    if (!byPerson.has(id)) {
      byPerson.set(id, {
        id,
        name: profile.name || '—',
        invoiceCount: 0,
        billed: 0,
        collected: 0,
        open: 0,
        quoteCount: 0,
        openQuoteValue: 0,
      })
    }
    return byPerson.get(id)
  }
  for (const inv of invoices) {
    const total = Number(inv.total || 0)
    const bal = Number(inv.balance_due ?? inv.total ?? 0)
    for (const id of salespersonIdsOf(inv)) {
      const row = person(id)
      if (!row) continue
      row.invoiceCount += 1
      row.billed = roundCents(row.billed + total)
      row.collected = roundCents(row.collected + (total - bal))
      row.open = roundCents(row.open + bal)
    }
  }
  for (const q of quotes) {
    for (const id of salespersonIdsOf(q)) {
      const row = person(id)
      if (!row) continue
      row.quoteCount += 1
      if (q.status === 'Open' && !q.converted_invoice_id) {
        row.openQuoteValue = roundCents(row.openQuoteValue + Number(q.total || 0))
      }
    }
  }
  const salesmen = [...byPerson.values()].sort((a, b) => b.billed - a.billed)

  // Top customers — invoices only, Void excluded. Walk-ins group by name
  // (no customer record to click into); real customers keep their id so
  // the row can open the profile.
  const byCustomer = new Map()
  for (const inv of invoices) {
    const walkIn = isWalkInTicket(inv)
    const key = walkIn
      ? `walk-in:${ticketCustomerName(inv, customers)}`
      : `cust:${inv.customer_id || 'none'}`
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        key,
        name: ticketCustomerName(inv, customers),
        walkIn,
        customerId: walkIn ? null : inv.customer_id || null,
        billed: 0,
        invoiceCount: 0,
        open: 0,
      })
    }
    const row = byCustomer.get(key)
    row.billed = roundCents(row.billed + Number(inv.total || 0))
    row.invoiceCount += 1
    row.open = roundCents(row.open + Number(inv.balance_due ?? inv.total ?? 0))
  }
  const topCustomers = [...byCustomer.values()]
    .sort((a, b) => b.billed - a.billed)
    .slice(0, 8)

  // Vehicles by make — always all-time, from every vehicle on file.
  const makeCounts = new Map()
  for (const v of data?.vehicles || []) {
    const make = normalizeMake(v?.make)
    makeCounts.set(make, (makeCounts.get(make) || 0) + 1)
  }
  const makes = [...makeCounts.entries()]
    .map(([make, count]) => ({ make, count }))
    .sort((a, b) => b.count - a.count || a.make.localeCompare(b.make))

  // Billed by month — months in the period (clamped to the last 12).
  const byMonth = new Map()
  for (const inv of invoices) {
    const key = monthKeyOf(ticketDate(inv))
    if (!key) continue
    byMonth.set(key, roundCents((byMonth.get(key) || 0) + Number(inv.total || 0)))
  }
  const monthly = monthsInRange(start, end, t).map((m) => ({
    ...m,
    total: byMonth.get(m.key) || 0,
  }))

  return {
    kpis,
    salesmen,
    customers: topCustomers,
    makes,
    monthly,
    vehicleTotal: (data?.vehicles || []).length,
  }
}
