// Sales dashboard sections (Nov 24) — visible to EVERYONE, Admin and
// Sales alike. Hard rule for this block: no money anywhere. No dollars,
// no prices, no totals — only counts, units, and dates. The Admin-only
// numbers live in AdminMetrics, rendered separately below this block.
import { useMemo } from 'react'
import {
  followUpsDue,
  expiringQuotes,
  draftInvoices,
  topProducts,
  newInCatalog,
  makesCount,
  flaggedCustomers,
  fmtUnits,
} from '../lib/salesDashboard.js'
import { ticketCustomerName, salespersonNamesOf, fmtDate } from '../lib/tickets.js'
import { BarRow } from './AdminMetrics.jsx'
import CollapsibleCard from './CollapsibleCard.jsx'

// Same labels as Products.jsx TYPE_LABELS, kept local so this component
// does not pull in the Products/store chain.
const TYPE_LABELS = { part: 'Product', service: 'Service', labor: 'Labor' }
const typeLabel = (t) => TYPE_LABELS[t] || 'Product'

function TicketRow({ left, onView, onEdit }) {
  return (
    <div className="row-between" style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
      <span>{left}</span>
      <span>
        {onView && <><button className="btn small" onClick={onView}>View</button>{' '}</>}
        {onEdit && <button className="btn secondary small" onClick={onEdit}>Edit</button>}
      </span>
    </div>
  )
}

export default function SalesDashboard({ data, today, userId, onOpenTicket, onOpenCustomer, onOpenProducts }) {
  const m = useMemo(() => ({
    followUps: followUpsDue(data.quotes, today),
    expiring: expiringQuotes(data.quotes, today),
    drafts: draftInvoices(data.invoices),
    products: topProducts(data.invoices, data.invoiceLines, data.products),
    fresh: newInCatalog(data.products),
    makes: makesCount(data.vehicles),
    flagged: flaggedCustomers(data.customers),
  }), [data, today])
  const maxUnits = m.products.length ? Math.max(...m.products.map((p) => p.units)) : 0
  const maxMake = m.makes.makes.length ? Math.max(...m.makes.makes.map((x) => x.count)) : 0

  return (
    <div className="dash-grid">
      <CollapsibleCard id="sales-followups" userId={userId} title={<>Follow-ups due ({m.followUps.length})</>} label="Follow-ups due">
        <p className="muted small">Open quotes with a follow-up date of today or earlier — most overdue first.</p>
        {m.followUps.length === 0 && <p className="muted">No follow-ups due.</p>}
        {m.followUps.map((q) => (
          <TicketRow
            key={q.id}
            left={<><strong>{ticketCustomerName(q, data.customers)}</strong> · {q.number} · follow up {fmtDate(q.follow_up_on)} · {salespersonNamesOf(q, data.profiles)}</>}
            onView={() => onOpenTicket('quote', q.id, 'view')}
            onEdit={() => onOpenTicket('quote', q.id, 'edit')}
          />
        ))}
      </CollapsibleCard>

      <CollapsibleCard id="sales-expiring" userId={userId} title={<>Expiring quotes ({m.expiring.length})</>} label="Expiring quotes">
        <p className="muted small">Open quotes expiring within 7 days, including ones already past.</p>
        {m.expiring.length === 0 && <p className="muted">No quotes expiring soon.</p>}
        {m.expiring.map((q) => (
          <TicketRow
            key={q.id}
            left={<><strong>{ticketCustomerName(q, data.customers)}</strong> · {q.number} · {q.expires_on < today ? `expired ${fmtDate(q.expires_on)}` : `expires ${fmtDate(q.expires_on)}`} · {salespersonNamesOf(q, data.profiles)}</>}
            onView={() => onOpenTicket('quote', q.id, 'view')}
            onEdit={() => onOpenTicket('quote', q.id, 'edit')}
          />
        ))}
      </CollapsibleCard>

      <CollapsibleCard id="sales-drafts" userId={userId} title={<>Drafts waiting ({m.drafts.length})</>} label="Drafts waiting">
        <p className="muted small">Invoices started but not issued yet — newest first.</p>
        {m.drafts.length === 0 && <p className="muted">No drafts waiting.</p>}
        {m.drafts.map((inv) => (
          <TicketRow
            key={inv.id}
            left={<><strong>{ticketCustomerName(inv, data.customers)}</strong> · {inv.number} · {salespersonNamesOf(inv, data.profiles)} · {fmtDate((inv.created_at || '').slice(0, 10))}</>}
            onEdit={() => onOpenTicket('invoice', inv.id, 'edit')}
          />
        ))}
      </CollapsibleCard>

      <CollapsibleCard id="sales-top-products" userId={userId} title="Top products" label="Top products">
        <p className="muted small">Most-used catalog items across sold invoices, by units.</p>
        {m.products.length === 0 && <p className="muted">No sold lines yet.</p>}
        {m.products.map((p) => (
          <BarRow
            key={p.key}
            name={p.name}
            sub={`${p.tickets} ticket${p.tickets === 1 ? '' : 's'}`}
            value={p.units}
            display={`${fmtUnits(p.units)} units`}
            max={maxUnits}
          />
        ))}
      </CollapsibleCard>

      <CollapsibleCard id="sales-makes" userId={userId} title="Vehicles by make" label="Vehicles by make">
        <p className="muted small">{m.makes.total} vehicle{m.makes.total === 1 ? '' : 's'} on file — all time.</p>
        {m.makes.makes.length === 0 && <p className="muted">No vehicles on file yet.</p>}
        {m.makes.makes.map((x) => (
          <BarRow
            key={x.make}
            name={x.make}
            value={x.count}
            display={String(x.count)}
            max={maxMake}
          />
        ))}
      </CollapsibleCard>

      <CollapsibleCard id="sales-new-catalog" userId={userId} title="New in the catalog" label="New in the catalog">
        <p className="muted small">The latest products and services added.</p>
        {m.fresh.length === 0 && <p className="muted">Nothing in the catalog yet.</p>}
        {m.fresh.map((p) => (
          <div key={p.id} className="row-between" style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
            <span><strong>{p.name}</strong> <span className="pill">{typeLabel(p.type)}</span></span>
          </div>
        ))}
        <button type="button" className="btn secondary small" style={{ marginTop: 8 }} onClick={onOpenProducts}>Browse products →</button>
      </CollapsibleCard>

      <CollapsibleCard id="sales-flagged" userId={userId} title={<>Customers to know about ({m.flagged.length})</>} label="Customers to know about">
        <p className="muted small">Flagged customers — check the note before writing them up.</p>
        {m.flagged.length === 0 && <p className="muted">No flagged customers.</p>}
        {m.flagged.map((c) => (
          <div key={c.id} className="row-between" style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
            <span>
              <button type="button" className="metric-link" onClick={() => onOpenCustomer(c.id)} title="Open customer profile"><strong>{c.company}</strong></button>
              {' '}<span className="flag-pill">{c.flag}</span>
              {c.flag_note && <div className="metric-sub">{c.flag_note}</div>}
            </span>
          </div>
        ))}
      </CollapsibleCard>
    </div>
  )
}
