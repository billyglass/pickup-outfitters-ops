import { supabase, supabaseConfigured } from './supabase.js'
import { normalizeVin, normalizePhone } from './csv.js'
import { computeTotals, cleanLinePayload, lineTotal, dueDateFor, todayStr, resolveVehicleUpsert, vehicleSnapshotFromFields, ticketCustomerName, isWalkInTicket, customerSnapshot, customerTypeOf, findCustomerByPhoneOrEmail } from './tickets.js'
import { titleCaseName } from './names.js'

// Data layer. Two backends behind one API (same pattern as the tracker):
//   - Supabase (when env vars are set): shared Postgres, RLS enforced.
//   - Local mode (no env vars): localStorage, for trying the UI before
//     Supabase is connected. Shows a banner; do not use for real data.
const LS_CUSTOMERS = 'po_ops_customers_v1'
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
      // products has NO cost column by design (cost lives in Admin-only
      // product_costs) — safe for Sales to read.
      supabase.from('products').select('*').order('name', { ascending: true }),
      supabase.from('profiles').select('id, name, email, role'),
      supabase.rpc('public_settings'),
    ])
  for (const r of [customers, contacts, addresses, vehicles, quotes, invoices, quoteLines, invoiceLines, products, profiles]) {
    if (r.error) throw r.error
  }
  return {
    customers: customers.data || [],
    contacts: contacts.data || [],
    addresses: addresses.data || [],
    vehicles: vehicles.data || [],
    quotes: quotes.data || [],
    invoices: invoices.data || [],
    quoteLines: quoteLines.data || [],
    invoiceLines: invoiceLines.data || [],
    products: products.data || [],
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
        tax_exempt: customer.tax_exempt,
        tax_exempt_doc_note: customer.tax_exempt_doc_note || null,
        payment_terms: customer.payment_terms || 'Net 30',
        notes: customer.notes || null,
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
      tax_exempt: customer.tax_exempt,
      tax_exempt_doc_note: customer.tax_exempt_doc_note || null,
      payment_terms: customer.payment_terms || 'Net 30',
      notes: customer.notes || null,
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
    .select('id, vin, vin_normalized, customer_id, year, make, model, fleet_unit, color')
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
  const totals = computeTotals(lines, ticket.tax_rate)
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
    salesperson_id: ticket.salesperson_id || userId,
    status: ticket.status,
    po_number: ticket.po_number || null,
    payment_terms: ticket.payment_terms || 'Net 30',
    customer_notes: ticket.customer_notes || null,
    internal_notes: ticket.internal_notes || null,
    customer_snapshot: ticket.customer_snapshot || null,
    vehicle_snapshot: ticket.vehicle_snapshot || null,
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
    header.balance_due = ticket.status === 'Paid' ? 0 : totals.total
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
  const totals = computeTotals(quoteLines, state.settings?.tax_rate)
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
      salesperson_id: quote.salesperson_id || userId,
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
        notes: `Created from walk-in ${kind === 'quote' ? 'quote' : 'invoice'} ${ticket.number || ''} on ${todayStr()}.`,
        po_requirements: '',
      },
      [{ name, phone: phone || null, email: email || null, title: '', is_primary: true }],
      []
    )
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
      notes: `Created from walk-in ${kind === 'quote' ? 'quote' : 'invoice'} ${ticket.number || ''} on ${todayStr()}.`,
      version: 1, created_at: now, updated_at: now,
    }
    lsWrite(LS_CUSTOMERS, [customer, ...customers])
  }
  const snapshot = {
    company: customer.company, contact_name: name, phone: phone || null,
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

async function sbSaveProduct(product, isAdmin) {
  if (!isAdmin) throw new Error('Only an Admin can manage products.')
  const payload = {
    part_number: (product.part_number || '').trim() || null,
    name: (product.name || '').trim(),
    description: (product.description || '').trim() || null,
    default_price: Number(product.default_price) || 0,
    taxable: !!product.taxable,
    type: product.type || 'part',
    active: product.active !== false,
  }
  if (product.id) {
    const { data, error } = await supabase.from('products').update(payload).eq('id', product.id).eq('version', product.version).select().single()
    if (error) throw error
    return data
  }
  const { data, error } = await supabase.from('products').insert(payload).select().single()
  if (error) throw error
  return data
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
  const totals = computeTotals(lines, ticket.tax_rate)
  // Vehicle upsert from the ticket's own VIN/YMM, same as Supabase mode.
  const localVehicle = localUpsertVehicleFromTicket(ticket.customer_id, ticket.vehicle_snapshot)
  const saved = {
    ...ticket,
    vehicle_id: localVehicle?.id || ticket.vehicle_id || null,
    vehicle_snapshot: localVehicle
      ? vehicleSnapshotFromFields(
          {
            vin: ticket.vehicle_snapshot?.vin || '',
            year: ticket.vehicle_snapshot?.year ?? '',
            make: ticket.vehicle_snapshot?.make || '',
            model: ticket.vehicle_snapshot?.model || '',
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
  if (!saved.id) {
    saved.id = uid()
    saved.number = `${kind === 'quote' ? 'QT-A' : 'INV-'}${localNextNumber(kind)}`
    saved.created_by = userId
    saved.created_at = saved.updated_at
    if (kind === 'invoice') saved.balance_due = totals.total
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
  const salespersonName = (id) => state.profiles?.find((p) => p.id === id)?.name || ''
  // Does the query match a walk-in ticket's snapshot name / phone?
  const walkInMatches = (t) => {
    if (!isWalkInTicket(t) || !lower) return false
    const s = t.customer_snapshot || {}
    return [s.contact_name, s.company, s.phone, s.email]
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
      String(v.color || '').toLowerCase().includes(lower) ||
      matchedCustomerIds.has(v.customer_id)
    )
    const tickets = []
    const pushTicket = (type, t, match) => tickets.push({ type, ticket: t, customer: customerName(t), vin: ticketVin(t), salesperson: salespersonName(t.salesperson_id), match })
    for (const t of state.quotes) {
      const lines = (t.lines || []).filter((l) => String(l.description || '').toLowerCase().includes(lower) || String(l.part_number || '').toLowerCase().includes(lower))
      if (vinMatches(ticketVin(t))) pushTicket('quote', t, 'VIN')
      else if (t.customer_id && matchedCustomerIds.has(t.customer_id)) pushTicket('quote', t, 'Customer')
      else if (walkInMatches(t)) pushTicket('quote', t, 'Walk-in name / phone')
      else if (lines.length) pushTicket('quote', t, `Line item: ${lines[0].description}`)
      else if (String(t.number || '').toLowerCase().includes(lower) || String(t.po_number || '').toLowerCase().includes(lower)) pushTicket('quote', t, 'Number / PO')
    }
    for (const t of state.invoices) {
      const lines = (t.lines || []).filter((l) => String(l.description || '').toLowerCase().includes(lower) || String(l.part_number || '').toLowerCase().includes(lower))
      if (vinMatches(ticketVin(t))) pushTicket('invoice', t, 'VIN')
      else if (t.customer_id && matchedCustomerIds.has(t.customer_id)) pushTicket('invoice', t, 'Customer')
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
    supabase.from('vehicles').select('*').or(`vin_normalized.ilike.${like},fleet_unit.ilike.${like},color.ilike.${like}`).limit(20),
    supabase.from('quotes').select('*').or(`number.ilike.${like},po_number.ilike.${like}`).limit(20),
    supabase.from('invoices').select('*').or(`number.ilike.${like},po_number.ilike.${like}`).limit(20),
    supabase.from('quote_lines').select('*').or(`description.ilike.${like},part_number.ilike.${like}`).limit(20),
    supabase.from('invoice_lines').select('*').or(`description.ilike.${like},part_number.ilike.${like}`).limit(20),
  ])
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
    tickets.push({ type, ticket: t, customer: customerName(t), vin: ticketVin(t), salesperson: salespersonName(t.salesperson_id), match })
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
  const contactCustomerIds = new Set((contacts.data || []).map((c) => c.customer_id))
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
  return {
    customers: customers.data || [],
    contacts: contacts.data || [],
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
    if (filters.salespersonId && t.salesperson_id !== filters.salespersonId) return false
    const d = t.issue_date || (t.created_at || '').slice(0, 10)
    if (filters.from && d < filters.from) return false
    if (filters.to && d > filters.to) return false
    return true
  })
}

// --- Public API -------------------------------------------------------------
export const store = {
  configured: supabaseConfigured,

  async load() {
    return supabaseConfigured ? sbLoad() : localLoad()
  },

  async saveCustomer(customer, contacts, addresses) {
    if (!supabaseConfigured) {
      const customers = lsRead(LS_CUSTOMERS, [])
      const now = new Date().toISOString()
      if (customer.id) {
        const idx = customers.findIndex((c) => c.id === customer.id)
        if (idx >= 0 && customers[idx].version !== customer.version) {
          throw new VersionConflict('This customer was changed by someone else. Reload and try again.')
        }
        const saved = { ...customer, company: titleCaseName(customer.company), customer_type: customerTypeOf(customer), version: (customer.version || 1) + 1, updated_at: now }
        customers[idx] = saved
        lsWrite(LS_CUSTOMERS, customers)
        return saved
      }
      const saved = { ...customer, company: titleCaseName(customer.company), customer_type: customerTypeOf(customer), id: uid(), version: 1, created_at: now, updated_at: now }
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
      const totals = computeTotals(quoteLines, state.settings?.tax_rate)
      const localVehicle = localUpsertVehicleFromTicket(quote.customer_id, quote.vehicle_snapshot)
      const localSnapshot = localVehicle
        ? vehicleSnapshotFromFields(
            {
              vin: quote.vehicle_snapshot?.vin || '',
              year: quote.vehicle_snapshot?.year ?? '',
              make: quote.vehicle_snapshot?.make || '',
              model: quote.vehicle_snapshot?.model || '',
              fleet_unit: quote.vehicle_snapshot?.fleet_unit || '',
              color: quote.vehicle_snapshot?.color || '',
                },
            localVehicle.id
          ) || quote.vehicle_snapshot
        : quote.vehicle_snapshot
      const invoice = {
        id: uid(), number: `INV-${localNextNumber('invoice')}`,
        quote_id: quote.id, customer_id: quote.customer_id || null, vehicle_id: localVehicle?.id || quote.vehicle_id || null,
        salesperson_id: quote.salesperson_id || userId, created_by: userId, status: 'Draft',
        issue_date: issueDate, due_date: dueDateFor(issueDate, quote.payment_terms),
        po_number: quote.po_number || null, payment_terms: quote.payment_terms || 'Net 30',
        customer_notes: quote.customer_notes || null, internal_notes: quote.internal_notes || null,
        customer_snapshot: quote.customer_snapshot || null, vehicle_snapshot: localSnapshot || null,
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

  async saveProduct(product, isAdmin) {
    if (!supabaseConfigured) {
      if (!isAdmin) throw new Error('Only an Admin can manage products.')
      const rows = lsRead(LS_PRODUCTS, [])
      if (product.id) {
        const idx = rows.findIndex((r) => r.id === product.id)
        if (idx >= 0) rows[idx] = { ...rows[idx], ...product, version: (rows[idx].version || 1) + 1 }
      } else {
        rows.push({ ...product, id: uid(), version: 1, active: product.active !== false })
      }
      lsWrite(LS_PRODUCTS, rows)
      return rows.find((r) => r.id === product.id) || rows[rows.length - 1]
    }
    return sbSaveProduct(product, isAdmin)
  },

  async deleteProduct(id, isAdmin) {
    if (!isAdmin) throw new Error('Only an Admin can manage products.')
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
        payment_terms: r.Terms || 'Net 30', notes: '', po_requirements: '',
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
