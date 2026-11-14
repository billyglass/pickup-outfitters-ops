import { supabase, supabaseConfigured } from './supabase.js'
import { normalizeVin, normalizePhone } from './csv.js'

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
  const [customers, contacts, addresses, vehicles, quotes, invoices, settings] =
    await Promise.all([
      supabase.from('customers').select('*').order('company', { ascending: true }),
      supabase.from('contacts').select('*'),
      supabase.from('customer_addresses').select('*'),
      supabase.from('vehicles').select('*').order('created_at', { ascending: false }),
      supabase.from('quotes').select('id, number, status, customer_id, created_at'),
      supabase.from('invoices').select('id, number, status, customer_id, created_at'),
      supabase.rpc('public_settings'),
    ])
  for (const r of [customers, contacts, addresses, vehicles, quotes, invoices]) {
    if (r.error) throw r.error
  }
  return {
    customers: customers.data || [],
    contacts: contacts.data || [],
    addresses: addresses.data || [],
    vehicles: vehicles.data || [],
    quotes: quotes.data || [],
    invoices: invoices.data || [],
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
        company: customer.company,
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
      company: customer.company,
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
  const clean = (rows || []).filter((r) => Object.values(r).some((v) => String(v ?? '').trim() !== ''))
  if (!clean.length) return
  const payload = clean.map((r) => ({ ...r, [fk]: customerId, id: undefined }))
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
        customer_id: vehicle.customer_id,
        vin: vehicle.vin || null,
        year: vehicle.year || null,
        make: vehicle.make || null,
        model: vehicle.model || null,
        fleet_unit: vehicle.fleet_unit || null,
        plate: vehicle.plate || null,
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
      customer_id: vehicle.customer_id,
      vin: vehicle.vin || null,
      year: vehicle.year || null,
      make: vehicle.make || null,
      model: vehicle.model || null,
      fleet_unit: vehicle.fleet_unit || null,
      plate: vehicle.plate || null,
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
    .select('id, vin, vin_normalized, customer_id, year, make, model, fleet_unit, plate')
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

// --- Local mode -------------------------------------------------------------

function localLoad() {
  return {
    customers: lsRead(LS_CUSTOMERS, []),
    contacts: [],
    addresses: [],
    vehicles: lsRead(LS_VEHICLES, []),
    quotes: [],
    invoices: [],
    settings: { tax_rate: 0.0774, default_payment_terms: 'Net 30', quote_validity_days: 15, company_name: 'Pickup Outfitters' },
  }
}

// --- Global search ----------------------------------------------------------
// VIN: full, last 6, or last 8. A short query matches the END of the VIN
// (suffix), not just the start — that's how the shop actually looks VINs up.
export async function globalSearch(query, state) {
  const q = String(query || '').trim()
  if (!q) return { customers: [], vehicles: [], quotes: [], invoices: [] }
  if (!supabaseConfigured) {
    const lower = q.toLowerCase()
    const vin = normalizeVin(q)
    return {
      customers: state.customers.filter((c) => c.company.toLowerCase().includes(lower)),
      vehicles: state.vehicles.filter((v) => {
        const n = normalizeVin(v.vin)
        return (
          n.includes(vin) ||
          (vin.length >= 6 && n.endsWith(vin.slice(-6))) ||
          (vin.length >= 8 && n.endsWith(vin.slice(-8))) ||
          String(v.fleet_unit || '').toLowerCase().includes(lower) ||
          String(v.plate || '').toLowerCase().includes(lower)
        )
      }),
      quotes: [],
      invoices: [],
    }
  }
  const like = `%${q}%`
  const vin = normalizeVin(q)
  const [customers, vehicles, quotes, invoices] = await Promise.all([
    supabase.from('customers').select('*').ilike('company', like).limit(20),
    // VIN suffix search: reverse() index in schema.sql supports endsWith.
    // Supabase JS can't express reverse() in a filter, so fetch by trigram
    // ilike on vin_normalized and filter suffixes client-side.
    supabase.from('vehicles').select('*').or(`vin_normalized.ilike.${like},fleet_unit.ilike.${like},plate.ilike.${like}`).limit(20),
    supabase.from('quotes').select('id, number, status, customer_id, created_at, po_number').or(`number.ilike.${like},po_number.ilike.${like}`).limit(20),
    supabase.from('invoices').select('id, number, status, customer_id, created_at, po_number').or(`number.ilike.${like},po_number.ilike.${like}`).limit(20),
  ])
  let vehicleRows = vehicles.data || []
  if (vin.length >= 6) {
    // Also catch last-6 / last-8 matches that ilike('%...%') may have missed
    // when the query is only the tail of a longer VIN.
    const { data } = await supabase
      .from('vehicles')
      .select('*')
      .ilike('vin_normalized', `%${vin.slice(-8)}`)
      .limit(20)
    const seen = new Set(vehicleRows.map((v) => v.id))
    for (const v of data || []) if (!seen.has(v.id)) vehicleRows.push(v)
  }
  return {
    customers: customers.data || [],
    vehicles: vehicleRows,
    quotes: quotes.data || [],
    invoices: invoices.data || [],
  }
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
        const saved = { ...customer, version: (customer.version || 1) + 1, updated_at: now }
        customers[idx] = saved
        lsWrite(LS_CUSTOMERS, customers)
        return saved
      }
      const saved = { ...customer, id: uid(), version: 1, created_at: now, updated_at: now }
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

  // QuickBooks CSV import: inserts only the rows the Admin selected in the
  // preview. Duplicate detection happens in the preview, not here.
  async importCustomers(rows) {
    if (!supabaseConfigured) {
      const customers = lsRead(LS_CUSTOMERS, [])
      const now = new Date().toISOString()
      const created = rows.map((r) => ({
        id: uid(), company: r.Company, tax_exempt: /^(y|yes|true|1)$/i.test(r['Tax Exempt'] || ''),
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
