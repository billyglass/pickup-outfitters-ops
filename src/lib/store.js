import { supabase, supabaseConfigured } from './supabase.js'
import { normalizeVin, normalizePhone } from './csv.js'
import { computeTotals, cleanLinePayload, lineTotal, roundCents, dueDateFor, todayStr, resolveVehicleUpsert, vehicleSnapshotFromFields, ticketCustomerName, isWalkInTicket, customerSnapshot, customerTypeOf, findCustomerByPhoneOrEmail, deriveInvoiceBalance } from './tickets.js'
import { titleCaseName } from './names.js'
import { formatPhone, phoneMatches } from './phones.js'

// Data layer. Two backends behind one API (same pattern as the tracker):
//   - Supabase (when env vars are set): shared Postgres, RLS enforced.
//   - Local mode (no env vars): localStorage, for trying the UI before
//     Supabase is connected. Shows a banner; do not use for real data.
const LS_CUSTOMERS = 'po_ops_customers_v1'
const LS_CUSTOMER_NOTES = 'po_ops_customer_notes_v1'
const LS_PRODUCT_NOTES = 'po_ops_product_notes_v1'
const LS_INVOICE_PAYMENTS = 'po_ops_invoice_payments_v1'
const LS_VEHICLES = 'po_ops_vehicles_v1'

export class VersionConflict extends Error {
  constructor(message) {
    super(message)
    this.name = 'VersionConflict'
  }
}

function uid() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function lsRead(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}
function lsWrite(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

// --- Supabase ---------------------------------------------------------------

async function sbLoad() {
  const [customers, contacts, addresses, vehicles, quotes, invoices, quoteLines, invoiceLines, products, profiles, settings] =
    await Promise.all([
      supabase.from('customers').select('*').order('company', { ascending: true }),
      supabase.from('contacts').select('*'),
      supabase.from('customer_addresses').select('*'),
      supabase.from('vehicles').select('*').order('created_at', { ascending: false }),
      supabase.from('quotes').select('*').order('created_at', { ascending: false }),
      supabase.from('invoices').select('*').order('created_at', { ascending: false }),
      supabase.from('quote_lines').select('*').order('sort_order', { ascending: true }),
      supabase.from('invoice_lines').select('*').order('sort_order', { ascending: true }),
      // products has NO cost column by design (cost lives in product_costs)
      // — but since Nov 19 (migration 017) product_costs is readable by
      // every active user, so cost is merged onto each product below and
      // Sales see it too. That merge is best-effort: pre-migration, Sales
      // cannot read product_costs (still Admin-only RLS), so costs just
      // show blank instead of breaking the whole load.
      supabase.from('products').select('*').order('name', { ascending: true }),
      supabase.from('profiles').select('id, name, email, role, active'),
      supabase.rpc('public_settings'),
    ])
  for (const r of [customers, contacts, addresses, vehicles, quotes, invoices, quoteLines, invoiceLines, products, profiles]) {
    if (r.error) throw r.error
  }
  let costByProduct = {}
  try {
    const { data: costs, error: costsErr } = await supabase.from('product_costs').select('*')
    if (!costsErr) {
      for (const c of costs || []) costByProduct[c.product_id] = Number(c.cost) || 0
    }
  } catch { /* costs unavailable (e.g. pre-migration RLS) — blank, load continues */ }
  return {
    customers: customers.data || [],
    contacts: contacts.data || [],
    addresses: addresses.data || [],
    vehicles: vehicles.data || [],
    quotes: quotes.data || [],
    invoices: invoices.data || [],
    quoteLines: quoteLines.data || [],
    invoiceLines: invoiceLines.data || [],
    products: (products.data || []).map((p) => ({ ...p, cost: costByProduct[p.id] ?? 0 })),
    profiles: profiles.data || [],
    settings: settings.data?.[0] || null,
  }
}

async function sbSaveCustomer(customer, contacts, addresses) {
  const now = new Date().toISOString()
  if (customer.id) {
    // Optimistic concurrency: only update if version still matches.
    const { data: current, error: curErr } = await supabase
      .from('customers')
      .select('version')
      .eq('id', customer.id)
      .single()
    if (curErr) throw curErr
    if (current.version !== customer.version) {
      throw new VersionConflict(
        `This customer was changed by someone else (version ${current.version}, you had ${customer.version}). Reload and re-apply your changes — nothing was overwritten.`
      )
    }
    const { data, error } = await supabase
      .from('customers')
      .update({
        company: titleCaseName(customer.company),
        customer_type: customerTypeOf(customer),
        fleet_size: customer.fleet_size ?? null,
        flag: customer.flag || null,
        flag_note: customer.flag ? customer.flag_note || null : null,
        tax_exempt: customer.tax_exempt,
        tax_exempt_doc_note: customer.tax_exempt_doc_note || null,
        payment_terms: customer.payment_terms || 'Net 30',
        po_requirements: customer.po_requirements || null,
      })
      .eq('id', customer.id)
      .eq('version', customer.version)
      .select()
      .single()
    if (error) throw error
    if (!data) throw new VersionConflict('Save conflict — this record changed since you opened it. Reload and try again.')
    await sbReplaceChildren('contacts', 'customer_id', data.id, contacts)
    await sbReplaceChildren('customer_addresses', 'customer_id', data.id, addresses)
    return data
  }
  const { data, error } = await supabase
    .from('customers')
    .insert({
      company: titleCaseName(customer.company),
      customer_type: customerTypeOf(customer),
      fleet_size: customer.fleet_size ?? null,
      flag: customer.flag || null,
      flag_note: customer.flag ? customer.flag_note || null : null,
      tax_exempt: customer.tax_exempt,
      tax_exempt_doc_note: customer.tax_exempt_doc_note || null,
      payment_terms: customer.payment_terms || 'Net 30',
      po_requirements: customer.po_requirements || null,
    })
    .select()
    .single()
  if (error) throw error
  await sbReplaceChildren('contacts', 'customer_id', data.id, contacts)
  await sbReplaceChildren('customer_addresses', 'customer_id', data.id, addresses)
  return data
}

async function sbReplaceChildren(table, fk, customerId, rows) {
  const { error: delErr } = await supabase.from(table).delete().eq(fk, customerId)
  if (delErr) throw delErr
  // Build an explicit payload with ONLY the allowed columns — never id,
  // version, or timestamps. The old code spread the whole row ({...r, id:
  // undefined}), and Supabase/PostgREST sent id as null, which violates the
  // not-null PK: "null value in column id of relation contacts".
  // Also: a blank row must not count as content just because is_primary=false.
  const allowed =
    table === 'contacts'
      ? ['name', 'phone', 'email', 'title', 'is_primary']
      : ['address_type', 'line1', 'line2', 'city', 'state', 'zip', 'is_primary']
  const clean = (rows || [])
    .map((r) => {
      const o = {}
      for (const k of allowed) o[k] = k === 'is_primary' ? !!r[k] : r[k] || null
      // Contact names are title-cased on save (same rule as the company
      // name) — the import path does not go through here.
      if (table === 'contacts' && o.name) o.name = titleCaseName(o.name)
      // Contact phones are formatted on save too — (314) 892-0032 — so a
      // number typed as 3148920032 is stored formatted even if blur never
      // fired. Digits are never changed, only punctuation.
      if (table === 'contacts' && o.phone) o.phone = formatPhone(o.phone)
      return o
    })
    .filter((o) =>
      allowed
        .filter((k) => k !== 'is_primary')
        .some((k) => String(o[k] ?? '').trim() !== '')
    )
  if (!clean.length) return
  const payload = clean.map((o) => ({ ...o, [fk]: customerId }))
  const { error } = await supabase.from(table).insert(payload)
  if (error) throw error
}

async function sbSaveVehicle(vehicle) {
  if (vehicle.id) {
    const { data: current, error: curErr } = await supabase
      .from('vehicles')
      .select('version')
      .eq('id', vehicle.id)
      .single()
    if (curErr) throw curErr
    if (current.version !== vehicle.version) {
      throw new VersionConflict(
        `This vehicle was changed by someone else (version ${current.version}, you had ${vehicle.version}). Reload and re-apply your changes.`
      )
    }
    const { data, error } = await supabase
      .from('vehicles')
      .update({
        customer_id: vehicle.customer_id || null,
        vin: vehicle.vin || null,
        year: vehicle.year || null,
        make: vehicle.make || null,
        model: vehicle.model || null,
        bed_size: vehicle.bed_size || null,
        fleet_unit: vehicle.fleet_unit || null,
        color: vehicle.color || null,
        notes: vehicle.notes || null,
      })
      .eq('id', vehicle.id)
      .eq('version', vehicle.version)
      .select()
      .single()
    if (error) throw error
    if (!data) throw new VersionConflict('Save conflict — this record changed since you opened it.')
    return data
  }
  const { data, error } = await supabase
    .from('vehicles')
    .insert({
      customer_id: vehicle.customer_id || null,
      vin: vehicle.vin || null,
      year: vehicle.year || null,
      make: vehicle.make || null,
      model: vehicle.model || null,
      bed_size: vehicle.bed_size || null,
      fleet_unit: vehicle.fleet_unit || null,
      color: vehicle.color || null,
      notes: vehicle.notes || null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

async function sbCheckVin(vin, excludeId) {
  const normalized = normalizeVin(vin)
  if (!normalized) return []
  const { data, error } = await supabase
    .from('vehicles')
    .select('id, vin, vin_normalized, customer_id, year, make, model, bed_size, fleet_unit, color')
    .eq('vin_normalized', normalized)
  if (error) throw error
  return (data || []).filter((v) => v.id !== excludeId)
}

async function sbDeleteCustomer(id) {
  const { error } = await supabase.from('customers').delete().eq('id', id)
  if (error) throw error
}

async function sbDeleteVehicle(id) {
  const { error } = await supabase.from('vehicles').delete().eq('id', id)
  if (error) throw error
}

// --- Tickets (quotes + invoices) -------------------------------------------
// Shared save for both ticket types. `kind` is 'quote' | 'invoice'.
// - New ticket: number comes from the atomic server function
//   next_quote_number() / next_invoice_number() via rpc — never client-side.
// - Existing ticket: version check first (refuse silent overwrite), then
//   update with .eq('version', ...) — the DB trigger bumps version on save.
// - Lines are synced, never delete-all/reinsert: update rows that have an
//   id, insert new rows without id (Postgres generates it), delete removed
//   rows. (Delete-all would hit the Admin-only delete policy for Sales and
//   would also resend id: null — the Phase 1 contacts bug.)
// - Quotes: a revision row is written on every save of an existing quote.

function ticketTable(kind) {
  return kind === 'quote' ? 'quotes' : 'invoices'
}
function lineTable(kind) {
  return kind === 'quote' ? 'quote_lines' : 'invoice_lines'
}
function lineFk(kind) {
  return kind === 'quote' ? 'quote_id' : 'invoice_id'
}

async function sbNextNumber(kind) {
  const { data, error } = await supabase.rpc(kind === 'quote' ? 'next_quote_number' : 'next_invoice_number')
  if (error) throw error
  return data
}

async function sbSyncLines(kind, parentId, lines) {
  const table = lineTable(kind)
  const fk = lineFk(kind)
  const { data: existing, error: loadErr } = await supabase.from(table).select('id').eq(fk, parentId)
  if (loadErr) throw loadErr
  const existingIds = new Set((existing || []).map((r) => r.id))
  const keepIds = new Set()
  const toInsert = []
  for (let i = 0; i < (lines || []).length; i++) {
    const line = lines[i]
    if (!String(line.description || '').trim() && !String(line.part_number || '').trim()) continue
    const payload = cleanLinePayload(line, parentId, fk, i)
    if (line.id && existingIds.has(line.id)) {
      keepIds.add(line.id)
      const { error } = await supabase.from(table).update(payload).eq('id', line.id)
      if (error) throw error
    } else {
      toInsert.push(payload)
    }
  }
  for (const id of existingIds) {
    if (!keepIds.has(id)) {
      // Open-quote / Draft-invoice parents only for non-Admins — see
      // migration 002 (delete policy for lines on editable tickets, and
      // migration 008 for the Open quote status). Admins may delete any line.
      const { error } = await supabase.from(table).delete().eq('id', id)
      if (error) throw error
    }
  }
  if (toInsert.length) {
    const { error } = await supabase.from(table).insert(toInsert)
    if (error) throw error
  }
}

// --- Vehicle upsert from a ticket -----------------------------------------
// Vehicles are entered ON the quote/invoice, not beforehand: on ticket save
// the ticket's VIN + YMM upserts the vehicles directory. If a record with
// that VIN exists, link to it and fill in only non-blank ticket values
// (blank fields never erase stored data); otherwise create the record for
// the ticket's customer. No VIN on the ticket => no vehicle record.
// Only allowed columns, never id: null — and vin_normalized is a generated
// column, so it is never sent. RLS already lets any active user
// insert/update vehicles, so Sales can do this from a ticket save.
async function sbUpsertVehicleFromTicket(customerId, snapshot) {
  const vin = normalizeVin(snapshot?.vin || snapshot?.vin_normalized || '')
  // customerId may be null for a walk-in ticket — the vehicle is still
  // created, with customer_id null (migration 003). No VIN => no record.
  if (!vin) return null
  const { data: rows, error } = await supabase
    .from('vehicles')
    .select('*')
    .eq('vin_normalized', vin)
  if (error) throw error
  const fields = {
    vin,
    year: snapshot.year ?? '',
    make: snapshot.make || '',
    model: snapshot.model || '',
    bed_size: snapshot.bed_size || '',
    fleet_unit: snapshot.fleet_unit || '',
    color: snapshot.color || '',
  }
  const decision = resolveVehicleUpsert(rows || [], customerId, fields)
  if (decision.action === 'none' || decision.action === 'link') return decision.vehicle
  if (decision.action === 'create') {
    const { data, error: insErr } = await supabase.from('vehicles').insert(decision.payload).select().single()
    if (insErr) throw insErr
    return data
  }
  // update — plain update by id (no version predicate: this is a merge of
  // ticket fields, not an edit of the vehicle form; the DB trigger bumps
  // version and the audit trigger logs it).
  const { data, error: updErr } = await supabase
    .from('vehicles')
    .update(decision.payload)
    .eq('id', decision.vehicle.id)
    .select()
    .single()
  if (updErr) throw updErr
  return data
}

// Local-mode mirror of the upsert (same rules, localStorage vehicles).
function localUpsertVehicleFromTicket(customerId, snapshot) {
  const vin = normalizeVin(snapshot?.vin || snapshot?.vin_normalized || '')
  // customerId may be null for a walk-in ticket — same rule as Supabase mode.
  if (!vin) return null
  const vehicles = lsRead(LS_VEHICLES, [])
  const fields = {
    vin,
    year: snapshot.year ?? '',
    make: snapshot.make || '',
    model: snapshot.model || '',
    bed_size: snapshot.bed_size || '',
    fleet_unit: snapshot.fleet_unit || '',
    color: snapshot.color || '',
  }
  const decision = resolveVehicleUpsert(vehicles, customerId, fields)
  if (decision.action === 'none' || decision.action === 'link') return decision.vehicle
  const now = new Date().toISOString()
  if (decision.action === 'create') {
    const saved = { ...decision.payload, id: uid(), vin_normalized: vin, version: 1, created_at: now, updated_at: now }
    lsWrite(LS_VEHICLES, [saved, ...vehicles])
    return saved
  }
  const idx = vehicles.findIndex((v) => v.id === decision.vehicle.id)
  const saved = { ...vehicles[idx], ...decision.payload, version: (vehicles[idx].version || 1) + 1, updated_at: now }
  vehicles[idx] = saved
  lsWrite(LS_VEHICLES, vehicles)
  return saved
}

async function sbSaveTicket(kind, ticket, lines, userId) {
  const table = ticketTable(kind)
  const totals = computeTotals(lines, ticket.tax_rate, ticket.labor_lump)
  // Phase 3 payments: an invoice's balance is total minus what has already
  // been paid — never just the total. Best effort: if the payments table
  // doesn't exist yet (pre-migration 016) the lookup fails and paid stays
  // 0, so the save still works exactly as before. A ticket save must never
  // break because of the payments table.
  let paidSoFar = 0
  if (kind === 'invoice' && ticket.id) {
    try {
      const { data: pays, error: payErr } = await supabase
        .from('invoice_payments')
        .select('amount')
        .eq('invoice_id', ticket.id)
      if (!payErr && pays) paidSoFar = roundCents(pays.reduce((s, p) => s + (Number(p.amount) || 0), 0))
    } catch { /* pre-migration: no payments table yet — paid stays 0 */ }
  }
  // Vehicle upsert from the ticket's own VIN/YMM fields. For a NEW ticket
  // this runs before the insert; for an EXISTING ticket it runs after the
  // version check below (so a conflicting save never creates/updates a
  // vehicle record). The snapshot's vehicle_id is set to the linked record.
  let vehicle = null
  const upsertAndLink = async (header) => {
    vehicle = await sbUpsertVehicleFromTicket(ticket.customer_id, ticket.vehicle_snapshot)
    header.vehicle_id = vehicle?.id || ticket.vehicle_id || null
    header.vehicle_snapshot = vehicleSnapshotFromFields(
      {
        vin: ticket.vehicle_snapshot?.vin || '',
        year: ticket.vehicle_snapshot?.year ?? '',
        make: ticket.vehicle_snapshot?.make || '',
        model: ticket.vehicle_snapshot?.model || '',
        bed_size: ticket.vehicle_snapshot?.bed_size || '',
        fleet_unit: ticket.vehicle_snapshot?.fleet_unit || '',
        color: ticket.vehicle_snapshot?.color || '',
      },
      header.vehicle_id
    ) || header.vehicle_snapshot
    return header
  }
  const header = {
    customer_id: ticket.customer_id || null, // null = walk-in ticket
    vehicle_id: ticket.vehicle_id || null,
    // Multi-salesman (Nov 23): the whole salesperson_ids array is saved.
    // An empty array falls back to the current user so a ticket always
    // has at least one salesperson.
    salesperson_ids: (ticket.salesperson_ids || []).filter(Boolean).length
      ? (ticket.salesperson_ids || []).filter(Boolean)
      : (userId ? [userId] : []),
    status: ticket.status,
    po_number: ticket.po_number || null,
    payment_terms: ticket.payment_terms || 'Net 30',
    customer_notes: ticket.customer_notes || null,
    internal_notes: ticket.internal_notes || null,
    customer_snapshot: ticket.customer_snapshot || null,
    vehicle_snapshot: ticket.vehicle_snapshot || null,
    labor_lump: roundCents(Number(ticket.labor_lump) || 0),
    subtotal: totals.subtotal,
    tax_total: totals.taxTotal,
    total: totals.total,
  }
  if (kind === 'quote') {
    header.issue_date = ticket.issue_date || null
    header.expires_on = ticket.expires_on || null
    header.follow_up_on = ticket.follow_up_on || null
  } else {
    header.issue_date = ticket.issue_date || null
    header.due_date = ticket.due_date || null
    // Balance and status follow the payments (Draft / Void untouched).
    const derived = deriveInvoiceBalance(totals.total, paidSoFar, ticket.status)
    header.balance_due = derived.balanceDue
    header.status = derived.status
    header.quote_id = ticket.quote_id || null
    if (ticket.idempotency_key) header.idempotency_key = ticket.idempotency_key
  }
  if (!ticket.id) {
    // New ticket: upsert the vehicle from the ticket, then allocate the
    // number atomically on the server.
    await upsertAndLink(header)
    const number = await sbNextNumber(kind)
    const { data, error } = await supabase
      .from(table)
      .insert({ ...header, number, created_by: userId, ...(kind === 'quote' ? { idempotency_key: ticket.idempotency_key || null } : {}) })
      .select()
      .single()
    if (error) throw error
    await sbSyncLines(kind, data.id, lines)
    const { data: saved } = await supabase.from(table).select().eq('id', data.id).single()
    return saved || data
  }
  // Existing ticket: revision snapshot first (quotes), then version check.
  const { data: current, error: curErr } = await supabase.from(table).select('*').eq('id', ticket.id).single()
  if (curErr) throw curErr
  if (current.version !== ticket.version) {
    throw new VersionConflict(
      `This ${kind} was changed by someone else (version ${current.version}, you had ${ticket.version}). Reload and re-apply your changes — nothing was overwritten.`
    )
  }
  if (kind === 'quote') {
    const { data: revs } = await supabase.from('quote_revisions').select('revision_no').eq('quote_id', ticket.id).order('revision_no', { ascending: false }).limit(1)
    const nextRev = (revs?.[0]?.revision_no || 0) + 1
    const { data: curLines } = await supabase.from('quote_lines').select('*').eq('quote_id', ticket.id)
    await supabase.from('quote_revisions').insert({
      quote_id: ticket.id,
      revision_no: nextRev,
      snapshot: { ...current, lines: curLines || [] },
      created_by: userId,
    })
  }
  const { data, error } = await supabase
    .from(table)
    .update(await upsertAndLink(header))
    .eq('id', ticket.id)
    .eq('version', ticket.version)
    .select()
    .single()
  if (error) throw error
  if (!data) throw new VersionConflict('Save conflict — this record changed since you opened it. Reload and try again.')
  await sbSyncLines(kind, data.id, lines)
  const { data: saved } = await supabase.from(table).select().eq('id', data.id).single()
  return saved || data
}

async function sbSetTicketStatus(kind, ticket, status, userId, extra = {}) {
  const table = ticketTable(kind)
  const { data: current, error: curErr } = await supabase.from(table).select('*').eq('id', ticket.id).single()
  if (curErr) throw curErr
  const patch = { status, ...extra }
  if (kind === 'invoice' && status === 'Paid') patch.balance_due = 0
  const { data, error } = await supabase.from(table).update(patch).eq('id', ticket.id).eq('version', current.version).select().single()
  if (error) throw error
  if (!data) throw new VersionConflict('Status change conflict — reload and try again.')
  return data
}

async function sbConvertQuoteToInvoice(quote, quoteLines, userId, state) {
  // Idempotent: if this quote was already converted, return the existing
  // invoice instead of creating another one.
  if (quote.converted_invoice_id) {
    const { data } = await supabase.from('invoices').select().eq('id', quote.converted_invoice_id).single()
    if (data) return data
  }
  const idempotencyKey = `convert:${quote.id}`
  const { data: existing } = await supabase.from('invoices').select().eq('idempotency_key', idempotencyKey).maybeSingle()
  if (existing) {
    await supabase.from('quotes').update({ converted_invoice_id: existing.id }).eq('id', quote.id)
    return existing
  }
  const issueDate = todayStr()
  const totals = computeTotals(quoteLines, state.settings?.tax_rate, quote.labor_lump)
  const number = await sbNextNumber('invoice')
  // The vehicle comes from the quote's ticket fields: upsert it into the
  // Vehicles directory and link the new invoice to that record.
  const convertedVehicle = await sbUpsertVehicleFromTicket(quote.customer_id, quote.vehicle_snapshot)
  const convertedSnapshot = convertedVehicle
    ? vehicleSnapshotFromFields(
        {
          vin: quote.vehicle_snapshot?.vin || '',
          year: quote.vehicle_snapshot?.year ?? '',
          make: quote.vehicle_snapshot?.make || '',
          model: quote.vehicle_snapshot?.model || '',
          bed_size: quote.vehicle_snapshot?.bed_size || '',
          fleet_unit: quote.vehicle_snapshot?.fleet_unit || '',
          color: quote.vehicle_snapshot?.color || '',
        },
        convertedVehicle.id
      ) || quote.vehicle_snapshot
    : quote.vehicle_snapshot
  const { data: invoice, error } = await supabase
    .from('invoices')
    .insert({
      number,
      idempotency_key: idempotencyKey,
      quote_id: quote.id,
      customer_id: quote.customer_id || null, // null = walk-in quote converts to a walk-in invoice
      vehicle_id: convertedVehicle?.id || quote.vehicle_id || null,
      // Multi-salesman (Nov 23): the conversion carries the whole
      // salesperson_ids array from the quote.
      salesperson_ids: (quote.salesperson_ids || []).filter(Boolean).length
        ? (quote.salesperson_ids || []).filter(Boolean)
        : (userId ? [userId] : []),
      created_by: userId,
      status: 'Draft',
      issue_date: issueDate,
      due_date: dueDateFor(issueDate, quote.payment_terms),
      po_number: quote.po_number || null,
      payment_terms: quote.payment_terms || 'Net 30',
      customer_notes: quote.customer_notes || null,
      internal_notes: quote.internal_notes || null,
      customer_snapshot: quote.customer_snapshot || null,
      vehicle_snapshot: convertedSnapshot || null,
      labor_lump: roundCents(Number(quote.labor_lump) || 0),
      subtotal: totals.subtotal,
      tax_total: totals.taxTotal,
      total: totals.total,
      balance_due: totals.total,
    })
    .select()
    .single()
  if (error) {
    // Retry / double-click race: the unique idempotency_key may have won
    // in a parallel request — fetch the winner instead of erroring.
    if (String(error.message || '').includes('idempotency_key') || error.code === '23505') {
      const { data: winner } = await supabase.from('invoices').select().eq('idempotency_key', idempotencyKey).maybeSingle()
      if (winner) {
        await supabase.from('quotes').update({ converted_invoice_id: winner.id }).eq('id', quote.id)
        return winner
      }
    }
    throw error
  }
  const payload = (quoteLines || []).map((line, i) => ({
    ...cleanLinePayload(line, invoice.id, 'invoice_id', i),
  }))
  if (payload.length) {
    const { error: lineErr } = await supabase.from('invoice_lines').insert(payload)
    if (lineErr) throw lineErr
  }
  await supabase.from('quotes').update({ converted_invoice_id: invoice.id }).eq('id', quote.id)
  return invoice
}

// --- Save a walk-in as a customer -------------------------------------------
// Bill's rule (Nov 18): a walk-in buyer can become a real customer so a
// repeat buyer has a history — every ticket they ever bought shows under
// them. Two call sites: (a) the ticket form, when "Save this person as a
// customer for next time" is checked on save; (b) a "Save as customer"
// button on an already-saved walk-in ticket.
// Create-or-link: a customer with the same phone (digits only) or email
// already on file is LINKED, never duplicated. A new customer gets the
// type chosen on the ticket (Retail / Fleet, default Retail), the walk-in
// name as the primary contact, and a note saying where it came from.
// The ticket is then linked (customer_id + a fresh snapshot built from the
// customer record, so it stops being a walk-in) and the ticket's vehicle,
// if it has no customer yet, is linked to the new customer too.
async function sbSaveWalkInAsCustomer(kind, ticket, customerType, userId) {
  if (!ticket || ticket.customer_id || !isWalkInTicket(ticket)) {
    throw new Error('This ticket already has a customer.')
  }
  const snap = ticket.customer_snapshot || {}
  const name = titleCaseName((snap.contact_name || snap.company || '').trim())
  if (!name) throw new Error('The walk-in ticket has no name to save as a customer.')
  const phone = (snap.phone || '').trim()
  const email = (snap.email || '').trim()
  const type = customerType === 'Fleet' ? 'Fleet' : 'Retail'
  const [customersRes, contactsRes] = await Promise.all([
    supabase.from('customers').select('id, company, customer_type, payment_terms, tax_exempt'),
    supabase.from('contacts').select('id, customer_id, name, phone, email'),
  ])
  if (customersRes.error) throw customersRes.error
  if (contactsRes.error) throw contactsRes.error
  const customers = customersRes.data || []
  const contacts = contactsRes.data || []
  let customer = findCustomerByPhoneOrEmail(customers, contacts, phone, email)
  let linkedExisting = false
  if (customer) {
    linkedExisting = true
  } else {
    customer = await sbSaveCustomer(
      {
        company: name,
        customer_type: type,
        tax_exempt: false,
        payment_terms: 'Net 30',
        po_requirements: '',
      },
      [{ name, phone: phone || null, email: email || null, title: '', is_primary: true }],
      []
    )
    // The old customers.notes box is gone — keep the "created from
    // walk-in" trail as the customer's first log entry instead. Best
    // effort: never fail the save over a note.
    try { await sbAddNote(customer.id, `Created from walk-in ${kind === 'quote' ? 'quote' : 'invoice'} ${ticket.number || ''} on ${todayStr()}.`, null) } catch (err) { /* informational only */ }
  }
  const snapshot = customerSnapshot(
    customer,
    [{ customer_id: customer.id, name, phone: phone || null, email: email || null, is_primary: true }],
    []
  )
  const table = ticketTable(kind)
  const { data: current, error: curErr } = await supabase.from(table).select('version').eq('id', ticket.id).single()
  if (curErr) throw curErr
  const { data: updated, error: updErr } = await supabase
    .from(table)
    .update({ customer_id: customer.id, customer_snapshot: snapshot })
    .eq('id', ticket.id)
    .eq('version', current.version)
    .select()
    .single()
  if (updErr) throw updErr
  if (!updated) throw new VersionConflict('This ticket changed since you opened it. Reload and try again.')
  // Link the ticket's vehicle to the new customer — only if it has no
  // customer yet (never steal a vehicle that belongs to someone else).
  if (ticket.vehicle_id) {
    const { data: veh } = await supabase.from('vehicles').select('id, customer_id').eq('id', ticket.vehicle_id).single()
    if (veh && !veh.customer_id) {
      await supabase.from('vehicles').update({ customer_id: customer.id }).eq('id', veh.id)
    }
  }
  return { customer, ticket: updated, linkedExisting }
}

function localSaveWalkInAsCustomer(kind, ticket, customerType) {
  if (!ticket || ticket.customer_id || !isWalkInTicket(ticket)) {
    throw new Error('This ticket already has a customer.')
  }
  const snap = ticket.customer_snapshot || {}
  const name = titleCaseName((snap.contact_name || snap.company || '').trim())
  if (!name) throw new Error('The walk-in ticket has no name to save as a customer.')
  const phone = (snap.phone || '').trim()
  const email = (snap.email || '').trim()
  const type = customerType === 'Fleet' ? 'Fleet' : 'Retail'
  const customers = lsRead(LS_CUSTOMERS, [])
  // Local mode stores no contacts, so match on the company name (a
  // walk-in-created customer has company = the buyer's name).
  let customer = customers.find((c) => String(c.company || '').trim().toLowerCase() === name.toLowerCase()) || null
  let linkedExisting = false
  const now = new Date().toISOString()
  if (customer) {
    linkedExisting = true
  } else {
    customer = {
      id: uid(), company: name, customer_type: type, tax_exempt: false,
      payment_terms: 'Net 30',
      version: 1, created_at: now, updated_at: now,
    }
    lsWrite(LS_CUSTOMERS, [customer, ...customers])
    // The old customers.notes box is gone — keep the "created from
    // walk-in" trail as the customer's first log entry instead.
    try { localAddNote(customer.id, `Created from walk-in ${kind === 'quote' ? 'quote' : 'invoice'} ${ticket.number || ''} on ${todayStr()}.`, null) } catch (err) { /* informational only */ }
  }
  const snapshot = {
    company: customer.company, contact_name: name, phone: formatPhone(phone) || null,
    email: email || null, address: null, payment_terms: customer.payment_terms,
    tax_exempt: !!customer.tax_exempt,
  }
  const key = kind === 'quote' ? LS_QUOTES : LS_INVOICES
  const rows = lsRead(key, [])
  const idx = rows.findIndex((r) => r.id === ticket.id)
  if (idx < 0) throw new Error('Ticket not found in local mode.')
  const updated = { ...rows[idx], customer_id: customer.id, customer_snapshot: snapshot, version: (rows[idx].version || 1) + 1, updated_at: now }
  rows[idx] = updated
  lsWrite(key, rows)
  if (ticket.vehicle_id) {
    const vehicles = lsRead(LS_VEHICLES, [])
    const vi = vehicles.findIndex((v) => v.id === ticket.vehicle_id)
    if (vi >= 0 && !vehicles[vi].customer_id) {
      vehicles[vi] = { ...vehicles[vi], customer_id: customer.id }
      lsWrite(LS_VEHICLES, vehicles)
    }
  }
  return { customer, ticket: updated, linkedExisting }
}

async function sbSaveProduct(product, isAdmin, userId) {
  // Shared catalog (Nov 19, migration 017): ANY active user may add/edit
  // products and services, including cost. Delete stays Admin-only (see
  // deleteProduct below + RLS). Cost lives in product_costs and is upserted
  // after the product row exists — if that upsert fails (e.g. pre-migration
  // 017, when product_costs is still Admin-only RLS for Sales), the save
  // throws rather than silently dropping the cost.
  const payload = {
    part_number: (product.part_number || '').trim() || null,
    name: (product.name || '').trim(),
    description: (product.description || '').trim() || null,
    default_price: Number(product.default_price) || 0,
    taxable: !!product.taxable,
    type: product.type || 'part',
    active: product.active !== false,
  }
  let data
  if (product.id) {
    const { data: updated, error } = await supabase.from('products').update(payload).eq('id', product.id).eq('version', product.version).select().single()
    if (error) throw error
    data = updated
  } else {
    const { data: inserted, error } = await supabase.from('products').insert(payload).select().single()
    if (error) throw error
    data = inserted
  }
  const { error: costErr } = await supabase.from('product_costs').upsert({
    product_id: data.id,
    cost: Number(product.cost) || 0,
    updated_by: userId || null,
  })
  if (costErr) throw costErr
  return { ...data, cost: Number(product.cost) || 0 }
}

// --- Local mode -------------------------------------------------------------

const LS_QUOTES = 'po_ops_quotes_v1'
const LS_INVOICES = 'po_ops_invoices_v1'
const LS_PRODUCTS = 'po_ops_products_v1'

function localLoad() {
  return {
    customers: lsRead(LS_CUSTOMERS, []),
    contacts: [],
    addresses: [],
    vehicles: lsRead(LS_VEHICLES, []),
    quotes: lsRead(LS_QUOTES, []),
    invoices: lsRead(LS_INVOICES, []),
    quoteLines: lsRead(LS_QUOTES, []).flatMap((q) => (q.lines || []).map((l) => ({ ...l, quote_id: q.id }))),
    invoiceLines: lsRead(LS_INVOICES, []).flatMap((i) => (i.lines || []).map((l) => ({ ...l, invoice_id: i.id }))),
    products: lsRead(LS_PRODUCTS, []),
    profiles: [],
    settings: { tax_rate: 0.0774, default_payment_terms: 'Net 30', quote_validity_days: 15, company_name: 'Pickup Outfitters' },
  }
}

// Admin renumber input: "105" -> "INV-105", "inv-105" -> "INV-105",
// "INV-105" stays. Anything else (letters, a QT- prefix, a blank) is
// rejected with a plain-language error before anything is written.
export function normalizeInvoiceNumber(input) {
  const raw = String(input || '').trim().toUpperCase().replace(/\s+/g, '')
  if (!raw) throw new Error('Enter a new invoice number.')
  const digits = /^\d+$/.test(raw) ? raw : /^INV-?(\d+)$/.exec(raw)?.[1]
  if (!digits) throw new Error('Enter a number like INV-105, or just the digits (105).')
  return `INV-${parseInt(digits, 10)}`
}

// Local-mode renumber: same rules as the server function — Admin-only is
// enforced by the caller, duplicate target is refused, the old number is
// kept in previous_numbers (searchable). The local next-number counter
// derives from the highest number already in use, so a manual number can
// never collide with a later automatic one.
function localRenameInvoice(id, target) {
  const rows = lsRead(LS_INVOICES, [])
  const idx = rows.findIndex((r) => r.id === id)
  if (idx < 0) throw new Error('Invoice not found.')
  const current = rows[idx]
  if (current.number === target) return current
  if (rows.some((r) => r.id !== id && r.number === target)) {
    throw new Error(`${target} is already used by another invoice.`)
  }
  rows[idx] = {
    ...current,
    number: target,
    previous_numbers: [...(current.previous_numbers || []), current.number],
  }
  lsWrite(LS_INVOICES, rows)
  return rows[idx]
}

function localNextNumber(kind) {
  // Local mode mirrors the separate server sequences: quotes draw from
  // their own counter (QT-A…), invoices from their own (INV-…), each
  // seeded after the highest numeric suffix already used by that kind
  // (or 1001 if there are no tickets of that kind yet). The two systems
  // are independent, so a quote and an invoice may share a numeric part.
  const rows = lsRead(kind === 'quote' ? LS_QUOTES : LS_INVOICES, [])
  const maxNum = rows.reduce((m, t) => {
    const n = parseInt(String(t.number || '').replace(/[^0-9]/g, ''), 10)
    return Number.isFinite(n) ? Math.max(m, n) : m
  }, 1000)
  return maxNum + 1
}

function localSaveTicket(kind, ticket, lines, userId) {
  const key = kind === 'quote' ? LS_QUOTES : LS_INVOICES
  const rows = lsRead(key, [])
  const totals = computeTotals(lines, ticket.tax_rate, ticket.labor_lump)
  // Vehicle upsert from the ticket's own VIN/YMM, same as Supabase mode.
  const localVehicle = localUpsertVehicleFromTicket(ticket.customer_id, ticket.vehicle_snapshot)
  const saved = {
    ...ticket,
    // Multi-salesman (Nov 23): keep the whole array; an empty array falls
    // back to the current user so a ticket always has a salesperson.
    salesperson_ids: (ticket.salesperson_ids || []).filter(Boolean).length
      ? (ticket.salesperson_ids || []).filter(Boolean)
      : (userId ? [userId] : []),
    vehicle_id: localVehicle?.id || ticket.vehicle_id || null,
    vehicle_snapshot: localVehicle
      ? vehicleSnapshotFromFields(
          {
            vin: ticket.vehicle_snapshot?.vin || '',
            year: ticket.vehicle_snapshot?.year ?? '',
            make: ticket.vehicle_snapshot?.make || '',
            model: ticket.vehicle_snapshot?.model || '',
            bed_size: ticket.vehicle_snapshot?.bed_size || '',
            fleet_unit: ticket.vehicle_snapshot?.fleet_unit || '',
            color: ticket.vehicle_snapshot?.color || '',
              },
          localVehicle.id
        ) || ticket.vehicle_snapshot
      : ticket.vehicle_snapshot,
    lines: (lines || []).map((l, i) => ({ ...l, id: l.id || uid(), line_total: lineTotal(l), sort_order: i })),
    subtotal: totals.subtotal,
    tax_total: totals.taxTotal,
    total: totals.total,
    version: (ticket.version || 0) + 1,
    updated_at: new Date().toISOString(),
  }
  // Phase 3 payments (local mirror of sbSaveTicket): balance and status
  // follow the payments — Draft / Void untouched. A new invoice has no
  // payments yet, so paid is 0 and the balance is the full total.
  if (kind === 'invoice') {
    const paidSoFar = ticket.id
      ? roundCents(localListPayments(ticket.id).reduce((s, p) => s + (Number(p.amount) || 0), 0))
      : 0
    const derived = deriveInvoiceBalance(totals.total, paidSoFar, saved.status)
    saved.balance_due = derived.balanceDue
    saved.status = derived.status
  }
  if (!saved.id) {
    saved.id = uid()
    saved.number = `${kind === 'quote' ? 'QT-A' : 'INV-'}${localNextNumber(kind)}`
    saved.created_by = userId
    saved.created_at = saved.updated_at
    rows.unshift(saved)
  } else {
    const idx = rows.findIndex((r) => r.id === saved.id)
    if (idx < 0) throw new Error('Ticket not found in local mode.')
    if (rows[idx].version !== ticket.version) {
      throw new VersionConflict('This ticket was changed by someone else. Reload and try again.')
    }
    rows[idx] = { ...rows[idx], ...saved }
  }
  lsWrite(key, rows)
  return saved
}

// --- Deep global search ----------------------------------------------------
// Searches INSIDE quotes and invoices, not just their titles:
//  - VIN full / last 6 / last 8 — via the vehicles table AND via the
//    vehicle_snapshot stored on each ticket (so a ticket still matches
//    after the vehicle record is edited or deleted).
//  - Part number and description text in quote_lines / invoice_lines.
//  - Customer/company, contact, phone, email.
//  - Quote number, invoice number, previous_numbers, PO number, fleet/unit.
// Returns unified ticket previews: { type, ticket, customer, vin, match }.
// Filters (applied client-side on the matched set): date range, salesperson,
// customer, record type, status. No costs, margins, or payments are ever
// returned here — search only reads the same Sales-visible tables.
export async function globalSearch(query, state, filters = {}) {
  const q = String(query || '').trim()
  const lower = q.toLowerCase()
  const vin = normalizeVin(q)
  const vinTail6 = vin.length >= 6 ? vin.slice(-6) : ''
  const vinTail8 = vin.length >= 8 ? vin.slice(-8) : ''
  const vinMatches = (candidate) => {
    const n = normalizeVin(candidate)
    if (!n || !vin) return false
    return n.includes(vin) || (vinTail6 && n.endsWith(vinTail6)) || (vinTail8 && n.endsWith(vinTail8))
  }
  // Walk-in tickets have no customer record — their name lives in the
  // snapshot, so the display name comes from the ticket itself.
  const customerName = (t) => ticketCustomerName(t, state.customers)
  const vehicleFor = (id) => state.vehicles.find((v) => v.id === id) || null
  const ticketVin = (t) => t.vehicle_snapshot?.vin || vehicleFor(t.vehicle_id)?.vin || ''
  const salespersonNames = (t) => (t.salesperson_ids || [])
    .map((id) => state.profiles?.find((p) => p.id === id)?.name || '')
    .filter(Boolean).join(', ')
  // Profiles whose name matches the query — searching a salesperson's
  // name finds their tickets (any of a ticket's salespeople counts).
  const matchedSalespersonIds = lower
    ? new Set((state.profiles || []).filter((p) => String(p.name || '').toLowerCase().includes(lower)).map((p) => p.id))
    : new Set()
  const isSalespersonMatch = (t) => (t.salesperson_ids || []).some((id) => matchedSalespersonIds.has(id))
  // Does the query match a walk-in ticket's snapshot name / phone?
  const walkInMatches = (t) => {
    if (!isWalkInTicket(t) || !lower) return false
    const s = t.customer_snapshot || {}
    // The phone compares on digits, so typing 3148920032 finds a stored
    // (314) 892-0032; names and email compare as plain text.
    if (phoneMatches(q, s.phone)) return true
    return [s.contact_name, s.company, s.email]
      .some((f) => String(f || '').toLowerCase().includes(lower))
  }

  // Local mode: everything is already in state — filter it the same way.
  if (!supabaseConfigured) {
    const customers = state.customers.filter((c) =>
      c.company.toLowerCase().includes(lower) &&
      (!filters.customerType || customerTypeOf(c) === filters.customerType)
    )
    // A customer-name match must also pull that customer's tickets and
    // vehicles — otherwise searching a customer shows the customer but
    // none of their quotes, invoices, or vehicles.
    const matchedCustomerIds = new Set(customers.map((c) => c.id))
    const vehicles = state.vehicles.filter((v) =>
      vinMatches(v.vin) ||
      String(v.fleet_unit || '').toLowerCase().includes(lower) ||
      String(v.bed_size || '').toLowerCase().includes(lower) ||
      String(v.color || '').toLowerCase().includes(lower) ||
      matchedCustomerIds.has(v.customer_id)
    )
    const tickets = []
    const pushTicket = (type, t, match) => tickets.push({ type, ticket: t, customer: customerName(t), vin: ticketVin(t), salesperson: salespersonNames(t), match })
    for (const t of state.quotes) {
      const lines = (t.lines || []).filter((l) => String(l.description || '').toLowerCase().includes(lower) || String(l.part_number || '').toLowerCase().includes(lower))
      if (vinMatches(ticketVin(t))) pushTicket('quote', t, 'VIN')
      else if (t.customer_id && matchedCustomerIds.has(t.customer_id)) pushTicket('quote', t, 'Customer')
      else if (isSalespersonMatch(t)) pushTicket('quote', t, 'Salesperson')
      else if (walkInMatches(t)) pushTicket('quote', t, 'Walk-in name / phone')
      else if (lines.length) pushTicket('quote', t, `Line item: ${lines[0].description}`)
      else if (String(t.number || '').toLowerCase().includes(lower) || String(t.po_number || '').toLowerCase().includes(lower)) pushTicket('quote', t, 'Number / PO')
    }
    for (const t of state.invoices) {
      const lines = (t.lines || []).filter((l) => String(l.description || '').toLowerCase().includes(lower) || String(l.part_number || '').toLowerCase().includes(lower))
      if (vinMatches(ticketVin(t))) pushTicket('invoice', t, 'VIN')
      else if (t.customer_id && matchedCustomerIds.has(t.customer_id)) pushTicket('invoice', t, 'Customer')
      else if (isSalespersonMatch(t)) pushTicket('invoice', t, 'Salesperson')
      else if (walkInMatches(t)) pushTicket('invoice', t, 'Walk-in name / phone')
      else if (lines.length) pushTicket('invoice', t, `Line item: ${lines[0].description}`)
      else if (String(t.number || '').toLowerCase().includes(lower) || String(t.po_number || '').toLowerCase().includes(lower) || (t.previous_numbers || []).some((n) => String(n).toLowerCase().includes(lower))) pushTicket('invoice', t, 'Number / PO')
    }
    return { customers, vehicles, tickets: applyTicketFilters(tickets, filters), contacts: [] }
  }

  const like = `%${q}%`
  const customersQuery = supabase.from('customers').select('*').ilike('company', like)
  if (filters.customerType) customersQuery.eq('customer_type', filters.customerType)
  const [customers, contacts, vehicles, quotes, invoices, qLines, iLines] = await Promise.all([
    customersQuery.limit(20),
    supabase.from('contacts').select('*').or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like}`).limit(20),
    supabase.from('vehicles').select('*').or(`vin_normalized.ilike.${like},fleet_unit.ilike.${like},bed_size.ilike.${like},color.ilike.${like}`).limit(20),
    supabase.from('quotes').select('*').or(`number.ilike.${like},po_number.ilike.${like}`).limit(20),
    supabase.from('invoices').select('*').or(`number.ilike.${like},po_number.ilike.${like}`).limit(20),
    supabase.from('quote_lines').select('*').or(`description.ilike.${like},part_number.ilike.${like}`).limit(20),
    supabase.from('invoice_lines').select('*').or(`description.ilike.${like},part_number.ilike.${like}`).limit(20),
  ])
  // Digits search: a stored phone is formatted — (314) 892-0032 — so an
  // ilike for 3148920032 never matches it. When the query holds at least
  // an area code's worth of digits, pull contacts by area code and keep
  // the ones whose digits contain the typed digits.
  let allContacts = contacts.data || []
  const queryDigits = q.replace(/[^0-9]/g, '')
  if (queryDigits.length >= 3) {
    const { data: byArea } = await supabase.from('contacts').select('*').ilike('phone', `%${queryDigits.slice(0, 3)}%`).limit(50)
    const seenContactIds = new Set(allContacts.map((c) => c.id))
    for (const c of byArea || []) {
      if (!seenContactIds.has(c.id) && phoneMatches(q, c.phone)) { seenContactIds.add(c.id); allContacts.push(c) }
    }
  }
  // VIN suffix: fetch vehicles whose normalized VIN ends with the tail.
  let vehicleRows = vehicles.data || []
  if (vinTail8) {
    const { data } = await supabase.from('vehicles').select('*').ilike('vin_normalized', `%${vinTail8}`).limit(20)
    const seen = new Set(vehicleRows.map((v) => v.id))
    for (const v of data || []) if (!seen.has(v.id)) vehicleRows.push(v)
  }
  // Tickets for the matched vehicles, plus tickets whose snapshot VIN matches
  // (a bounded recent fetch, filtered client-side — shop-scale pragmatic).
  const vehicleIds = new Set(vehicleRows.map((v) => v.id))
  const ticketById = new Map()
  const tickets = []
  const pushTicket = (type, t, match) => {
    if (!t || ticketById.has(`${type}:${t.id}`)) return
    ticketById.set(`${type}:${t.id}`, true)
    tickets.push({ type, ticket: t, customer: customerName(t), vin: ticketVin(t), salesperson: salespersonNames(t), match })
  }
  for (const t of quotes.data || []) pushTicket('quote', t, 'Number / PO')
  for (const t of invoices.data || []) pushTicket('invoice', t, 'Number / PO')
  // Previous invoice numbers (array column — PostgREST can't ilike an array,
  // so scan the recent invoices client-side).
  if (q) {
    const { data: recentInv } = await supabase.from('invoices').select('*').order('created_at', { ascending: false }).limit(200)
    for (const t of recentInv || []) {
      if ((t.previous_numbers || []).some((n) => String(n).toLowerCase().includes(lower))) pushTicket('invoice', t, 'Previous invoice number')
      if (vinMatches(t.vehicle_snapshot?.vin)) pushTicket('invoice', t, 'VIN')
      if (walkInMatches(t)) pushTicket('invoice', t, 'Walk-in name / phone')
    }
    const { data: recentQ } = await supabase.from('quotes').select('*').order('created_at', { ascending: false }).limit(200)
    for (const t of recentQ || []) {
      if (vinMatches(t.vehicle_snapshot?.vin)) pushTicket('quote', t, 'VIN')
      if (walkInMatches(t)) pushTicket('quote', t, 'Walk-in name / phone')
    }
  }
  // Line-item matches -> parent tickets.
  const lineParentIds = { quote: new Set(), invoice: new Set() }
  for (const l of qLines.data || []) lineParentIds.quote.add(l.quote_id)
  for (const l of iLines.data || []) lineParentIds.invoice.add(l.invoice_id)
  if (lineParentIds.quote.size) {
    const { data } = await supabase.from('quotes').select('*').in('id', [...lineParentIds.quote])
    for (const t of data || []) pushTicket('quote', t, 'Line item')
  }
  if (lineParentIds.invoice.size) {
    const { data } = await supabase.from('invoices').select('*').in('id', [...lineParentIds.invoice])
    for (const t of data || []) pushTicket('invoice', t, 'Line item')
  }
  // Vehicle matches -> tickets for those vehicles.
  if (vehicleIds.size) {
    const { data: qByVeh } = await supabase.from('quotes').select('*').in('vehicle_id', [...vehicleIds])
    for (const t of qByVeh || []) pushTicket('quote', t, 'VIN')
    const { data: iByVeh } = await supabase.from('invoices').select('*').in('vehicle_id', [...vehicleIds])
    for (const t of iByVeh || []) pushTicket('invoice', t, 'VIN')
  }
  // Contact matches -> their customer's tickets.
  const contactCustomerIds = new Set(allContacts.map((c) => c.customer_id))
  if (contactCustomerIds.size) {
    const { data: qByCust } = await supabase.from('quotes').select('*').in('customer_id', [...contactCustomerIds]).limit(20)
    for (const t of qByCust || []) pushTicket('quote', t, 'Contact')
    const { data: iByCust } = await supabase.from('invoices').select('*').in('customer_id', [...contactCustomerIds]).limit(20)
    for (const t of iByCust || []) pushTicket('invoice', t, 'Contact')
  }
  // Customer-name matches -> that customer's tickets and vehicles. This
  // was missing: searching a customer showed the customer but none of
  // their quotes, invoices, or vehicles.
  const matchedCustomerIds = (customers.data || []).map((c) => c.id)
  if (matchedCustomerIds.length) {
    const { data: qByCust } = await supabase.from('quotes').select('*').in('customer_id', matchedCustomerIds).limit(20)
    for (const t of qByCust || []) pushTicket('quote', t, 'Customer')
    const { data: iByCust } = await supabase.from('invoices').select('*').in('customer_id', matchedCustomerIds).limit(20)
    for (const t of iByCust || []) pushTicket('invoice', t, 'Customer')
    const { data: vByCust } = await supabase.from('vehicles').select('*').in('customer_id', matchedCustomerIds).limit(20)
    const seenVeh = new Set(vehicleRows.map((v) => v.id))
    for (const v of vByCust || []) if (!seenVeh.has(v.id)) vehicleRows.push(v)
  }
  // Salesperson-name matches -> that salesperson's tickets. Any of a
  // ticket's salespeople counts. Best effort: pre-migration 018 the
  // column doesn't exist yet, so the query fails and this match type is
  // just skipped — the rest of the search still works.
  if (matchedSalespersonIds.size) {
    for (const spId of matchedSalespersonIds) {
      try {
        const { data: qBySp } = await supabase.from('quotes').select('*').contains('salesperson_ids', [spId])
        for (const t of qBySp || []) pushTicket('quote', t, 'Salesperson')
        const { data: iBySp } = await supabase.from('invoices').select('*').contains('salesperson_ids', [spId])
        for (const t of iBySp || []) pushTicket('invoice', t, 'Salesperson')
      } catch { /* pre-migration: no salesperson_ids column yet */ }
    }
  }
  return {
    customers: customers.data || [],
    contacts: allContacts,
    vehicles: vehicleRows,
    tickets: applyTicketFilters(tickets, filters),
  }
}

function applyTicketFilters(tickets, filters = {}) {
  return (tickets || []).filter((r) => {
    const t = r.ticket
    if (filters.type && r.type !== filters.type) return false
    if (filters.status && t.status !== filters.status) return false
    if (filters.customerId === 'walk-in' && t.customer_id) return false
    if (filters.customerId && filters.customerId !== 'walk-in' && t.customer_id !== filters.customerId) return false
    if (filters.salespersonId && !(t.salesperson_ids || []).includes(filters.salespersonId)) return false
    const d = t.issue_date || (t.created_at || '').slice(0, 10)
    if (filters.from && d < filters.from) return false
    if (filters.to && d > filters.to) return false
    return true
  })
}

// --- Public API -------------------------------------------------------------
// --- Customer photos (mini-CRM) -------------------------------------------
// Files live in the private 'customer-photos' Storage bucket; Postgres
// holds only metadata. Photos are shown via 1-hour signed URLs — the
// bucket is never public.
const PHOTO_BUCKET = 'customer-photos'
const MAX_PHOTO_BYTES = 5 * 1024 * 1024 // 5 MB per file

async function sbListPhotos(customerId) {
  const { data, error } = await supabase
    .from('customer_photos')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
  if (error) throw error
  const rows = data || []
  const withUrls = await Promise.all(rows.map(async (r) => {
    const { data: signed, error: signErr } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrl(r.storage_path, 3600)
    return { ...r, signedUrl: signErr ? '' : signed?.signedUrl || '' }
  }))
  return withUrls
}

function sanitizeFileName(name) {
  return (name || 'photo').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100)
}

async function sbUploadPhoto(customerId, file, caption, userId) {
  if (!file?.type?.startsWith('image/')) throw new Error('Only image files can be uploaded.')
  if (file.size > MAX_PHOTO_BYTES) throw new Error('That file is over the 5 MB limit — pick a smaller image.')
  const path = `${customerId}/${uid()}-${sanitizeFileName(file.name)}`
  const { error: upErr } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(path, file, { contentType: file.type })
  if (upErr) throw upErr
  const { data, error } = await supabase
    .from('customer_photos')
    .insert({
      customer_id: customerId,
      storage_path: path,
      file_name: file.name,
      caption: (caption || '').trim() || null,
      created_by: userId || null,
    })
    .select()
    .single()
  if (error) {
    // Don't leave an orphaned file in the bucket if the row insert failed.
    await supabase.storage.from(PHOTO_BUCKET).remove([path])
    throw error
  }
  const { data: signed } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrl(path, 3600)
  return { ...data, signedUrl: signed?.signedUrl || '' }
}

async function sbDeletePhoto(photo) {
  if (photo?.storage_path) {
    await supabase.storage.from(PHOTO_BUCKET).remove([photo.storage_path])
  }
  const { error } = await supabase.from('customer_photos').delete().eq('id', photo.id)
  if (error) throw error
}

// --- Customer notes log (mini-CRM) ---
// Dated running log on a customer record, newest first. The old single
// customers.notes box was replaced by this log (migration 014).
async function sbListNotes(customerId) {
  const { data, error } = await supabase
    .from('customer_notes')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

async function sbAddNote(customerId, body, userId) {
  const text = (body || '').trim()
  if (!text) throw new Error('Write the note first.')
  const { data, error } = await supabase
    .from('customer_notes')
    .insert({ customer_id: customerId, body: text, created_by: userId || null })
    .select()
    .single()
  if (error) throw error
  return data
}

async function sbDeleteNote(noteId) {
  const { error } = await supabase.from('customer_notes').delete().eq('id', noteId)
  if (error) throw error
}

function localListNotes(customerId) {
  return lsRead(LS_CUSTOMER_NOTES, [])
    .filter((n) => n.customer_id === customerId)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
}

function localAddNote(customerId, body, userId) {
  const text = (body || '').trim()
  if (!text) throw new Error('Write the note first.')
  const note = { id: uid(), customer_id: customerId, body: text, created_by: userId || null, created_at: new Date().toISOString() }
  lsWrite(LS_CUSTOMER_NOTES, [note, ...lsRead(LS_CUSTOMER_NOTES, [])])
  return note
}

function localDeleteNote(noteId) {
  lsWrite(LS_CUSTOMER_NOTES, lsRead(LS_CUSTOMER_NOTES, []).filter((n) => n.id !== noteId))
}

// --- Product notes log (shared catalog) ---
// Dated running log on a product/service record, newest first — same shape
// and rules as customer notes. Any active user may add/delete a note.
async function sbListProductNotes(productId) {
  const { data, error } = await supabase
    .from('product_notes')
    .select('*')
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

async function sbAddProductNote(productId, body, userId) {
  const text = (body || '').trim()
  if (!text) throw new Error('Write the note first.')
  const { data, error } = await supabase
    .from('product_notes')
    .insert({ product_id: productId, body: text, created_by: userId || null })
    .select()
    .single()
  if (error) throw error
  return data
}

async function sbDeleteProductNote(noteId) {
  const { error } = await supabase.from('product_notes').delete().eq('id', noteId)
  if (error) throw error
}

function localListProductNotes(productId) {
  return lsRead(LS_PRODUCT_NOTES, [])
    .filter((n) => n.product_id === productId)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
}

function localAddProductNote(productId, body, userId) {
  const text = (body || '').trim()
  if (!text) throw new Error('Write the note first.')
  const note = { id: uid(), product_id: productId, body: text, created_by: userId || null, created_at: new Date().toISOString() }
  lsWrite(LS_PRODUCT_NOTES, [note, ...lsRead(LS_PRODUCT_NOTES, [])])
  return note
}

function localDeleteProductNote(noteId) {
  lsWrite(LS_PRODUCT_NOTES, lsRead(LS_PRODUCT_NOTES, []).filter((n) => n.id !== noteId))
}

// --- Product photos (shared catalog) ---
// Files live in the private 'product-photos' Storage bucket; Postgres
// holds only metadata. Photos are shown via 1-hour signed URLs — the
// bucket is never public. Same shape and rules as customer photos.
const PRODUCT_PHOTO_BUCKET = 'product-photos'

async function sbListProductPhotos(productId) {
  const { data, error } = await supabase
    .from('product_photos')
    .select('*')
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
  if (error) throw error
  const rows = data || []
  const withUrls = await Promise.all(rows.map(async (r) => {
    const { data: signed, error: signErr } = await supabase.storage
      .from(PRODUCT_PHOTO_BUCKET)
      .createSignedUrl(r.storage_path, 3600)
    return { ...r, signedUrl: signErr ? '' : signed?.signedUrl || '' }
  }))
  return withUrls
}

async function sbUploadProductPhoto(productId, file, caption, userId) {
  if (!file?.type?.startsWith('image/')) throw new Error('Only image files can be uploaded.')
  if (file.size > MAX_PHOTO_BYTES) throw new Error('That file is over the 5 MB limit — pick a smaller image.')
  const path = `${productId}/${uid()}-${sanitizeFileName(file.name)}`
  const { error: upErr } = await supabase.storage
    .from(PRODUCT_PHOTO_BUCKET)
    .upload(path, file, { contentType: file.type })
  if (upErr) throw upErr
  const { data, error } = await supabase
    .from('product_photos')
    .insert({
      product_id: productId,
      storage_path: path,
      file_name: file.name,
      caption: (caption || '').trim() || null,
      created_by: userId || null,
    })
    .select()
    .single()
  if (error) {
    // Don't leave an orphaned file in the bucket if the row insert failed.
    await supabase.storage.from(PRODUCT_PHOTO_BUCKET).remove([path])
    throw error
  }
  const { data: signed } = await supabase.storage
    .from(PRODUCT_PHOTO_BUCKET)
    .createSignedUrl(path, 3600)
  return { ...data, signedUrl: signed?.signedUrl || '' }
}

async function sbDeleteProductPhoto(photo) {
  if (photo?.storage_path) {
    await supabase.storage.from(PRODUCT_PHOTO_BUCKET).remove([photo.storage_path])
  }
  const { error } = await supabase.from('product_photos').delete().eq('id', photo.id)
  if (error) throw error
}

// --- Invoice payments (Phase 3, payments piece) ----------------------------
// A deposit is just a payment: an invoice takes as many partial payments
// as the customer makes, each one lowering the balance. balance_due and
// status are derived from the payments (deriveInvoiceBalance) — Draft and
// Void are never touched by that logic. Record is any active user; delete
// is Admin-only (enforced here AND by RLS).
async function sbListPayments(invoiceId) {
  const { data, error } = await supabase
    .from('invoice_payments')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('payment_date', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// Which invoices have at least one payment — one query for the Invoices
// list "Deposit due" pill. Returns the raw rows (invoice_id only is
// enough for the pill); callers aggregate.
async function sbListPaymentsForInvoices(invoiceIds) {
  if (!invoiceIds?.length) return []
  const { data, error } = await supabase
    .from('invoice_payments')
    .select('invoice_id')
    .in('invoice_id', invoiceIds)
  if (error) throw error
  return data || []
}

// Re-read the invoice + its payments and write back the derived balance
// and status. Returns the updated invoice row. The invoice_guard trigger
// still applies: a Sales user can only move an invoice that isn't already
// Paid / Void / closed — which is exactly the states payments move
// between (Issued <-> Partially Paid <-> Paid).
async function sbRecomputeInvoiceBalance(invoiceId) {
  const { data: inv, error: invErr } = await supabase
    .from('invoices')
    .select('id, total, status, balance_due')
    .eq('id', invoiceId)
    .single()
  if (invErr) throw invErr
  const { data: pays, error: payErr } = await supabase
    .from('invoice_payments')
    .select('amount')
    .eq('invoice_id', invoiceId)
  if (payErr) throw payErr
  const paid = roundCents((pays || []).reduce((s, p) => s + (Number(p.amount) || 0), 0))
  const derived = deriveInvoiceBalance(inv.total, paid, inv.status)
  const { data: updated, error: updErr } = await supabase
    .from('invoices')
    .update({ balance_due: derived.balanceDue, status: derived.status })
    .eq('id', invoiceId)
    .select()
    .single()
  if (updErr) throw updErr
  return updated
}

async function sbRecordPayment(invoiceId, fields, userId) {
  const amount = roundCents(Number(fields?.amount) || 0)
  if (!(amount > 0)) throw new Error('Enter a payment amount greater than $0.')
  const { data, error } = await supabase
    .from('invoice_payments')
    .insert({
      invoice_id: invoiceId,
      amount,
      payment_date: fields.payment_date || todayStr(),
      method: fields.method || 'Cash',
      reference: (fields.reference || '').trim() || null,
      note: (fields.note || '').trim() || null,
      created_by: userId || null,
    })
    .select()
    .single()
  if (error) throw error
  const invoice = await sbRecomputeInvoiceBalance(invoiceId)
  return { payment: data, invoice }
}

async function sbDeletePayment(paymentId, isAdmin) {
  if (!isAdmin) throw new Error('Only an Admin can delete a payment.')
  const { data: pay, error: payErr } = await supabase
    .from('invoice_payments')
    .select('invoice_id')
    .eq('id', paymentId)
    .single()
  if (payErr || !pay) throw new Error('Payment not found.')
  const { error } = await supabase.from('invoice_payments').delete().eq('id', paymentId)
  if (error) throw error
  const invoice = await sbRecomputeInvoiceBalance(pay.invoice_id)
  return { invoice }
}

function localListPayments(invoiceId) {
  return lsRead(LS_INVOICE_PAYMENTS, [])
    .filter((p) => p.invoice_id === invoiceId)
    .sort((a, b) =>
      String(b.payment_date || '').localeCompare(String(a.payment_date || '')) ||
      String(b.created_at || '').localeCompare(String(a.created_at || ''))
    )
}

function localListPaymentsForInvoices(invoiceIds) {
  if (!invoiceIds?.length) return []
  const set = new Set(invoiceIds)
  return lsRead(LS_INVOICE_PAYMENTS, [])
    .filter((p) => set.has(p.invoice_id))
    .map((p) => ({ invoice_id: p.invoice_id }))
}

function localRecomputeInvoiceBalance(invoiceId) {
  const rows = lsRead(LS_INVOICES, [])
  const idx = rows.findIndex((r) => r.id === invoiceId)
  if (idx < 0) throw new Error('Invoice not found in local mode.')
  const inv = rows[idx]
  const paid = roundCents(localListPayments(invoiceId).reduce((s, p) => s + (Number(p.amount) || 0), 0))
  const derived = deriveInvoiceBalance(inv.total, paid, inv.status)
  const next = { ...inv, balance_due: derived.balanceDue, status: derived.status, version: (inv.version || 1) + 1, updated_at: new Date().toISOString() }
  rows[idx] = next
  lsWrite(LS_INVOICES, rows)
  return next
}

function localRecordPayment(invoiceId, fields, userId) {
  const amount = roundCents(Number(fields?.amount) || 0)
  if (!(amount > 0)) throw new Error('Enter a payment amount greater than $0.')
  const payment = {
    id: uid(),
    invoice_id: invoiceId,
    amount,
    payment_date: fields.payment_date || todayStr(),
    method: fields.method || 'Cash',
    reference: (fields.reference || '').trim() || null,
    note: (fields.note || '').trim() || null,
    created_by: userId || null,
    created_at: new Date().toISOString(),
  }
  lsWrite(LS_INVOICE_PAYMENTS, [payment, ...lsRead(LS_INVOICE_PAYMENTS, [])])
  const invoice = localRecomputeInvoiceBalance(invoiceId)
  return { payment, invoice }
}

function localDeletePayment(paymentId, isAdmin) {
  if (!isAdmin) throw new Error('Only an Admin can delete a payment.')
  const rows = lsRead(LS_INVOICE_PAYMENTS, [])
  const pay = rows.find((p) => p.id === paymentId)
  if (!pay) throw new Error('Payment not found.')
  lsWrite(LS_INVOICE_PAYMENTS, rows.filter((p) => p.id !== paymentId))
  const invoice = localRecomputeInvoiceBalance(pay.invoice_id)
  return { invoice }
}

export const store = {
  configured: supabaseConfigured,

  async load() {
    return supabaseConfigured ? sbLoad() : localLoad()
  },

  async saveCustomer(customer, contacts, addresses) {
    if (!supabaseConfigured) {
      // The old single notes box is gone — notes live in the log now, so
      // never persist a `notes` value on the customer record itself.
      const { notes: _oldNotes, ...customerNoNotes } = customer
      const customers = lsRead(LS_CUSTOMERS, [])
      const now = new Date().toISOString()
      if (customerNoNotes.id) {
        const idx = customers.findIndex((c) => c.id === customerNoNotes.id)
        if (idx >= 0 && customers[idx].version !== customerNoNotes.version) {
          throw new VersionConflict('This customer was changed by someone else. Reload and try again.')
        }
        const saved = { ...customerNoNotes, company: titleCaseName(customerNoNotes.company), customer_type: customerTypeOf(customerNoNotes), version: (customerNoNotes.version || 1) + 1, updated_at: now }
        customers[idx] = saved
        lsWrite(LS_CUSTOMERS, customers)
        return saved
      }
      const saved = { ...customerNoNotes, company: titleCaseName(customerNoNotes.company), customer_type: customerTypeOf(customerNoNotes), id: uid(), version: 1, created_at: now, updated_at: now }
      lsWrite(LS_CUSTOMERS, [saved, ...customers])
      return saved
    }
    return sbSaveCustomer(customer, contacts, addresses)
  },

  async saveVehicle(vehicle) {
    if (!supabaseConfigured) {
      const vehicles = lsRead(LS_VEHICLES, [])
      const now = new Date().toISOString()
      const normalized = normalizeVin(vehicle.vin)
      if (vehicle.id) {
        const idx = vehicles.findIndex((v) => v.id === vehicle.id)
        if (idx >= 0 && vehicles[idx].version !== vehicle.version) {
          throw new VersionConflict('This vehicle was changed by someone else. Reload and try again.')
        }
        const saved = { ...vehicle, vin_normalized: normalized, version: (vehicle.version || 1) + 1, updated_at: now }
        vehicles[idx] = saved
        lsWrite(LS_VEHICLES, vehicles)
        return saved
      }
      const saved = { ...vehicle, id: uid(), vin_normalized: normalized, version: 1, created_at: now, updated_at: now }
      lsWrite(LS_VEHICLES, [saved, ...vehicles])
      return saved
    }
    return sbSaveVehicle(vehicle)
  },

  async checkVin(vin, excludeId) {
    if (!supabaseConfigured) {
      const normalized = normalizeVin(vin)
      if (!normalized) return []
      return lsRead(LS_VEHICLES, []).filter(
        (v) => normalizeVin(v.vin) === normalized && v.id !== excludeId
      )
    }
    return sbCheckVin(vin, excludeId)
  },

  async deleteCustomer(id) {
    if (!supabaseConfigured) {
      lsWrite(LS_CUSTOMERS, lsRead(LS_CUSTOMERS, []).filter((c) => c.id !== id))
      lsWrite(LS_VEHICLES, lsRead(LS_VEHICLES, []).filter((v) => v.customer_id !== id))
      return
    }
    return sbDeleteCustomer(id)
  },

  async deleteVehicle(id) {
    if (!supabaseConfigured) {
      lsWrite(LS_VEHICLES, lsRead(LS_VEHICLES, []).filter((v) => v.id !== id))
      return
    }
    return sbDeleteVehicle(id)
  },

  // --- Customer photos (mini-CRM) ---
  // Local mode has no Storage or photos table: list returns empty and the
  // UI shows the "available when connected" note instead of the uploader.
  async listPhotos(customerId) {
    if (!supabaseConfigured) return []
    return sbListPhotos(customerId)
  },

  async uploadPhoto(customerId, file, caption, userId) {
    if (!supabaseConfigured) throw new Error('Photos are available when connected to the live database.')
    return sbUploadPhoto(customerId, file, caption, userId)
  },

  async deletePhoto(photo) {
    if (!supabaseConfigured) throw new Error('Photos are available when connected to the live database.')
    return sbDeletePhoto(photo)
  },

  // --- Customer notes log (mini-CRM) ---
  // Local mode keeps notes in localStorage, same shape as Supabase rows.
  async listNotes(customerId) {
    if (!supabaseConfigured) return localListNotes(customerId)
    return sbListNotes(customerId)
  },

  async addNote(customerId, body, userId) {
    if (!supabaseConfigured) return localAddNote(customerId, body, userId)
    return sbAddNote(customerId, body, userId)
  },

  async deleteNote(noteId) {
    if (!supabaseConfigured) return localDeleteNote(noteId)
    return sbDeleteNote(noteId)
  },

  // --- Product notes log (shared catalog) ---
  async listProductNotes(productId) {
    if (!supabaseConfigured) return localListProductNotes(productId)
    return sbListProductNotes(productId)
  },

  async addProductNote(productId, body, userId) {
    if (!supabaseConfigured) return localAddProductNote(productId, body, userId)
    return sbAddProductNote(productId, body, userId)
  },

  async deleteProductNote(noteId) {
    if (!supabaseConfigured) return localDeleteProductNote(noteId)
    return sbDeleteProductNote(noteId)
  },

  // --- Product photos (shared catalog) ---
  async listProductPhotos(productId) {
    if (!supabaseConfigured) return []
    return sbListProductPhotos(productId)
  },

  async uploadProductPhoto(productId, file, caption, userId) {
    if (!supabaseConfigured) throw new Error('Photos are available when connected to the live database.')
    return sbUploadProductPhoto(productId, file, caption, userId)
  },

  async deleteProductPhoto(photo) {
    if (!supabaseConfigured) throw new Error('Photos are available when connected to the live database.')
    return sbDeleteProductPhoto(photo)
  },

  // --- Invoice payments (Phase 3) ---
  // A deposit is just a payment; an invoice takes as many as the customer
  // makes. Record is any active user; delete is Admin-only.
  async listPayments(invoiceId) {
    if (!supabaseConfigured) return localListPayments(invoiceId)
    return sbListPayments(invoiceId)
  },

  // One query for the Invoices list "Deposit due" pill.
  async listPaymentsForInvoices(invoiceIds) {
    if (!supabaseConfigured) return localListPaymentsForInvoices(invoiceIds)
    return sbListPaymentsForInvoices(invoiceIds)
  },

  async recordPayment(invoiceId, fields, userId) {
    if (!supabaseConfigured) return localRecordPayment(invoiceId, fields, userId)
    return sbRecordPayment(invoiceId, fields, userId)
  },

  async deletePayment(paymentId, isAdmin) {
    if (!supabaseConfigured) return localDeletePayment(paymentId, isAdmin)
    return sbDeletePayment(paymentId, isAdmin)
  },

  // --- Tickets ---
  async saveTicket(kind, ticket, lines, userId) {
    if (!supabaseConfigured) return localSaveTicket(kind, ticket, lines, userId)
    return sbSaveTicket(kind, ticket, lines, userId)
  },

  async setTicketStatus(kind, ticket, status, userId, extra) {
    if (!supabaseConfigured) {
      const key = kind === 'quote' ? LS_QUOTES : LS_INVOICES
      const rows = lsRead(key, [])
      const idx = rows.findIndex((r) => r.id === ticket.id)
      if (idx < 0) throw new Error('Ticket not found.')
      rows[idx] = { ...rows[idx], status, ...(extra || {}), version: (rows[idx].version || 1) + 1 }
      lsWrite(key, rows)
      return rows[idx]
    }
    return sbSetTicketStatus(kind, ticket, status, userId, extra)
  },

  async convertQuoteToInvoice(quote, quoteLines, userId, state) {
    if (!supabaseConfigured) {
      if (quote.converted_invoice_id) {
        return lsRead(LS_INVOICES, []).find((i) => i.id === quote.converted_invoice_id) || null
      }
      const issueDate = todayStr()
      const totals = computeTotals(quoteLines, state.settings?.tax_rate, quote.labor_lump)
      const localVehicle = localUpsertVehicleFromTicket(quote.customer_id, quote.vehicle_snapshot)
      const localSnapshot = localVehicle
        ? vehicleSnapshotFromFields(
            {
              vin: quote.vehicle_snapshot?.vin || '',
              year: quote.vehicle_snapshot?.year ?? '',
              make: quote.vehicle_snapshot?.make || '',
              model: quote.vehicle_snapshot?.model || '',
              bed_size: quote.vehicle_snapshot?.bed_size || '',
              fleet_unit: quote.vehicle_snapshot?.fleet_unit || '',
              color: quote.vehicle_snapshot?.color || '',
                },
            localVehicle.id
          ) || quote.vehicle_snapshot
        : quote.vehicle_snapshot
      const invoice = {
        id: uid(), number: `INV-${localNextNumber('invoice')}`,
        quote_id: quote.id, customer_id: quote.customer_id || null, vehicle_id: localVehicle?.id || quote.vehicle_id || null,
        // Multi-salesman (Nov 23): the local conversion carries the whole
        // salesperson_ids array from the quote.
        salesperson_ids: (quote.salesperson_ids || []).filter(Boolean).length
          ? (quote.salesperson_ids || []).filter(Boolean)
          : (userId ? [userId] : []),
        created_by: userId, status: 'Draft',
        issue_date: issueDate, due_date: dueDateFor(issueDate, quote.payment_terms),
        po_number: quote.po_number || null, payment_terms: quote.payment_terms || 'Net 30',
        customer_notes: quote.customer_notes || null, internal_notes: quote.internal_notes || null,
        customer_snapshot: quote.customer_snapshot || null, vehicle_snapshot: localSnapshot || null,
        labor_lump: roundCents(Number(quote.labor_lump) || 0),
        subtotal: totals.subtotal, tax_total: totals.taxTotal, total: totals.total, balance_due: totals.total,
        version: 1, created_at: new Date().toISOString(),
        lines: (quoteLines || []).map((l, i) => ({ ...l, id: uid(), line_total: lineTotal(l), sort_order: i })),
      }
      lsWrite(LS_INVOICES, [invoice, ...lsRead(LS_INVOICES, [])])
      const quotes = lsRead(LS_QUOTES, [])
      const qi = quotes.findIndex((q) => q.id === quote.id)
      if (qi >= 0) { quotes[qi] = { ...quotes[qi], converted_invoice_id: invoice.id }; lsWrite(LS_QUOTES, quotes) }
      return invoice
    }
    return sbConvertQuoteToInvoice(quote, quoteLines, userId, state)
  },

  async saveWalkInAsCustomer(kind, ticket, customerType, userId) {
    if (!supabaseConfigured) return localSaveWalkInAsCustomer(kind, ticket, customerType)
    return sbSaveWalkInAsCustomer(kind, ticket, customerType, userId)
  },

  async deleteTicket(kind, id, isAdmin) {
    if (!isAdmin) throw new Error('Only an Admin can delete a ticket.')
    if (!supabaseConfigured) {
      const key = kind === 'quote' ? LS_QUOTES : LS_INVOICES
      lsWrite(key, lsRead(key, []).filter((r) => r.id !== id))
      return
    }
    const { error } = await supabase.from(ticketTable(kind)).delete().eq('id', id)
    if (error) throw error
  },

  // Admin-only manual invoice renumber. Renames ONE invoice and nothing
  // else: no other invoice's number changes, the auto-number sequence is
  // not touched (the next new invoice still gets the next sequence
  // number), and the old number is kept in previous_numbers so the
  // invoice is still found by searching it. The audit trigger logs the
  // UPDATE (old number -> new number) in audit_log automatically.
  // Returns the updated invoice row. Not a ticket edit — totals, status,
  // dates, lines, and snapshots are untouched.
  async renameInvoice(id, newNumber, isAdmin) {
    if (!isAdmin) throw new Error('Only an Admin can change an invoice number.')
    const target = normalizeInvoiceNumber(newNumber)
    if (!supabaseConfigured) return localRenameInvoice(id, target)
    const { data: current, error: curErr } = await supabase
      .from('invoices').select('id, number, previous_numbers').eq('id', id).single()
    if (curErr || !current) throw new Error('Invoice not found.')
    if (current.number === target) return current
    const { data: clash } = await supabase
      .from('invoices').select('id').eq('number', target).neq('id', id).limit(1)
    if (clash?.length) throw new Error(`${target} is already used by another invoice.`)
    const { error } = await supabase.rpc('admin_renumber_invoice', { p_invoice_id: id, p_new_number: target })
    if (error) throw error
    const { data: updated, error: updErr } = await supabase
      .from('invoices').select('*').eq('id', id).single()
    if (updErr || !updated) throw updErr || new Error('Renumber succeeded but the invoice could not be reloaded.')
    return updated
  },

  async saveProduct(product, isAdmin, userId) {
    if (!supabaseConfigured) {
      // Local mode: cost lives on the product object (same shape as the
      // merged Supabase rows). Anyone may save; delete stays Admin-only.
      const rows = lsRead(LS_PRODUCTS, [])
      if (product.id) {
        const idx = rows.findIndex((r) => r.id === product.id)
        if (idx >= 0) rows[idx] = { ...rows[idx], ...product, cost: Number(product.cost) || 0, version: (rows[idx].version || 1) + 1 }
      } else {
        rows.push({ ...product, id: uid(), version: 1, cost: Number(product.cost) || 0, active: product.active !== false })
      }
      lsWrite(LS_PRODUCTS, rows)
      return rows.find((r) => r.id === product.id) || rows[rows.length - 1]
    }
    return sbSaveProduct(product, isAdmin, userId)
  },

  async deleteProduct(id, isAdmin) {
    // Delete is open to any active user (Nov 19 — Bill's correction).
    // The button lives only in the edit form's danger zone, never on a
    // list row; the two-step confirm in the form is the safety check.
    // RLS enforces the same rule in the database.
    if (!supabaseConfigured) {
      lsWrite(LS_PRODUCTS, lsRead(LS_PRODUCTS, []).filter((r) => r.id !== id))
      return
    }
    const { error } = await supabase.from('products').delete().eq('id', id)
    if (error) throw error
  },

  // QuickBooks CSV import: inserts only the rows the Admin selected in the
  // preview. Duplicate detection happens in the preview, not here.
  async importCustomers(rows) {
    if (!supabaseConfigured) {
      const customers = lsRead(LS_CUSTOMERS, [])
      const now = new Date().toISOString()
      const created = rows.map((r) => ({
        id: uid(), company: r.Company, customer_type: 'Retail', tax_exempt: /^(y|yes|true|1)$/i.test(r['Tax Exempt'] || ''),
        payment_terms: r.Terms || 'Net 30', po_requirements: '',
        version: 1, created_at: now, updated_at: now,
      }))
      lsWrite(LS_CUSTOMERS, [...created, ...customers])
      return created
    }
    const created = []
    for (const r of rows) {
      const { data, error } = await supabase
        .from('customers')
        .insert({
          company: r.Company,
          customer_type: 'Retail',
          tax_exempt: /^(y|yes|true|1)$/i.test(r['Tax Exempt'] || ''),
          payment_terms: r.Terms || 'Net 30',
        })
        .select()
        .single()
      if (error) throw error
      if (r.Contact || r.Phone || r.Email) {
        await supabase.from('contacts').insert({
          customer_id: data.id, name: r.Contact || r.Company,
          phone: r.Phone || null, email: r.Email || null, is_primary: true,
        })
      }
      if (r['Billing Address'] || r['Billing City']) {
        await supabase.from('customer_addresses').insert({
          customer_id: data.id, address_type: 'billing',
          line1: r['Billing Address'] || null, city: r['Billing City'] || null,
          state: r['Billing State'] || null, zip: r['Billing ZIP'] || null, is_primary: true,
        })
      }
      created.push(data)
    }
    return created
  },
}
