import { useEffect, useMemo, useState } from 'react'
import { store } from '../lib/store.js'
import { fmtDate, money, roundCents, ticketCustomerName, salespersonNamesOf } from '../lib/tickets.js'
import { invoiceSaleFigures, profitFor, collectRowsForDate, cashCollectedOn, findInvoiceByNumber, billedOnDate, soldSummary, collectedTotals, dayHistory, calendarCells } from '../lib/endOfDay.js'

// End of day (Nov 25) — Bill's spreadsheet, in the app. Two parts:
//   1. Collected today: one row per invoice with money collected on the
//      selected date. Sale / Labor / Tax / rep fill in from the invoice;
//      Cost is the only thing typed in, and Profit $ / % work themselves
//      out with the sheet's math (Profit = Sale − Cost, % = Profit /
//      Sale; Labor and Tax are tracked, never in profit).
//   2. Sold today: a simple auto square — what was billed on the date,
//      separate from what was collected. No typing.
// Cost lives per invoice (invoices.cost_of_goods, migration 025) and is
// entered ONLY here — never on the invoice form, lists, print, or search.
//
// ACCESS (Bill's explicit decision, Nov 25): the tab is open to every
// active user — whoever is closing that day fills it out, and the day's
// rows INCLUDING per-row Profit $ and % are visible to them. The TOTALS
// strip, the cash-collected line, and the sold square's money figures
// are Admin-only (isAdmin gates below). Sales see the rows and the sold
// count only. "Total profit stays private, that day can be seen by
// whos filling it out that day."
function CostInput({ value, onSave }) {
  // value: stored cost (number) or null = not entered yet.
  const display = value == null ? '' : Number(value).toFixed(2)
  const [draft, setDraft] = useState(display)
  const [focused, setFocused] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { if (!focused) setDraft(display) }, [display, focused])
  useEffect(() => {
    if (!savedFlash) return undefined
    const t = setTimeout(() => setSavedFlash(false), 1500)
    return () => clearTimeout(t)
  }, [savedFlash])

  async function commit(text) {
    const raw = String(text ?? '').trim()
    if (raw === '' && value == null) return
    let cost
    if (raw === '') {
      cost = null // cleared = no cost recorded
    } else {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) {
        setErr('Enter a cost of $0 or more.')
        setDraft(display)
        return
      }
      cost = roundCents(n)
      if (value != null && roundCents(Number(value)) === cost) return // unchanged
    }
    setErr('')
    setSaving(true)
    const res = await onSave(cost)
    setSaving(false)
    if (res.ok) {
      setSavedFlash(true)
    } else {
      setErr(res.message || 'Could not save the cost.')
      setDraft(display)
    }
  }

  return (
    <span>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        disabled={saving}
        aria-label="Cost of goods"
        placeholder="Cost"
        style={{ width: 110, textAlign: 'right' }}
        onChange={(e) => { setDraft(e.target.value); setErr('') }}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { setFocused(false); commit(e.target.value) }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(e.target.value); e.target.blur() } }}
      />
      {savedFlash && <span style={{ color: '#1e7e34', fontSize: 12, marginLeft: 6 }}>Saved</span>}
      {err && <div style={{ color: '#b3261e', fontSize: 11, marginTop: 2 }}>{err}</div>}
    </span>
  )
}

export default function EndOfDay({ data, today, isAdmin, onReload, onOpenInvoice }) {
  const [date, setDate] = useState(today)
  const [addedIds, setAddedIds] = useState([]) // invoices pulled in by number for this date
  const [costOverrides, setCostOverrides] = useState({}) // invoiceId -> cost, until App data reloads
  const [payments, setPayments] = useState([])
  const [payLoading, setPayLoading] = useState(true)
  const [payError, setPayError] = useState('')
  const [addText, setAddText] = useState('')
  const [addMsg, setAddMsg] = useState('')
  // Calendar month shown in the Past days card (0 = January). Starts on
  // the current month; picking a day anywhere moves it to that day's
  // month so the calendar and the sheet stay in sync.
  const [calYear, setCalYear] = useState(() => Number(String(today).slice(0, 4)))
  const [calMonth, setCalMonth] = useState(() => Number(String(today).slice(5, 7)) - 1)

  useEffect(() => {
    let alive = true
    setPayLoading(true)
    store.listAllPayments()
      .then((rows) => { if (alive) { setPayments(rows || []); setPayLoading(false) } })
      .catch((err) => { if (alive) { setPayError(err.message || 'Could not load payments.'); setPayLoading(false) } })
    return () => { alive = false }
  }, [])

  const invoiceById = useMemo(() => new Map((data.invoices || []).map((i) => [i.id, i])), [data.invoices])
  const linesByInvoice = useMemo(() => {
    const m = new Map()
    for (const l of data.invoiceLines || []) {
      if (!m.has(l.invoice_id)) m.set(l.invoice_id, [])
      m.get(l.invoice_id).push(l)
    }
    return m
  }, [data.invoiceLines])
  const costOf = (inv) => (Object.prototype.hasOwnProperty.call(costOverrides, inv.id)
    ? costOverrides[inv.id]
    : (inv.cost_of_goods ?? null))

  // One row per invoice with money collected on the date, plus any invoice
  // pulled in by number. An invoice paid twice in one day is one row.
  const rows = useMemo(() => {
    const collected = collectRowsForDate(payments, date)
    const autoIds = new Set(collected.map((c) => c.invoiceId))
    const byId = new Map()
    for (const c of collected) byId.set(c.invoiceId, c.collected)
    for (const id of addedIds) if (!byId.has(id)) byId.set(id, 0)
    const out = []
    for (const [id, collectedAmt] of byId) {
      const inv = invoiceById.get(id)
      if (!inv) continue
      const figs = invoiceSaleFigures(inv, linesByInvoice.get(id), data.settings?.tax_rate)
      const cost = costOf(inv)
      out.push({ inv, ...figs, collected: collectedAmt, cost, ...profitFor(figs.sale, cost), added: !autoIds.has(id) })
    }
    out.sort((a, b) => String(a.inv.number).localeCompare(String(b.inv.number)))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payments, date, addedIds, invoiceById, linesByInvoice, data.settings, costOverrides])

  const totals = useMemo(() => collectedTotals(rows), [rows])
  const cash = useMemo(() => cashCollectedOn(payments, date), [payments, date])
  const sold = useMemo(() => {
    const billed = billedOnDate(data.invoices || [], date)
    return soldSummary(billed.map((inv) => {
      const figs = invoiceSaleFigures(inv, linesByInvoice.get(inv.id), data.settings?.tax_rate)
      return { sale: figs.sale, cost: costOf(inv) }
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.invoices, date, linesByInvoice, data.settings, costOverrides])

  // Past days: every date with anything collected or billed, newest
  // first — pick one to load that day's sheet above.
  const history = useMemo(() => dayHistory(payments, data.invoices || [], linesByInvoice, data.settings?.tax_rate, costOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payments, data.invoices, linesByInvoice, data.settings, costOverrides])

  const activeDates = useMemo(() => new Set(history.map((d) => d.date)), [history])
  const calWeeks = useMemo(() => calendarCells(calYear, calMonth, activeDates, today), [calYear, calMonth, activeDates, today])
  const monthLabel = new Date(calYear, calMonth, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  function calStep(delta) {
    const m = calMonth + delta
    if (m < 0) { setCalYear(calYear - 1); setCalMonth(11) }
    else if (m > 11) { setCalYear(calYear + 1); setCalMonth(0) }
    else setCalMonth(m)
  }
  function calToday() {
    setCalYear(Number(String(today).slice(0, 4)))
    setCalMonth(Number(String(today).slice(5, 7)) - 1)
  }

  function changeDate(d) {
    setDate(d)
    setCalYear(Number(String(d).slice(0, 4)))
    setCalMonth(Number(String(d).slice(5, 7)) - 1)
    setAddedIds([])
    setAddMsg('')
  }

  function addInvoice() {
    const found = findInvoiceByNumber(data.invoices || [], addText)
    if (!found) { setAddMsg(`No invoice matches "${addText.trim()}".`); return }
    if (rows.some((r) => r.inv.id === found.id)) { setAddMsg(`${found.number} is already on this sheet.`); return }
    setAddedIds((ids) => [...ids, found.id])
    setAddText('')
    setAddMsg('')
  }

  function removeAdded(id) {
    setAddedIds((ids) => ids.filter((x) => x !== id))
  }

  async function saveCost(invoiceId, cost) {
    try {
      await store.setInvoiceCost(invoiceId, cost)
      setCostOverrides((m) => ({ ...m, [invoiceId]: cost }))
      // Refresh the App-level data so the cost is still there if the tab
      // is left and reopened; the override above already shows it now.
      // loadData only renders an additive "Loading…" line — it never
      // unmounts this tab mid-edit.
      if (onReload) onReload()
      return { ok: true }
    } catch (err) {
      const msg = err?.message || ''
      // Pre-migration (025 not run yet): PostgREST rejects the unknown
      // column. Say so plainly and revert — never crash the page.
      if (err?.code === 'PGRST204' || /cost_of_goods/i.test(msg)) {
        return { ok: false, message: "Cost saving isn't ready yet — the update is still deploying." }
      }
      return { ok: false, message: msg || 'Could not save the cost.' }
    }
  }

  const linkStyle = { background: 'none', border: 0, padding: 0, color: 'var(--orange-dark)', textDecoration: 'underline', font: 'inherit', fontWeight: 700, cursor: 'pointer' }

  return (
    <>
    <div className="card">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>End of day — {fmtDate(date)}</h2>
        <input type="date" value={date} onChange={(e) => changeDate(e.target.value)} aria-label="End of day date" />
      </div>
      <p className="muted small">One row per invoice with money collected on this date. Sale, Labor, Tax and the rep fill in from the invoice — type in the Cost of the goods and Profit $ and % work themselves out. Cost is saved per invoice and never shows on the invoice itself.</p>
      {payError && <div className="error">{payError}</div>}
      {isAdmin && (
        <div className="stat-strip">
          <div className="stat"><span className="num">${money(totals.totalSale)}</span><span className="label">Total sale</span></div>
          <div className="stat"><span className="num">${money(totals.totalCost)}</span><span className="label">Total cost</span></div>
          <div className="stat"><span className="num">${money(totals.totalProfit)}</span><span className="label">Total profit</span></div>
          <div className="stat"><span className="num">{totals.pct == null ? '—' : `${(totals.pct * 100).toFixed(1)}%`}</span><span className="label">Overall %</span></div>
          <div className="stat"><span className="num">${money(totals.totalLabor)}</span><span className="label">Total labor</span></div>
          <div className="stat"><span className="num">${money(totals.totalTax)}</span><span className="label">Total tax</span></div>
        </div>
      )}
      {isAdmin && totals.missingCost > 0 && (
        <p className="muted small">Cost missing on {totals.missingCost} row{totals.missingCost === 1 ? '' : 's'} — those rows aren&apos;t in the totals yet.</p>
      )}
      {isAdmin && (
        <p className="muted small">Cash collected {fmtDate(date)}: ${money(cash)}</p>
      )}
      {payLoading ? (
        <p className="muted">Loading payments…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No payments collected on {fmtDate(date)} yet — add an invoice below to record its cost.</p>
      ) : (
        <div className="table-scroll">
          <table className="list wide">
            <thead><tr><th className="nowrap">Invoice</th><th>Customer</th><th className="num">Sale</th><th className="num">Labor</th><th className="num">Tax</th><th className="num">Collected</th><th className="num">Cost</th><th className="num">Profit</th><th className="num">%</th><th>Sales rep</th><th aria-label="Remove" /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.inv.id}>
                  <td className="nowrap">
                    <button type="button" onClick={() => onOpenInvoice && onOpenInvoice(r.inv)} style={linkStyle}>{r.inv.number}</button>
                  </td>
                  <td>{ticketCustomerName(r.inv, data.customers)}</td>
                  <td className="num">${money(r.sale)}</td>
                  <td className="num">${money(r.labor)}</td>
                  <td className="num">${money(r.tax)}</td>
                  <td className="num">${money(r.collected)}</td>
                  <td className="num"><CostInput value={r.cost} onSave={(cost) => saveCost(r.inv.id, cost)} /></td>
                  <td className="num">{r.profit == null ? '—' : `$${money(r.profit)}`}</td>
                  <td className="num">{r.pct == null ? '—' : `${(r.pct * 100).toFixed(1)}%`}</td>
                  <td>{salespersonNamesOf(r.inv, data.profiles)}</td>
                  <td>{r.added && <button type="button" className="btn secondary small" onClick={() => removeAdded(r.inv.id)} aria-label={`Remove ${r.inv.number} from this sheet`}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <input
          type="text"
          value={addText}
          onChange={(e) => { setAddText(e.target.value); setAddMsg('') }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addInvoice() } }}
          placeholder="Add an invoice by number, e.g. 1009"
          aria-label="Add an invoice by number"
          style={{ minWidth: 260 }}
        />
        <button type="button" className="btn secondary" onClick={addInvoice}>Add invoice</button>
        {addMsg && <span className="muted small">{addMsg}</span>}
      </div>
    </div>
    <div className="card">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Sold today — {fmtDate(date)}</h2>
      </div>
      <p className="muted small">Invoices billed on this date — what was sold, separate from what was collected above. No typing here; it just adds up.</p>
      {sold.count === 0 ? (
        <p className="muted">Nothing billed on {fmtDate(date)} yet.</p>
      ) : isAdmin ? (
        <>
          <div className="stat-strip">
            <div className="stat"><span className="num">{sold.count}</span><span className="label">Invoices billed</span></div>
            <div className="stat"><span className="num">${money(sold.totalSold)}</span><span className="label">Total sold</span></div>
            <div className="stat"><span className="num">{sold.totalCost == null ? '—' : `$${money(sold.totalCost)}`}</span><span className="label">Total cost</span></div>
            <div className="stat"><span className="num">{sold.profit == null ? '—' : `$${money(sold.profit)}`}</span><span className="label">Profit</span></div>
            <div className="stat"><span className="num">{sold.pct == null ? '—' : `${(sold.pct * 100).toFixed(1)}%`}</span><span className="label">Margin %</span></div>
          </div>
          <p className="muted small">Cost entered on {sold.costedCount} of {sold.count} billed.</p>
        </>
      ) : (
        <p>{sold.count} invoice{sold.count === 1 ? '' : 's'} billed on {fmtDate(date)}.</p>
      )}
    </div>
    <div className="card">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Past days</h2>
      </div>
      <p className="muted small">Every day with anything collected or billed — pick a date on the calendar or in the list below to load that day&apos;s sheet above. Good for checking historically whether a day like New Year&apos;s Eve was worth being open.</p>
      <div style={{ maxWidth: 420 }}>
        <div className="row-between" style={{ marginBottom: 4 }}>
          <button type="button" className="btn secondary small" onClick={() => calStep(-1)} aria-label="Previous month">‹</button>
          <strong>{monthLabel}</strong>
          <span>
            <button type="button" className="btn secondary small" onClick={calToday} style={{ marginRight: 6 }}>Today</button>
            <button type="button" className="btn secondary small" onClick={() => calStep(1)} aria-label="Next month">›</button>
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
            <div key={i} style={{ fontSize: 11, color: 'var(--grey-700)', fontWeight: 700, padding: '4px 0' }}>{d}</div>
          ))}
          {calWeeks.flat().map((cell, i) => cell == null ? <div key={i} /> : (
            <button
              key={cell.date}
              type="button"
              onClick={() => changeDate(cell.date)}
              aria-label={`Load ${fmtDate(cell.date)}`}
              style={{
                border: 0,
                background: cell.date === date ? 'var(--orange)' : 'transparent',
                color: cell.date === date ? '#fff' : 'inherit',
                borderRadius: 8,
                width: 36, height: 38, margin: '0 auto', cursor: 'pointer',
                fontWeight: cell.isToday || cell.date === date ? 700 : 400,
                outline: cell.isToday && cell.date !== date ? '1.5px solid var(--orange)' : 'none',
                outlineOffset: 1, padding: 0,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
                fontSize: 14,
              }}
            >
              <span>{cell.day}</span>
              <span style={{ width: 4, height: 4, borderRadius: '50%', background: cell.active ? (cell.date === date ? '#fff' : 'var(--orange-dark)') : 'transparent' }} />
            </button>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: 6 }}>Dots mark days with something collected or billed. Tap a day to load its sheet.</p>
      </div>
      {payLoading ? (
        <p className="muted">Loading payments…</p>
      ) : history.length === 0 ? (
        <p className="muted">No history yet — days show up here once something is collected or billed.</p>
      ) : (
        <div className="table-scroll">
          <table className="list">
            <thead><tr><th className="nowrap">Date</th><th className="num">Collected</th><th className="num">Billed</th>{isAdmin && <><th className="num">Cash</th><th className="num">Sold</th><th className="num">Profit</th><th className="num">%</th></>}</tr></thead>
            <tbody>
              {history.map((d) => (
                <tr key={d.date}>
                  <td className="nowrap">
                    <button type="button" onClick={() => changeDate(d.date)} style={{ ...linkStyle, fontWeight: d.date === date ? 700 : 400 }}>{fmtDate(d.date)}</button>
                  </td>
                  <td className="num">{d.collectedCount} invoice{d.collectedCount === 1 ? '' : 's'}</td>
                  <td className="num">{d.billedCount} invoice{d.billedCount === 1 ? '' : 's'}</td>
                  {isAdmin && (
                    <>
                      <td className="num">${money(d.cash)}</td>
                      <td className="num">${money(d.totalSold)}</td>
                      <td className="num">{d.profit == null ? '—' : `$${money(d.profit)}`}</td>
                      <td className="num">{d.pct == null ? '—' : `${(d.pct * 100).toFixed(1)}%`}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </>
  )
}
