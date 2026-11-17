import { normalizeVin } from './csv.js'

// Pure ticket math + snapshots, shared by TicketForm, print, and search.
// Money: numeric(12,2) in the DB, half-up rounding to cents, per line.
// Tax rule (matches Bill's Excel sheet): only lines marked taxable get the
// 7.74% tax. Tax is computed per taxable line and rounded to the cent.
// Labor: labor lines ARE in the subtotal (they are line items). The Labor
// figure shown on the ticket is the labor subtotal, informational only —
// it is NOT added again on top of the subtotal (the Excel template's
// TOTAL = SUBTOTAL + TAX + LABOR only works there because labor is a
// separate lump sum outside the line amounts; here labor lives in the lines).

export const TAX_RATE_DEFAULT = 0.0774

export function roundCents(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

export function money(n) {
  return (Number(n) || 0).toFixed(2)
}

export function lineTotal(line) {
  const qty = Number(line.quantity) || 0
  const net = (Number(line.unit_price) || 0) - (Number(line.discount) || 0)
  return roundCents(qty * net)
}

export function computeTotals(lines, taxRate = TAX_RATE_DEFAULT) {
  const rate = Number(taxRate) || 0
  let subtotal = 0
  let labor = 0
  let tax = 0
  for (const line of lines || []) {
    const total = lineTotal(line)
    subtotal = roundCents(subtotal + total)
    if (line.line_kind === 'labor') labor = roundCents(labor + total)
    if (line.taxable) tax = roundCents(tax + roundCents(total * rate))
  }
  return { subtotal, labor, taxTotal: tax, total: roundCents(subtotal + tax) }
}

export function emptyLine(kind = 'part') {
  return {
    id: null,
    product_id: null,
    part_number: '',
    description: '',
    quantity: 1,
    unit_price: 0,
    discount: 0,
    taxable: true,
    line_kind: kind,
    line_total: 0,
    sort_order: 0,
  }
}

export function addDays(dateStr, days) {
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T12:00:00`)
  d.setDate(d.getDate() + Number(days || 0))
  return d.toISOString().slice(0, 10)
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

export function termsDays(terms) {
  const t = String(terms || '').trim().toLowerCase()
  if (t === 'due on receipt' || t === 'cod' || t === 'due upon receipt') return 0
  const m = t.match(/net\s*(\d+)/)
  return m ? Number(m[1]) : 30
}

export function dueDateFor(issueDate, terms) {
  return addDays(issueDate, termsDays(terms))
}

export function ageDays(dateStr) {
  if (!dateStr) return null
  const d = new Date(`${dateStr}T12:00:00`)
  const now = new Date()
  return Math.floor((now - d) / 86400000)
}

export function isOverdue(ticket, today = todayStr()) {
  return (
    ticket &&
    ticket.due_date &&
    ticket.due_date < today &&
    Number(ticket.balance_due ?? ticket.total ?? 0) > 0 &&
    ticket.status !== 'Paid' &&
    ticket.status !== 'Void'
  )
}

export function customerSnapshot(customer, contacts, addresses) {
  if (!customer) return null
  const primary = (contacts || []).find((c) => c.customer_id === customer.id && c.is_primary) ||
    (contacts || []).find((c) => c.customer_id === customer.id)
  const billing = (addresses || []).find((a) => a.customer_id === customer.id && (a.address_type === 'billing' || a.address_type === 'both')) ||
    (addresses || []).find((a) => a.customer_id === customer.id)
  return {
    company: customer.company,
    contact_name: primary?.name || null,
    phone: primary?.phone || null,
    email: primary?.email || null,
    address: billing ? [billing.line1, billing.line2, [billing.city, billing.state, billing.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : null,
    payment_terms: customer.payment_terms,
    tax_exempt: !!customer.tax_exempt,
  }
}

export function vehicleSnapshot(vehicle, vinOverride) {
  if (!vehicle && !vinOverride) return null
  const vin = (vinOverride || vehicle?.vin || '').trim()
  return {
    vehicle_id: vehicle?.id || null,
    year: vehicle?.year ?? null,
    make: vehicle?.make || null,
    model: vehicle?.model || null,
    fleet_unit: vehicle?.fleet_unit || null,
    plate: vehicle?.plate || null,
    vin: vin || null,
    vin_normalized: normalizeVin(vin),
    vin_differs_from_record: !!(vehicle?.vin && vin && normalizeVin(vin) !== normalizeVin(vehicle.vin)),
  }
}

export function vehicleLabel(vehicle) {
  if (!vehicle) return '—'
  return [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'
}

export function cleanLinePayload(line, parentId, parentFk, index) {
  // Only allowed columns, never id/version/timestamps. id is handled by
  // the caller (update by id, or insert without id so Postgres generates it).
  return {
    [parentFk]: parentId,
    product_id: line.product_id || null,
    part_number: (line.part_number || '').trim() || null,
    description: (line.description || '').trim(),
    quantity: Number(line.quantity) || 0,
    unit_price: Number(line.unit_price) || 0,
    discount: Number(line.discount) || 0,
    taxable: !!line.taxable,
    line_kind: line.line_kind || 'part',
    line_total: lineTotal(line),
    sort_order: index,
  }
}
