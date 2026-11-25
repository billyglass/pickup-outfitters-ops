import { useEffect, useMemo, useRef, useState } from 'react'
import { store } from '../lib/store.js'
import { ageDays, duplicateTicket, ticketCustomerName, isWalkInTicket, customerTypeOf, fmtDate, canEditTicket, salespersonNamesOf, money, canCompleteAndBill } from '../lib/tickets.js'
import TicketForm from './TicketForm.jsx'
import TicketPrint from './TicketPrint.jsx'
import ComboBox from './ComboBox.jsx'
import SaveWalkInAsCustomer from './SaveWalkInAsCustomer.jsx'

// Quotes have exactly two statuses: Open and Lost. Converting an Open
// quote to an invoice means it was won — the quote leaves this list
// (hidden by converted_invoice_id, never deleted) and lives as an invoice.
const STATUSES = ['Open', 'Lost']
const VIEWS = ['Open', 'Lost', 'All']

export default function Quotes({ data, user, profile, isAdmin, settings, onReload, onError, openQuoteId, openMode, onOpened, onOpenInvoice, onViewClosed, onClearReturn }) {
  const [editing, setEditing] = useState(undefined) // undefined=list, null=new, object=edit
  // Open a specific quote on mount (e.g. clicked from search, the
  // dashboard, or the Vehicles tab). View-first: the print version opens
  // unless the caller asked for Edit.
  const openedRef = useRef(false)
  useEffect(() => {
    if (!openQuoteId || openedRef.current) return
    const q = data.quotes.find((x) => x.id === openQuoteId)
    if (q) {
      openedRef.current = true
      if (openMode === 'edit') { setEditing(q); onClearReturn?.() }
      else setPrinting(q)
      onOpened?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [duplicating, setDuplicating] = useState(null) // { ticket, lines, sourceLabel } or null
  const [printing, setPrinting] = useState(null)
  const [fCustomer, setFCustomer] = useState('')
  const [fSales, setFSales] = useState('')
  const [fAge, setFAge] = useState('')
  const [view, setView] = useState('Open') // Open (default — the sales list) / Lost / All
  const [busy, setBusy] = useState('')
  const [convertMsg, setConvertMsg] = useState('')
  const [convertedInvoice, setConvertedInvoice] = useState(null) // { id, number } of the invoice just created / already linked
  const [saveAs, setSaveAs] = useState(null) // walk-in quote to save as a customer

  const namesOf = (t) => salespersonNamesOf(t, data.profiles)
  // Walk-in quotes show the buyer's name from the snapshot, with a tag.
  const customerOf = (q) => ticketCustomerName(q, data.customers)
  const linesOf = (id) => (data.quoteLines || []).filter((l) => l.quote_id === id)

  // Converted quotes never appear in this tab — they were won and live as
  // invoices now. They are still findable by global search on their QT-A
  // number, and the invoice links back to the original quote.
  const isConverted = (q) => !!q.converted_invoice_id
  const openQuotes = data.quotes.filter((q) => q.status === 'Open' && !isConverted(q))
  const openValue = openQuotes.reduce((s, q) => s + Number(q.total || 0), 0)

  const filtered = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    const rows = data.quotes.filter((q) => {
      if (isConverted(q)) return false
      if (view === 'Open' && q.status !== 'Open') return false
      if (view === 'Lost' && q.status !== 'Lost') return false
      if (fCustomer === 'walk-in' && q.customer_id) return false
      if (fCustomer && fCustomer !== 'walk-in' && q.customer_id !== fCustomer) return false
      if (fSales && !(q.salesperson_ids || []).includes(fSales)) return false
      if (fAge) {
        const age = ageDays(q.issue_date || (q.created_at || '').slice(0, 10)) ?? 0
        if (fAge === '<7' && age >= 7) return false
        if (fAge === '7-30' && (age < 7 || age > 30)) return false
        if (fAge === '31-60' && (age < 31 || age > 60)) return false
        if (fAge === '60+' && age < 60) return false
      }
      return true
    })
    // Sales list order: follow-up due first, then oldest first — the
    // quotes that have waited longest get chased first.
    const dateOf = (q) => q.issue_date || (q.created_at || '').slice(0, 10) || ''
    return rows.sort((a, b) => {
      const dueA = a.follow_up_on && a.follow_up_on <= today ? 0 : 1
      const dueB = b.follow_up_on && b.follow_up_on <= today ? 0 : 1
      if (dueA !== dueB) return dueA - dueB
      return dateOf(a) < dateOf(b) ? -1 : dateOf(a) > dateOf(b) ? 1 : 0
    })
  }, [data.quotes, view, fCustomer, fSales, fAge])

  const shownValue = filtered.reduce((s, q) => s + Number(q.total || 0), 0)

  async function setStatus(q, status) {
    setBusy(q.id)
    try {
      await store.setTicketStatus('quote', q, status, user?.id)
      await onReload()
    } catch (err) { onError(err.message || 'Status change failed.') } finally { setBusy('') }
  }

  async function markLost(q) {
    if (!window.confirm(`Mark quote ${q.number} as lost? It moves to the Lost list — you can reopen it later if the customer comes back.`)) return
    await setStatus(q, 'Lost')
  }

  // Convert is on every Open quote. Converting means the quote was won —
  // the invoice is created and the quote leaves this list.
  const canConvert = (q) => q.status === 'Open' && !q.converted_invoice_id
  const convertedInvoiceOf = (q) => data.invoices.find((i) => i.id === q.converted_invoice_id) || null

  async function convert(q, opts = {}) {
    if (q.converted_invoice_id) {
      const existing = convertedInvoiceOf(q)
      setConvertedInvoice(existing ? { id: existing.id, number: existing.number } : null)
      setConvertMsg(`This quote was already converted${existing ? ` to invoice ${existing.number}` : ''}.`)
      return
    }
    if (q.status !== 'Open') return
    if (!window.confirm(`Convert quote ${q.number} to an invoice? A new invoice number (INV-…) will be assigned from the invoice sequence. This cannot create a duplicate — if it was already converted, the existing invoice is shown instead.${opts.fromForm ? ' Save your changes first — unsaved edits on this form won\'t be included.' : ''}`)) return
    setBusy(`convert-${q.id}`)
    setConvertMsg('')
    setConvertedInvoice(null)
    try {
      const invoice = await store.convertQuoteToInvoice(q, linesOf(q.id), user?.id, data)
      setConvertedInvoice({ id: invoice.id, number: invoice.number })
      setConvertMsg(`Converted to invoice ${invoice.number}. The quote is won and leaves this list.`)
      // Converting from the open form: close it so the list shows, with the
      // success message and the Open invoice button.
      if (opts.fromForm) setEditing(undefined)
      await onReload()
    } catch (err) { onError(err.message || 'Conversion failed.') } finally { setBusy('') }
  }

  // Complete & bill (Nov 25): the fleet job is done — convert the quote
  // AND issue the invoice in one step, so the customer can be billed.
  // The completion marker IS the conversion: the quote leaves the Open
  // list and the invoice is Billed, billing date today, due date from the
  // terms on the quote (setTicketStatus stamps both). No job-status field
  // is added — the paper holder still tracks the vehicle/job. After it
  // succeeds, the issued invoice's print view opens, ready to print and
  // send; closing it returns to the Quotes tab.
  async function completeAndBill(q, opts = {}) {
    if (q.converted_invoice_id) {
      const existing = convertedInvoiceOf(q)
      setConvertedInvoice(existing ? { id: existing.id, number: existing.number } : null)
      setConvertMsg(`This quote was already converted${existing ? ` to invoice ${existing.number}` : ''}.`)
      return
    }
    if (q.status !== 'Open') return
    if (!window.confirm(`Mark quote ${q.number} complete and bill it? This converts it to an invoice AND issues it right away — billing date today, due date from the terms on the quote. The quote leaves the Open list and the issued invoice opens, ready to print and send.${opts.fromForm ? ' Save your changes first — unsaved edits on this form won\'t be included.' : ''}`)) return
    setBusy(`bill-${q.id}`)
    setConvertMsg('')
    setConvertedInvoice(null)
    try {
      const invoice = await store.convertQuoteToInvoice(q, linesOf(q.id), user?.id, data)
      let issued
      try {
        issued = await store.setTicketStatus('invoice', invoice, 'Billed', user?.id)
      } catch (issueErr) {
        // The invoice exists as a Draft — say so plainly and do NOT claim
        // the job was billed. The message + Open invoice button point at
        // the Draft so it can be issued from the Invoices list.
        setConvertedInvoice({ id: invoice.id, number: invoice.number })
        setConvertMsg(`Converted to invoice ${invoice.number}, but issuing it failed: ${issueErr.message || 'Issue failed.'} The invoice is a Draft — issue it from the Invoices list.`)
        if (opts.fromForm) setEditing(undefined)
        await onReload()
        return
      }
      setConvertedInvoice({ id: issued.id, number: issued.number })
      setConvertMsg(`Completed & billed — invoice ${issued.number} is billed and ready to print.`)
      if (opts.fromForm) setEditing(undefined)
      await onReload()
      if (onOpenInvoice) onOpenInvoice(issued)
    } catch (err) { onError(err.message || 'Complete & bill failed.') } finally { setBusy('') }
  }

  async function handleDelete(q) {
    if (!isAdmin) return
    // The form already asks "Delete this quote?" before calling this,
    // so no second popup — one deliberate confirm is enough.
    try { await store.deleteTicket('quote', q.id, true); setEditing(undefined); await onReload() } catch (err) { onError(err.message || 'Delete failed.') }
  }

  // Fleet duplicate: opens a NEW Open quote prefilled from the source —
  // nothing is saved until the user clicks Save, which assigns a new QT-A number.
  function duplicate(q) {
    setEditing(undefined)
    setDuplicating(duplicateTicket('quote', q, linesOf(q.id), user?.id, settings))
  }

  if (printing) {
    const q = printing
    return (
      <TicketPrint
        kind="quote" ticket={q} lines={linesOf(q.id)}
        customer={data.customers.find((c) => c.id === q.customer_id)}
        vehicle={data.vehicles.find((v) => v.id === q.vehicle_id)}
        salespersonName={namesOf(q)} settings={settings}
        onClose={() => { setPrinting(null); onViewClosed?.() }}
        onEdit={() => { setPrinting(null); setEditing(q); onClearReturn?.() }}
        canEdit={canEditTicket('quote', q, isAdmin)}
      />
    )
  }
  if (duplicating) {
    return (
      <TicketForm
        key={`dup-${duplicating.sourceLabel}`}
        kind="quote"
        initial={null}
        prefill={duplicating.ticket}
        lines={duplicating.lines}
        customers={data.customers} vehicles={data.vehicles} contacts={data.contacts} addresses={data.addresses}
        products={data.products || []} profiles={data.profiles || []}
        user={user} profile={profile} isAdmin={isAdmin} settings={settings}
        onSaved={async () => { setDuplicating(null); await onReload() }}
        onCancel={() => setDuplicating(null)}
      />
    )
  }
  if (editing !== undefined) {
    return (
      <TicketForm
        key={editing ? `edit-${editing.id}` : 'new-quote'}
        kind="quote"
        initial={editing}
        lines={editing ? linesOf(editing.id) : undefined}
        customers={data.customers} vehicles={data.vehicles} contacts={data.contacts} addresses={data.addresses}
        products={data.products || []} profiles={data.profiles || []}
        user={user} profile={profile} isAdmin={isAdmin} settings={settings}
        onSaved={async (saved, extra) => {
          setEditing(undefined)
          if (extra?.savedAsCustomer) {
            setConvertMsg(extra.linkedExisting
              ? `Linked ${saved.number} to existing customer ${extra.savedAsCustomer.company} — same phone/email. Their history now includes this quote.`
              : `Saved ${extra.savedAsCustomer.company} as a customer and linked ${saved.number} to them.`)
          }
          await onReload()
        }}
        onCancel={() => setEditing(undefined)}
        onView={editing ? () => setPrinting(editing) : undefined}
        onDuplicate={editing ? () => duplicate(editing) : undefined}
        onConvert={editing && canConvert(editing) ? () => convert(editing, { fromForm: true }) : undefined}
        onCompleteAndBill={editing && canConvert(editing) ? () => completeAndBill(editing, { fromForm: true }) : undefined}
        completeAndBillBusy={editing ? busy === `bill-${editing.id}` : false}
        onDelete={isAdmin && editing?.status === 'Open' ? () => handleDelete(editing) : undefined}
      />
    )
  }

  if (saveAs) {
    return (
      <SaveWalkInAsCustomer
        kind="quote" ticket={saveAs} data={data} user={user}
        onDone={async (message) => { setSaveAs(null); setConvertMsg(message); await onReload() }}
        onError={onError}
        onCancel={() => setSaveAs(null)}
      />
    )
  }

  return (
    <div className="card">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Quotes — {view} ({filtered.length}){isAdmin ? <> · ${money(shownValue)}{view === 'Open' ? ' to go after' : ''}</> : ''}</h2>
        <button className="btn" onClick={() => setEditing(null)}>+ New quote</button>
      </div>
      <p className="muted small">Open quotes are the ones to go after — follow-up due and oldest first. Mark a quote Lost when the customer says no; reopen it anytime. Converting an Open quote to an invoice means you won it — it leaves this list and lives as an invoice. Quotes expire {settings?.quote_validity_days ?? 15} days after the issue date. Quotes and invoices have separate numbering — quotes QT-A1001…, invoices INV-1001… — so a quote and an invoice can share the same numeric part and still be different numbers.</p>
      {convertMsg && (
        <div className="success">
          {convertMsg}{' '}
          {convertedInvoice && onOpenInvoice && (
            <button className="btn secondary" style={{ marginLeft: 8 }} onClick={() => onOpenInvoice(convertedInvoice)}>Open invoice {convertedInvoice.number}</button>
          )}
        </div>
      )}
      <div className="row filters" style={{ marginTop: 12 }}>
        <div className="row" role="group" aria-label="Quote list">
          {VIEWS.map((v) => (
            <button key={v} type="button" className={view === v ? 'btn' : 'btn secondary'} onClick={() => setView(v)}>
              {v === 'Open' ? `Open (${openQuotes.length})` : v === 'Lost' ? `Lost (${data.quotes.filter((q) => q.status === 'Lost' && !isConverted(q)).length})` : 'All'}
            </button>
          ))}
        </div>
        <ComboBox
          value={fCustomer}
          onChange={setFCustomer}
          placeholder="Search customers…"
          ariaLabel="Filter by customer"
          emptyText="No customers match that — try fewer letters."
          options={[
            { value: '', label: 'All customers' },
            { value: 'walk-in', label: 'Walk-in (no customer record)' },
            ...data.customers.map((c) => ({ value: c.id, label: c.company, tag: customerTypeOf(c) })),
          ]}
        />
        <select value={fSales} onChange={(e) => setFSales(e.target.value)}>
          <option value="">All salespeople</option>
          {(data.profiles || []).filter((p) => p.active !== false).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={fAge} onChange={(e) => setFAge(e.target.value)}>
          <option value="">Any age</option>
          <option value="<7">&lt; 7 days</option>
          <option value="7-30">7–30 days</option>
          <option value="31-60">31–60 days</option>
          <option value="60+">60+ days</option>
        </select>
      </div>
      <div className="table-scroll">
      <table className="list">
        <thead><tr><th className="nowrap">Quote</th><th>Customer</th><th className="nowrap">Date</th><th className="nowrap">Age</th><th className="nowrap">Salesperson</th><th className="nowrap">Status</th><th className="num">Total</th><th></th></tr></thead>
        <tbody>
          {filtered.map((q) => {
            const age = ageDays(q.issue_date || (q.created_at || '').slice(0, 10))
            return (
              <tr key={q.id}>
                <td className="nowrap"><strong>{q.number}</strong></td>
                <td className="customer" title={customerOf(q)}>{customerOf(q)}{isWalkInTicket(q) && <div className="muted small">Walk-in</div>}</td>
                <td className="nowrap">{fmtDate(q.issue_date || (q.created_at || '').slice(0, 10))}</td>
                <td className="nowrap">{age ?? '—'}d</td>
                <td className="nowrap">{namesOf(q)}</td>
                <td className="nowrap">{q.status}</td>
                <td className="num">${money(q.total)}</td>
                <td>
                  <div className="row actions">
                    <button className="btn small" onClick={() => setPrinting(q)}>View</button>
                    <button className="btn secondary small" onClick={() => setEditing(q)}>Edit</button>
                    <button className="btn secondary small" onClick={() => duplicate(q)}>Duplicate</button>
                    {isWalkInTicket(q) && <button className="btn secondary small" onClick={() => setSaveAs(q)}>Save as customer</button>}
                    {q.status === 'Open' && <button className="btn secondary small" disabled={busy === q.id} onClick={() => markLost(q)}>Mark lost</button>}
                    {q.status === 'Lost' && <button className="btn secondary small" disabled={busy === q.id} onClick={() => setStatus(q, 'Open')}>Reopen</button>}
                    {canConvert(q) && (
                      <button className="btn small" disabled={busy === `convert-${q.id}`} onClick={() => convert(q)}>Convert to invoice</button>
                    )}
                    {canCompleteAndBill(q, data.customers.find((c) => c.id === q.customer_id)) && (
                      <button className="btn small" disabled={busy === `bill-${q.id}`} onClick={() => completeAndBill(q)}>Complete &amp; bill</button>
                    )}

                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
      {filtered.length === 0 && <p className="muted">No quotes match these filters.</p>}
    </div>
  )
}
