import { normalizeVin, normalizePhone } from './csv.js'

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

// --- Vehicle entry lives ON the ticket -------------------------------------
// Bill's rule (Nov 18): a vehicle is entered on the quote/invoice itself —
// VIN + Year/Make/Model on one line, Fleet/Unit + Plate on the next — and
// the Vehicles tab is populated FROM tickets, not filled in first.
// The ticket's vehicle fields are the source of truth for the snapshot;
// the vehicles table is the directory the ticket feeds.

export function emptyVehicleFields() {
  return { vin: '', year: '', make: '', model: '', fleet_unit: '', plate: '' }
}

// Fields for the ticket's Vehicle section: snapshot first (frozen ticket
// values win), then the linked vehicle record as a fallback for older
// tickets whose snapshot is missing YMM.
export function vehicleFieldsFromSnapshot(snapshot, vehicle) {
  const s = snapshot || {}
  return {
    vin: s.vin || vehicle?.vin || '',
    year: s.year ?? vehicle?.year ?? '',
    make: s.make || vehicle?.make || '',
    model: s.model || vehicle?.model || '',
    fleet_unit: s.fleet_unit || vehicle?.fleet_unit || '',
    plate: s.plate || vehicle?.plate || '',
  }
}

// Snapshot built from the ticket's own vehicle fields (not from a picked
// vehicle record). Issued tickets are still frozen — because these fields
// ARE the ticket, editing them on the ticket is what changes the snapshot.
export function vehicleSnapshotFromFields(fields, vehicleId) {
  const f = fields || {}
  const vin = normalizeVin(f.vin || '')
  if (!vin && !f.year && !f.make && !f.model && !f.fleet_unit && !f.plate) return null
  return {
    vehicle_id: vehicleId || null,
    year: f.year ? Number(f.year) : null,
    make: (f.make || '').trim() || null,
    model: (f.model || '').trim() || null,
    fleet_unit: (f.fleet_unit || '').trim() || null,
    plate: (f.plate || '').trim() || null,
    vin: vin || null,
    vin_normalized: vin || null,
    vin_differs_from_record: false,
  }
}

// Find the vehicle record for a VIN. Prefer one belonging to this customer
// (a VIN can legitimately exist under another customer — warn, don't block).
export function findVehicleByVin(vehicles, vin, customerId) {
  const n = normalizeVin(vin)
  if (!n) return null
  const matches = (vehicles || []).filter((v) => normalizeVin(v.vin) === n)
  if (!matches.length) return null
  return matches.find((v) => v.customer_id === customerId) || matches[0]
}

// Merge ticket fields into a stored vehicle record: non-blank ticket values
// overwrite, blank ticket fields NEVER blank out stored values.
export function mergeVehicleFields(existing, incoming) {
  const next = { ...(existing || {}) }
  const take = (key, asNumber) => {
    const v = incoming?.[key]
    if (v === undefined || v === null || String(v).trim() === '') return
    next[key] = asNumber ? Number(v) : String(v).trim()
  }
  take('vin')
  take('year', true)
  take('make')
  take('model')
  take('fleet_unit')
  take('plate')
  return next
}

// Pure upsert decision, given the vehicles already on file and the ticket's
// vehicle fields. Returns { action, vehicle, payload }:
//  - 'none'   — no VIN on the ticket, nothing to upsert.
//  - 'link'   — a record with this VIN exists and already holds everything
//               the ticket has (no stored values change); just link to it.
//  - 'update' — the record exists; the ticket adds/corrects YMM/unit/plate.
//  - 'create' — no record with this VIN; insert one for this customer.
// The store layer performs the DB call; this function is unit-testable.
export function resolveVehicleUpsert(vehicles, customerId, fields) {
  const vin = normalizeVin(fields?.vin || '')
  if (!vin) return { action: 'none', vehicle: null, payload: null }
  const existing = findVehicleByVin(vehicles, vin, customerId)
  if (!existing) {
    return {
      action: 'create',
      vehicle: null,
      payload: {
        customer_id: customerId,
        vin,
        year: fields.year ? Number(fields.year) : null,
        make: (fields.make || '').trim() || null,
        model: (fields.model || '').trim() || null,
        fleet_unit: (fields.fleet_unit || '').trim() || null,
        plate: (fields.plate || '').trim() || null,
      },
    }
  }
  const merged = mergeVehicleFields(existing, { ...fields, vin })
  const changed = ['year', 'make', 'model', 'fleet_unit', 'plate'].some(
    (k) => (merged[k] ?? null) !== (existing[k] ?? null)
  )
  return {
    action: changed ? 'update' : 'link',
    vehicle: existing,
    payload: changed
      ? {
          year: merged.year ?? null,
          make: merged.make || null,
          model: merged.model || null,
          fleet_unit: merged.fleet_unit || null,
          plate: merged.plate || null,
        }
      : null,
  }
}

export function duplicateTicket(kind, source, sourceLines, userId, settings) {
  // Fleet duplicate: build a NEW Draft ticket prefilled from a source ticket.
  // Pure function — nothing is saved here. The caller opens TicketForm with
  // the result; only Save creates the record, with a NEW atomic number.
  // Carries over: customer, vehicle (same one, for the user to change),
  // lines (in order), customer notes, payment terms, PO number.
  // Does NOT carry over: id, number, previous_numbers, quote_id (a duplicate
  // is not a conversion), converted_invoice_id, follow-up date, payments /
  // balance history, created_by (reset to the current user), version.
  // Void sources are fine to copy — the copy is a fresh Draft.
  const issue = todayStr()
  const label = `${kind === 'quote' ? 'QT-' : 'INV-'}${source.number}`
  const sourceNote = `Duplicated from ${label} on ${issue}`
  const ticket = {
    customer_id: source.customer_id || null,
    // The snapshot MUST carry over: for a walk-in ticket it IS the customer
    // (name + phone live nowhere else), so dropping it would lose the buyer.
    customer_snapshot: source.customer_snapshot || null,
    vehicle_id: source.vehicle_id || '',
    vehicle_snapshot: source.vehicle_snapshot || null,
    salesperson_id: userId || source.salesperson_id || '',
    created_by: userId || '',
    status: 'Draft',
    po_number: source.po_number || '',
    payment_terms: source.payment_terms || settings?.default_payment_terms || 'Net 30',
    customer_notes: source.customer_notes || '',
    internal_notes: [source.internal_notes, sourceNote].filter(Boolean).join('\n'),
    issue_date: issue,
    sourceLabel: label,
  }
  if (kind === 'quote') {
    ticket.expires_on = addDays(issue, settings?.quote_validity_days ?? 15)
    ticket.follow_up_on = ''
  } else {
    ticket.due_date = dueDateFor(issue, ticket.payment_terms)
    ticket.quote_id = null
  }
  const lines = (sourceLines || [])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((l, i) => ({
      id: null,
      product_id: l.product_id || null,
      part_number: l.part_number || '',
      description: l.description || '',
      quantity: Number(l.quantity) || 1,
      unit_price: Number(l.unit_price) || 0,
      discount: Number(l.discount) || 0,
      taxable: !!l.taxable,
      line_kind: l.line_kind || 'part',
      line_total: 0,
      sort_order: i,
    }))
  return { ticket, lines, sourceLabel: label }
}

// --- Walk-in / one-off tickets ------------------------------------------------
// Bill's rule (Nov 18): a quick invoice/quote for a small one-off purchase
// must NOT require creating a customer record. The ticket just carries a
// name + phone (+ optional email) in its customer_snapshot, with
// customer_id = null. No fake "Walk-in Customer" record is ever created —
// a null customer_id with a walk-in snapshot is the honest representation,
// and the ticket is self-contained (it prints and searches correctly with
// no customer record behind it).
export function walkInCustomerSnapshot(name, phone, email) {
  return {
    walk_in: true,
    company: null,
    contact_name: (name || '').trim() || null,
    phone: (phone || '').trim() || null,
    email: (email || '').trim() || null,
    address: null,
    payment_terms: null,
    tax_exempt: false,
  }
}

export function isWalkInTicket(ticket) {
  return !ticket?.customer_id && !!ticket?.customer_snapshot?.walk_in
}

// --- Fleet vs Retail customers ---------------------------------------------
// Bill's rule (Nov 18): Pickup Outfitters is both a fleet shop and a
// regular retail store. Every customer is Retail or Fleet (default Retail),
// so the Customers tab and search can separate them.
export function customerTypeOf(customer) {
  return customer?.customer_type === 'Fleet' ? 'Fleet' : 'Retail'
}

// Find an existing customer by a walk-in's phone (digits only) or email
// (case-insensitive) — used by "Save walk-in as customer" so a repeat
// buyer is linked to their existing record instead of creating a duplicate.
// Contacts are the source: a phone/email lives on a contact row, and the
// contact points at the customer. Returns the customer record or null.
export function findCustomerByPhoneOrEmail(customers, contacts, phone, email) {
  const digits = normalizePhone(phone)
  const mail = String(email || '').trim().toLowerCase()
  if (!digits && !mail) return null
  const hit = (contacts || []).find((c) => {
    if (digits && normalizePhone(c.phone) && normalizePhone(c.phone) === digits) return true
    if (mail && String(c.email || '').trim().toLowerCase() === mail) return true
    return false
  })
  if (!hit) return null
  return (customers || []).find((c) => c.id === hit.customer_id) || null
}

// Display name for a ticket's customer: the walk-in name for walk-ins, the
// customer record's company otherwise. Never crashes on a null customer_id.
export function ticketCustomerName(ticket, customers) {
  if (!ticket) return '—'
  if (isWalkInTicket(ticket)) {
    return ticket.customer_snapshot.contact_name || ticket.customer_snapshot.company || 'Walk-in'
  }
  if (!ticket.customer_id) return '—'
  return (customers || []).find((c) => c.id === ticket.customer_id)?.company || '—'
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
