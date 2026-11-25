import { normalizeVin, normalizePhone } from './csv.js'
import { formatPhone } from './phones.js'
import { titleCaseName } from './names.js'

// Pure ticket math + snapshots, shared by TicketForm, print, and search.
// Money: numeric(12,2) in the DB, half-up rounding to cents, per line.
// Tax rule (matches Bill's Excel sheet): only lines marked taxable get the
// 7.74% tax. Tax is computed per taxable line and rounded to the cent.
// Labor (Nov 18, matching Bill's Excel template): each line has a flat
// Labor $ amount, optional. Subtotal = parts only (qty x unit price).
// Labor total = sum of the Labor $ column PLUS an optional lump-sum labor
// amount on the ticket itself (Nov 19 — sometimes labor is one lump sum
// instead of a line item). Tax = 7.74% on TAXABLE PARTS amounts only
// (labor is not taxed, lump included). TOTAL = Subtotal + Tax + Labor.
// This replaces the old math, where labor-kind lines lived inside the
// subtotal and were shown separately but not added again.

export const TAX_RATE_DEFAULT = 0.0774

export function roundCents(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

export function money(n) {
  // Thousands separators (Nov 24 — totals were printing $12500.00 with no
  // comma). toLocaleString keeps exactly 2 decimals like toFixed did.
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Print: the Letter page is 11in with 0.5in top/bottom margins, so the
// print doc fills the whole 10in printable height. How tall the spacer
// between the lines table and the totals block must be so the totals sit
// at the bottom of the page (Nov 24 — the screenshot proved Chrome's
// print layout does NOT grow a flex spacer into a fixed-height flex
// container: two flex attempts left the totals mid-page. It does honor
// an explicit pixel height on a plain block, so TicketPrint measures the
// content above and below the spacer on screen — same fonts and sizes
// as print — and sets the spacer to the exact gap).
// SAFETY_PX absorbs font/margin rounding so the totals never spill onto
// a second page; a ticket too long for one page gets a 0 spacer and the
// totals flow after the last line, as before.
export const PRINT_DOC_HEIGHT_PX = Math.round(10 * 96) // 960
export function printSpacerHeight(topH, bottomH) {
  const gap = Math.floor(PRINT_DOC_HEIGHT_PX - (Number(topH) || 0) - (Number(bottomH) || 0) - 16)
  return gap > 0 ? gap : 0
}

// Parts amount for a line: qty x unit price. Discount is gone (Nov 18 —
// Bill doesn't use it) and is ignored if an old line still carries one.
export function lineTotal(line) {
  const qty = Number(line.quantity) || 0
  return roundCents(qty * (Number(line.unit_price) || 0))
}

// Flat Labor $ amount on a line (optional, blank/0 is fine). Not taxed.
export function laborAmount(line) {
  return roundCents(Number(line.labor_amount) || 0)
}

export function computeTotals(lines, taxRate = TAX_RATE_DEFAULT, laborLump = 0) {
  const rate = Number(taxRate) || 0
  const lump = roundCents(Number(laborLump) || 0)
  let subtotal = 0
  let laborLines = 0
  let tax = 0
  for (const line of lines || []) {
    const parts = lineTotal(line)
    subtotal = roundCents(subtotal + parts)
    laborLines = roundCents(laborLines + laborAmount(line))
    if (line.taxable) tax = roundCents(tax + roundCents(parts * rate))
  }
  const labor = roundCents(laborLines + lump)
  return { subtotal, labor, laborLines, laborLump: lump, taxTotal: tax, total: roundCents(subtotal + tax + labor) }
}

// Convert a stored line to the current form shape (form layer only —
// nothing is rewritten in the DB until the ticket is saved):
//  - a legacy labor-kind line's charge moves into Labor $ (parts price 0),
//    so its totals are unchanged under the new math;
//  - a part/service line keeps qty x price, discount and product ignored.
export function normalizeLineForForm(line) {
  const l = { ...(line || {}) }
  if (l.line_kind === 'labor') {
    const amount = roundCents(Number(l.line_total) || (Number(l.quantity) || 0) * (Number(l.unit_price) || 0))
    return {
      ...l,
      quantity: 1,
      unit_price: 0,
      labor_amount: amount,
      discount: 0,
      product_id: null,
      line_kind: 'part',
      line_total: 0,
    }
  }
  return {
    ...l,
    labor_amount: roundCents(Number(l.labor_amount) || 0),
    discount: 0,
    product_id: null,
    line_kind: 'part',
  }
}

export function emptyLine(taxable = true) {
  return {
    id: null,
    product_id: null,
    part_number: '',
    description: '',
    quantity: 1,
    unit_price: 0,
    labor_amount: 0,
    discount: 0,
    taxable,
    line_kind: 'part',
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

// --- Invoice dates (Nov 23) ------------------------------------------------
// The store owns an invoice's issue_date/due_date on save — the form no
// longer asks for them. COD = no dates at all. A terms invoice's due date
// runs from the BILLING date (when the invoice is Issued), not from when
// the draft was created: they create the invoice first, wait on equipment,
// finish the job, then bill it out, and the 30 days run from then. A
// customer's profile can carry longer terms (Net 60 is already a Terms
// option on the customer profile) — picking such a customer brings their
// terms onto the ticket and the due date follows from the billing date.
//  - new invoice: issue = today; due = Issued ? (COD ? null : today+terms) : null (a Draft has no due date yet)
//  - Draft -> Issued: issue = today (the billing date); due = COD ? null : today+terms
//  - Draft saved as Draft: keep the saved issue_date; due = null
//  - Issued (or later) edited: keep the saved issue_date and due_date,
//    unless the terms changed — then due = COD ? null : saved issue_date + new terms
//    (a manually-set due date from the old model is preserved when the
//    terms didn't change)
// Quotes are untouched — their dates are handled separately. Pure
// function, so both backends (Supabase + local) can share it.
export function invoiceDatesOnSave({ isNew, currentStatus, currentIssueDate, currentDueDate, currentTerms, newStatus, newTerms }) {
  const today = todayStr()
  const dueFor = (issue, terms) => {
    if (!issue) return null
    return String(terms || '').trim().toLowerCase() === 'cod' ? null : dueDateFor(issue, terms)
  }
  if (isNew) {
    return { issue_date: today, due_date: newStatus === 'Issued' ? dueFor(today, newTerms) : null }
  }
  if (currentStatus === 'Draft' && newStatus === 'Issued') {
    return { issue_date: today, due_date: dueFor(today, newTerms) }
  }
  if (newStatus === 'Draft') {
    return { issue_date: currentIssueDate || null, due_date: null }
  }
  if (String(newTerms || '') !== String(currentTerms || '')) {
    return { issue_date: currentIssueDate || null, due_date: dueFor(currentIssueDate, newTerms) }
  }
  return { issue_date: currentIssueDate || null, due_date: currentDueDate || null }
}

// --- Invoice payments (Phase 3, Nov 19) ----------------------------------
// A deposit is just a payment: paid is the sum of the invoice's payments,
// balance = total - paid (negative = overpaid / credit). Status follows
// ONLY for live invoices — Draft and Void are never touched by this logic:
// total > 0 and paid >= total -> Paid; paid > 0 -> Partially Paid;
// otherwise Issued. Pure function — the store layer (Supabase + local)
// both use it, so the math can never drift between backends.
export function deriveInvoiceBalance(total, paid, currentStatus) {
  const t = roundCents(Number(total) || 0)
  const p = roundCents(Number(paid) || 0)
  const balanceDue = roundCents(t - p)
  let status = currentStatus
  if (['Issued', 'Partially Paid', 'Paid'].includes(currentStatus)) {
    status = t > 0 && p >= t ? 'Paid' : p > 0 ? 'Partially Paid' : 'Issued'
  }
  return { paid: p, balanceDue, status }
}

// Payments display (Nov 25): paid-so-far and balance due count both
// recorded payments and payments staged while the invoice is still being
// written — a new invoice has no id yet, so its payments wait in the form
// until Save writes them. Returns { paid, balance, pendingTotal,
// pendingCount }.
export function invoicePaymentSummary(total, livePayments, pendingPayments) {
  const live = roundCents((livePayments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0))
  const pendingTotal = roundCents((pendingPayments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0))
  const paid = roundCents(live + pendingTotal)
  return { paid, balance: roundCents((Number(total) || 0) - paid), pendingTotal, pendingCount: (pendingPayments || []).length }
}

// Display label for an invoice status (Nov 25): the stored status is
// "Issued", but Bill wants it to read "Open" everywhere it shows — the
// invoice is out and awaiting payment. Display only; the DB value and all
// status logic still use "Issued". Anything else passes through unchanged
// (so it is safe on quote statuses too).
export function displayInvoiceStatus(status) {
  return status === 'Issued' ? 'Open' : status
}

// Payments list (Admin reconciliation, Nov 24): every payment taken,
// newest first, filterable by date range, method, and who recorded it.
// Payment dates are ISO YYYY-MM-DD strings, so plain string comparison
// is a correct day comparison. Empty filter values mean "no filter".
// Always returns newest first (payment_date, then created_at) so the
// list is correct no matter what order the rows arrive in.
export function filterPayments(payments, { from, to, method, recordedBy } = {}) {
  return [...(payments || [])]
    .filter((p) => {
      const d = String(p.payment_date || '').slice(0, 10)
      if (from && d < from) return false
      if (to && d > to) return false
      if (method && p.method !== method) return false
      if (recordedBy && p.created_by !== recordedBy) return false
      return true
    })
    .sort((a, b) =>
      String(b.payment_date || '').localeCompare(String(a.payment_date || '')) ||
      String(b.created_at || '').localeCompare(String(a.created_at || ''))
    )
}

// Display a stored YYYY-MM-DD date (or ISO timestamp) as M/D/YYYY —
// e.g. 2026-11-18 -> 11/18/2026. Storage stays ISO; this is display
// only. Date <input> controls are untouched (the browser renders those
// in the user's locale format already).
export function fmtDate(iso) {
  const s = String(iso || '').slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return '—'
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`
}

// --- Shop chat helpers (pure, no DOM) ---
// Local calendar day of a timestamp (browser local time — the shop's
// day, not UTC), same rule as the dashboard's localDay in App.jsx.
export function localDayStr(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Day-separator label for the chat: Today / Yesterday / M/D/YYYY.
export function chatDayLabel(day, today) {
  if (!day) return ''
  if (day === today) return 'Today'
  if (day === addDays(today, -1)) return 'Yesterday'
  return fmtDate(day)
}

// Short local time for under a chat bubble, e.g. "4:32 PM".
export function chatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function isOwnMessage(msg, userId) {
  return !!msg && !!userId && msg.author_id === userId
}

// New-message dot for Shop chat: true when the latest message from
// someone else is newer than the user's last-seen time. Own messages
// never light it (latestOtherAt already excludes them). Null seen_at
// (never marked seen) + any other-authored message = new. Equal
// timestamps are not new — the message was already seen at that time.
export function hasNewChatMessages(latestOtherAt, seenAt) {
  if (!latestOtherAt) return false
  const latest = new Date(latestOtherAt).getTime()
  if (Number.isNaN(latest)) return false
  if (!seenAt) return true
  const seen = new Date(seenAt).getTime()
  if (Number.isNaN(seen)) return true
  return latest > seen
}

export const CHAT_MAX_LENGTH = 2000

// Returns '' when the draft can send, otherwise the reason it cannot.
export function validateChatDraft(body) {
  const text = (body || '').trim()
  if (!text) return 'Write a message first.'
  if (text.length > CHAT_MAX_LENGTH) return `Messages are limited to ${CHAT_MAX_LENGTH} characters.`
  return ''
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

// Can this user edit this ticket? The exact rules TicketForm enforces
// (and the DB invoice_guard backs up): Sales edit Open quotes and Draft /
// Issued / Partially Paid invoices. Lost quotes and converted quotes are
// locked to Sales, as are Paid / Void / closed-period invoices. Admin may
// correct any ticket except a Void one. Used by TicketForm itself and by
// the print view, which only offers an Edit button when the ticket is
// editable for the current user.
export function canEditTicket(kind, ticket, isAdmin) {
  if (!ticket) return false
  if (kind === 'quote') {
    return isAdmin ? true : (ticket.status === 'Open' && !ticket.converted_invoice_id)
  }
  return isAdmin
    ? ticket.status !== 'Void'
    : (!['Paid', 'Void'].includes(ticket.status) && !ticket.accounting_period_closed)
}

// --- Multiple salespeople per ticket (Nov 23) ------------------------------
// Two salesmen sometimes work one ticket together and both get credit,
// and one salesman sometimes writes a ticket up for another — so a
// ticket carries salesperson_ids, an array of profile UUIDs. At least
// one salesperson is required (the form never lets the last one be
// removed). Names are shown joined with ", " wherever they appear; an
// empty array renders "—".
export function salespersonIdsOf(ticket) {
  const ids = ticket?.salesperson_ids
  return Array.isArray(ids) ? ids.filter(Boolean) : []
}

export function salespersonNamesOf(ticket, profiles) {
  const ids = salespersonIdsOf(ticket)
  if (!ids.length) return '—'
  return ids.map((id) => profiles?.find((p) => p.id === id)?.name || '—').join(', ')
}

// Sales may change the salespeople ONLY while creating a new unsaved
// ticket, or while an invoice is still Draft. Once a quote is saved
// (Open/Lost) or an invoice leaves Draft, the picker is locked for
// Sales — Admin can change salespeople on any editable ticket (Void
// stays locked via canEditTicket). This is a picker-level lock only:
// it does NOT change canEditTicket or any other edit permission —
// Sales can still edit other fields on Draft / Issued / Partially Paid
// invoices exactly as today.
export function canEditSalespeople(kind, ticket, isAdmin, isNew) {
  if (isAdmin) return true
  if (isNew) return true
  if (kind === 'invoice' && ticket?.status === 'Draft') return true
  return false
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
    phone: formatPhone(primary?.phone || '') || null,
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
    bed_size: vehicle?.bed_size || null,
    fleet_unit: vehicle?.fleet_unit || null,
    color: vehicle?.color || null,
    vin: vin || null,
    vin_normalized: normalizeVin(vin),
    vin_differs_from_record: !!(vehicle?.vin && vin && normalizeVin(vin) !== normalizeVin(vehicle.vin)),
  }
}

// --- Vehicle entry lives ON the ticket -------------------------------------
// Bill's rule (Nov 18): a vehicle is entered on the quote/invoice itself —
// VIN + Year/Make/Model/Bed size/Color on one line, Fleet/Unit on the
// next — and the Vehicles tab is populated FROM tickets, not filled in
// first. The ticket's vehicle fields are the source of truth for the
// snapshot; the vehicles table is the directory the ticket feeds.

export function emptyVehicleFields() {
  return { vin: '', year: '', make: '', model: '', bed_size: '', fleet_unit: '', color: '' }
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
    bed_size: s.bed_size || vehicle?.bed_size || '',
    fleet_unit: s.fleet_unit || vehicle?.fleet_unit || '',
    color: s.color || vehicle?.color || '',
  }
}

// Snapshot built from the ticket's own vehicle fields (not from a picked
// vehicle record). Issued tickets are still frozen — because these fields
// ARE the ticket, editing them on the ticket is what changes the snapshot.
export function vehicleSnapshotFromFields(fields, vehicleId) {
  const f = fields || {}
  const vin = normalizeVin(f.vin || '')
  if (!vin && !f.year && !f.make && !f.model && !f.bed_size && !f.fleet_unit && !f.color) return null
  return {
    vehicle_id: vehicleId || null,
    year: f.year ? Number(f.year) : null,
    make: (f.make || '').trim() || null,
    model: (f.model || '').trim() || null,
    bed_size: (f.bed_size || '').trim() || null,
    fleet_unit: (f.fleet_unit || '').trim() || null,
    color: (f.color || '').trim() || null,
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

// Vehicle autofill from a known VIN (TicketForm): fill only the blank
// fields from the matched vehicle record. Returns the merged fields and
// whether anything actually changed — the form must NOT mark itself
// Unsaved when the autofill changes nothing (Nov 24: opening an invoice
// just to record a payment left it saying Unsaved, so the payment looked
// unsaved too and hitting Save after the final payment then failed for
// Sales, because a Paid invoice is locked). Year is compared as a string:
// the form holds it as text, the record may hold a number.
const VEHICLE_AUTOFILL_FIELDS = ['year', 'make', 'model', 'bed_size', 'fleet_unit', 'color']
export function vehicleAutofillResult(veh, match, vehicleId) {
  const filled = {}
  for (const k of VEHICLE_AUTOFILL_FIELDS) filled[k] = veh?.[k] || match?.[k] || ''
  const changed =
    VEHICLE_AUTOFILL_FIELDS.some((k) => String(filled[k] ?? '') !== String(veh?.[k] ?? '')) ||
    (match?.id ? vehicleId !== match.id : false)
  return { filled, changed }
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
  take('bed_size')
  take('fleet_unit')
  take('color')
  return next
}

// Pure upsert decision, given the vehicles already on file and the ticket's
// vehicle fields. Returns { action, vehicle, payload }:
//  - 'none'   — no VIN on the ticket, nothing to upsert.
//  - 'link'   — a record with this VIN exists and already holds everything
//               the ticket has (no stored values change); just link to it.
//  - 'update' — the record exists; the ticket adds/corrects YMM/unit.
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
        bed_size: (fields.bed_size || '').trim() || null,
        fleet_unit: (fields.fleet_unit || '').trim() || null,
        color: (fields.color || '').trim() || null,
      },
    }
  }
  const merged = mergeVehicleFields(existing, { ...fields, vin })
  const changed = ['year', 'make', 'model', 'bed_size', 'fleet_unit', 'color'].some(
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
          bed_size: merged.bed_size || null,
          fleet_unit: merged.fleet_unit || null,
          color: merged.color || null,
        }
      : null,
  }
}

export function duplicateTicket(kind, source, sourceLines, userId, settings) {
  // Fleet duplicate: build a NEW ticket prefilled from a source ticket.
  // Pure function — nothing is saved here. The caller opens TicketForm with
  // the result; only Save creates the record, with a NEW atomic number.
  // Carries over: customer, vehicle (same one, for the user to change),
  // lines (in order), lump-sum labor, customer notes, payment terms, PO
  // number, and the whole salesperson_ids array (Nov 23 — both salesmen
  // keep credit on the copy).
  // Does NOT carry over: id, number, previous_numbers, quote_id (a duplicate
  // is not a conversion), converted_invoice_id, follow-up date, payments /
  // balance history, created_by (reset to the current user), version.
  // Void sources are fine to copy — the copy is fresh (Open for quotes,
  // Draft for invoices).
  const issue = todayStr()
  // source.number already carries its full prefix (QT-1001, QT-A1003,
  // INV-1002, ...) — do not prepend another one.
  const label = source.number
  const sourceNote = `Duplicated from ${label} on ${issue}`
  const ticket = {
    customer_id: source.customer_id || null,
    // The snapshot MUST carry over: for a walk-in ticket it IS the customer
    // (name + phone live nowhere else), so dropping it would lose the buyer.
    customer_snapshot: source.customer_snapshot || null,
    vehicle_id: source.vehicle_id || '',
    vehicle_snapshot: source.vehicle_snapshot || null,
    // Multi-salesman (Nov 23): the duplicate carries the WHOLE
    // salesperson_ids array from the source — both salesmen keep credit
    // on the copy. An empty source array falls back to the current user
    // so the copy still has at least one salesperson.
    salesperson_ids: (source.salesperson_ids || []).length ? [...source.salesperson_ids] : (userId ? [userId] : []),
    created_by: userId || '',
    status: kind === 'quote' ? 'Open' : 'Draft',
    po_number: source.po_number || '',
    payment_terms: source.payment_terms || settings?.default_payment_terms || 'COD',
    customer_notes: source.customer_notes || '',
    internal_notes: [source.internal_notes, sourceNote].filter(Boolean).join('\n'),
    labor_lump: Number(source.labor_lump) || 0,
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
    .map((l, i) => {
      const n = normalizeLineForForm(l)
      return {
        id: null,
        product_id: null,
        part_number: n.part_number || '',
        description: n.description || '',
        quantity: Number(n.quantity) || 1,
        unit_price: Number(n.unit_price) || 0,
        labor_amount: laborAmount(n),
        discount: 0,
        taxable: !!n.taxable,
        line_kind: 'part',
        line_total: 0,
        sort_order: i,
      }
    })
  return { ticket, lines, sourceLabel: label }
}

// --- Add a product/service to a new invoice --------------------------------
// From the Products catalog: builds a NEW Draft invoice prefilled with ONE
// line from the product/service — nothing is saved here. The caller opens
// TicketForm with the result; only Save creates the record, with a NEW
// atomic INV- number, and the user picks the customer first (the form
// refuses to save with no customer and no walk-in). The prefilled line:
// description = product name (+ description if it has one), part number if
// any, unit price = the product's sell price (default_price), quantity 1,
// taxable = the product's taxable flag, labor $ 0. Invoice-only (not
// quotes). The ticket carries fromProduct so the form shows the
// product wording instead of the duplicate wording.
export function invoiceFromProduct(product, userId, settings) {
  const issue = todayStr()
  const lineDescription = [product.name, (product.description || '').trim()]
    .filter(Boolean)
    .join(' — ')
  const ticket = {
    customer_id: null,
    customer_snapshot: null,
    vehicle_id: '',
    vehicle_snapshot: null,
    salesperson_ids: userId ? [userId] : [],
    created_by: userId || '',
    status: 'Draft',
    po_number: '',
    payment_terms: settings?.default_payment_terms || 'COD',
    customer_notes: '',
    internal_notes: `Added from product ${product.name}`,
    labor_lump: 0,
    issue_date: issue,
    due_date: dueDateFor(issue, settings?.default_payment_terms || 'COD'),
    quote_id: null,
    sourceLabel: product.name,
    fromProduct: true,
  }
  const lines = [{
    id: null,
    product_id: null,
    part_number: product.part_number || '',
    description: lineDescription || product.name,
    quantity: 1,
    unit_price: Number(product.default_price) || 0,
    labor_amount: 0,
    discount: 0,
    taxable: !!product.taxable,
    line_kind: 'part',
    line_total: 0,
    sort_order: 0,
  }]
  return { ticket, lines, sourceLabel: product.name, fromProduct: true }
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
    contact_name: titleCaseName((name || '').trim()) || null,
    phone: formatPhone((phone || '').trim()) || null,
    email: (email || '').trim() || null,
    address: null,
    payment_terms: null,
    tax_exempt: false,
  }
}

export function isWalkInTicket(ticket) {
  return !ticket?.customer_id && !!ticket?.customer_snapshot?.walk_in
}

// COD check for the deposit-due reminder: the ticket's terms say COD, or
// it's a walk-in invoice (no customer record — cash on the spot). Terms
// accounts (Net 15/30/60, Due on receipt) never count. Used by the
// Payments section and the Invoices list pill.
export function isCodTicket(ticket) {
  if (isWalkInTicket(ticket)) return true
  return /cod/i.test(String(ticket?.payment_terms || ''))
}

// --- Fleet vs Retail customers ---------------------------------------------
// Bill's rule (Nov 18): Pickup Outfitters is both a fleet shop and a
// regular retail store. Every customer is Retail or Fleet (default Retail),
// so the Customers tab and search can separate them.
export function customerTypeOf(customer) {
  return customer?.customer_type === 'Fleet' ? 'Fleet' : 'Retail'
}

// "Complete & bill" (Nov 25): a fleet/terms job is done and the customer
// can be billed. Shown only on Open, unconverted quotes for a fleet
// customer or a terms account — walk-ins are COD with no customer, so
// they never see it; a Retail customer on Net 30 does (a terms account).
// customer is the linked customer record (null/undefined for a walk-in).
export function canCompleteAndBill(quote, customer) {
  if (!quote || quote.status !== 'Open' || quote.converted_invoice_id) return false
  if (customer && customer.customer_type === 'Fleet') return true
  return !isCodTicket(quote)
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
  // Empty quantity means 1 (the form lets the field clear while typing,
  // and normalizes on blur/save — this is the safety net for any path
  // that reaches here with a blank). An explicit 0 stays 0. The line
  // total is computed from the NORMALIZED quantity so qty and total agree.
  const qty = line.quantity === '' || line.quantity == null ? 1 : Number(line.quantity) || 0
  return {
    [parentFk]: parentId,
    product_id: null, // product picker removed Nov 18 — lines are typed, not picked
    part_number: (line.part_number || '').trim() || null,
    description: (line.description || '').trim(),
    quantity: qty,
    unit_price: Number(line.unit_price) || 0,
    labor_amount: laborAmount(line),
    discount: 0, // discount removed Nov 18 — old values are ignored, never saved
    taxable: !!line.taxable,
    line_kind: 'part', // kind removed Nov 18 — every line is a parts line + optional labor $
    line_total: lineTotal({ ...line, quantity: qty }), // parts amount only; labor lives in labor_amount
    sort_order: index,
  }
}
