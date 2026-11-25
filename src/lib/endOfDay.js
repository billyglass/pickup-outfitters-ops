import { computeTotals, roundCents, TAX_RATE_DEFAULT } from './tickets.js'

// End-of-day sheet (Nov 25, 2026) — pure helpers. Mirrors Bill's
// spreadsheet exactly: Profit = Sale − Cost, % = Profit / Sale; Labor and
// Tax are tracked and totaled but never go into profit. Sale is the
// pre-tax sale (parts subtotal + labor); Tax is shown in its own column,
// the way his sheet has a separate Tax column. Cost lives per invoice
// (invoices.cost_of_goods, migration 025) and is entered ONLY on the End
// of day tab — never on the invoice form.

// Sale / Labor / Tax for one invoice, from its lines. Falls back to the
// stored row values when the invoice has no lines in the loaded data
// (the stored subtotal / tax_total / total are the billed figures).
export function invoiceSaleFigures(invoice, lines, taxRate = TAX_RATE_DEFAULT) {
  if (lines && lines.length) {
    const t = computeTotals(lines, taxRate, invoice?.labor_lump)
    return {
      sale: roundCents(t.subtotal + t.labor),
      labor: t.labor,
      tax: t.taxTotal,
    }
  }
  const subtotal = Number(invoice?.subtotal) || 0
  const tax = Number(invoice?.tax_total) || 0
  const total = Number(invoice?.total) || 0
  const labor = Math.max(0, roundCents(total - subtotal - tax))
  return { sale: roundCents(subtotal + labor), labor, tax }
}

// Profit and margin for one sale. A missing cost means "not entered yet"
// — profit is null, NOT $0.00 (a $0 profit would be a lie). % is null
// when the sale is 0 (nothing to divide by).
export function profitFor(sale, cost) {
  const s = Number(sale) || 0
  const c = Number(cost)
  if (cost == null || !Number.isFinite(c) || c < 0) return { profit: null, pct: null }
  return { profit: roundCents(s - c), pct: s > 0 ? roundCents(s - c) / s : null }
}

// One row per invoice with at least one payment on the date: two payments
// on the same invoice the same day are ONE row. Payments on another day
// are excluded. payment_date is a YYYY-MM-DD date, so a plain string
// comparison is right (no timezone math).
export function collectRowsForDate(payments, date) {
  const byInvoice = new Map()
  for (const p of payments || []) {
    if (String(p.payment_date || '').slice(0, 10) !== date) continue
    const id = p.invoice_id
    if (!id) continue
    byInvoice.set(id, roundCents((byInvoice.get(id) || 0) + (Number(p.amount) || 0)))
  }
  return [...byInvoice.entries()].map(([invoiceId, collected]) => ({ invoiceId, collected }))
}

// Cash in the door on the date: every payment dated that day, whatever
// invoice it belongs to (even one since deleted — the money was still
// collected).
export function cashCollectedOn(payments, date) {
  return roundCents((payments || [])
    .filter((p) => String(p.payment_date || '').slice(0, 10) === date)
    .reduce((s, p) => s + (Number(p.amount) || 0), 0))
}

// Match an invoice by its number or any previous number (renumbered
// invoices stay findable). Trimmed, case-insensitive.
export function findInvoiceByNumber(invoices, text) {
  const q = String(text || '').trim().toLowerCase()
  if (!q) return null
  return (invoices || []).find((inv) => {
    if (String(inv.number || '').trim().toLowerCase() === q) return true
    return (inv.previous_numbers || []).some((n) => String(n || '').trim().toLowerCase() === q)
  }) || null
}

// Invoices billed on a date — the same definition as the Receivables
// "Billed today" list: a billing date on that day, and not Void.
export function billedOnDate(invoices, date) {
  return (invoices || []).filter(
    (inv) => inv.status !== 'Void' && String(inv.issue_date || '').slice(0, 10) === date
  )
}

// Sold-today square figures from [{ sale, cost }] for the billed invoices.
// Profit and % run ONLY across invoices with a cost entered — a missing
// cost means "not entered yet", not $0. totalCost / profit / pct are null
// when no cost is entered anywhere.
export function soldSummary(figures) {
  const rows = figures || []
  const totalSold = roundCents(rows.reduce((s, f) => s + (Number(f.sale) || 0), 0))
  const costed = rows.filter((f) => f.cost != null && Number.isFinite(Number(f.cost)) && Number(f.cost) >= 0)
  const costedSale = roundCents(costed.reduce((s, f) => s + (Number(f.sale) || 0), 0))
  const totalCost = costed.length ? roundCents(costed.reduce((s, f) => s + Number(f.cost), 0)) : null
  const profit = costed.length ? roundCents(costedSale - totalCost) : null
  const pct = costed.length && costedSale > 0 ? profit / costedSale : null
  return { count: rows.length, totalSold, totalCost, profit, pct, costedCount: costed.length }
}

// Collected-sheet totals, mirroring the spreadsheet's totals row. Only
// rows WITH a cost entered contribute to ANY total — a row with no cost
// yet contributes nothing, and missingCost says how many are still
// waiting. % is total profit / total sale.
export function collectedTotals(rows) {
  const costed = (rows || []).filter((r) => r.cost != null && Number.isFinite(Number(r.cost)) && Number(r.cost) >= 0)
  const totalSale = roundCents(costed.reduce((s, r) => s + (Number(r.sale) || 0), 0))
  const totalCost = roundCents(costed.reduce((s, r) => s + Number(r.cost), 0))
  const totalProfit = roundCents(totalSale - totalCost)
  const totalLabor = roundCents(costed.reduce((s, r) => s + (Number(r.labor) || 0), 0))
  const totalTax = roundCents(costed.reduce((s, r) => s + (Number(r.tax) || 0), 0))
  return {
    totalSale,
    totalCost,
    totalProfit,
    pct: totalSale > 0 ? totalProfit / totalSale : null,
    totalLabor,
    totalTax,
    missingCost: (rows || []).length - costed.length,
    rowCount: (rows || []).length,
  }
}
