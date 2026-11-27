// Admin-only dashboard metrics (Nov 24). Rendered only when isAdmin —
// Sales users never see this block (App.jsx gates the whole component),
// and nothing here shows costs or margins: billed / collected /
// open-balance totals only. All numbers come from computeAdminMetrics
// over the already-loaded data; charts are plain CSS bars, no library.
import { useMemo, useState } from 'react'
import { computeAdminMetrics, METRIC_PERIODS, money } from '../lib/adminMetrics.js'
import { useCollapsed, CollapseButton } from './CollapsibleCard.jsx'

export function BarRow({ name, sub, value, display, max, onNameClick }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div className="metric-row">
      <div className="metric-name">
        {onNameClick ? (
          <button type="button" className="metric-link" onClick={onNameClick} title="Open customer profile">{name}</button>
        ) : (
          <strong>{name}</strong>
        )}
        {sub && <div className="metric-sub">{sub}</div>}
      </div>
      <div className="metric-track" aria-hidden="true"><div className="metric-bar" style={{ width: `${pct}%` }} /></div>
      <div className="metric-value">{display}</div>
    </div>
  )
}

export default function AdminMetrics({ data, today, userId, onOpenCustomer }) {
  const [period, setPeriod] = useState('all')
  // Minimize (Nov 27): the whole block, the KPI strip, and each section
  // collapse independently, per user. Bodies hide with CSS (never
  // unmounted), so nothing here loses state.
  const { collapsed: collapsedAll, toggle: toggleAll } = useCollapsed(userId, 'admin-metrics')
  const { collapsed: collapsedKpis, toggle: toggleKpis } = useCollapsed(userId, 'admin-kpis')
  const { collapsed: collapsedLeaderboard, toggle: toggleLeaderboard } = useCollapsed(userId, 'admin-leaderboard')
  const { collapsed: collapsedTopCustomers, toggle: toggleTopCustomers } = useCollapsed(userId, 'admin-top-customers')
  const { collapsed: collapsedMakes, toggle: toggleMakes } = useCollapsed(userId, 'admin-makes')
  const { collapsed: collapsedMonthly, toggle: toggleMonthly } = useCollapsed(userId, 'admin-monthly')
  const m = useMemo(() => computeAdminMetrics(data, period, today), [data, period, today])
  const { kpis, salesmen, customers, makes, monthly, vehicleTotal } = m
  const maxBilledSalesman = salesmen.length ? Math.max(...salesmen.map((s) => s.billed)) : 0
  const maxBilledCustomer = customers.length ? Math.max(...customers.map((c) => c.billed)) : 0
  const maxMake = makes.length ? Math.max(...makes.map((x) => x.count)) : 0
  const maxMonth = monthly.length ? Math.max(...monthly.map((x) => x.total)) : 0

  return (
    <div style={{ marginTop: 8 }}>
      <div className="row-between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Admin metrics</h2>
        <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <div className="row" role="group" aria-label="Metrics period">
            {METRIC_PERIODS.map((p) => (
              <button key={p.id} type="button" className={period === p.id ? 'btn small' : 'btn secondary small'} onClick={() => setPeriod(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <CollapseButton collapsed={collapsedAll} onToggle={toggleAll} label="Admin metrics" />
        </span>
      </div>
      <div className="collapse-body" style={collapsedAll ? { display: 'none' } : undefined}>
      <p className="muted small" style={{ marginTop: -8 }}>Admin only — sales users don&apos;t see this section.</p>

      <div className="row-between" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Key figures</h3>
        <CollapseButton collapsed={collapsedKpis} onToggle={toggleKpis} label="Key figures" />
      </div>
      <div className="collapse-body" style={collapsedKpis ? { display: 'none' } : undefined}>
      <div className="stat-strip" style={{ marginBottom: 16 }}>
        <div className="stat"><span className="num">${money(kpis.billed)}</span><span className="label">Total billed</span></div>
        <div className="stat"><span className="num">${money(kpis.collected)}</span><span className="label">Collected</span></div>
        <div className="stat"><span className="num">${money(kpis.open)}</span><span className="label">Open balance</span></div>
        <div className="stat"><span className="num">${money(kpis.overdue)}</span><span className="label">Overdue</span></div>
        <div className="stat"><span className="num">${money(kpis.avg)}</span><span className="label">Avg ticket</span></div>
        <div className="stat"><span className="num">{kpis.count}</span><span className="label">Invoices</span></div>
      </div>
      </div>

      <div className="ticket-section">
        <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Salesman leaderboard</span>
          <CollapseButton collapsed={collapsedLeaderboard} onToggle={toggleLeaderboard} label="Salesman leaderboard" />
        </h3>
        <div className="collapse-body" style={collapsedLeaderboard ? { display: 'none' } : undefined}>
        {salesmen.length === 0 && <p className="muted">No invoices or quotes in this period yet.</p>}
        {salesmen.map((s) => (
          <BarRow
            key={s.id}
            name={s.name}
            sub={`${s.invoiceCount} invoice${s.invoiceCount === 1 ? '' : 's'} · Collected $${money(s.collected)} · Open $${money(s.open)} · ${s.quoteCount} quote${s.quoteCount === 1 ? '' : 's'} · Open quotes $${money(s.openQuoteValue)}`}
            value={s.billed}
            display={`$${money(s.billed)}`}
            max={maxBilledSalesman}
          />
        ))}
        {salesmen.length > 0 && (
          <p className="muted small">A ticket shared by two salesmen counts in full for each of them.</p>
        )}
        </div>
      </div>

      <div className="ticket-section">
        <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Top customers</span>
          <CollapseButton collapsed={collapsedTopCustomers} onToggle={toggleTopCustomers} label="Top customers" />
        </h3>
        <div className="collapse-body" style={collapsedTopCustomers ? { display: 'none' } : undefined}>
        {customers.length === 0 && <p className="muted">No invoices in this period yet.</p>}
        {customers.map((c) => (
          <BarRow
            key={c.key}
            name={c.walkIn ? `${c.name} (Walk-in)` : c.name}
            sub={`${c.invoiceCount} invoice${c.invoiceCount === 1 ? '' : 's'} · Open $${money(c.open)}`}
            value={c.billed}
            display={`$${money(c.billed)}`}
            max={maxBilledCustomer}
            onNameClick={c.customerId && onOpenCustomer ? () => onOpenCustomer(c.customerId) : undefined}
          />
        ))}
        </div>
      </div>

      <div className="ticket-section">
        <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Vehicles by make</span>
          <CollapseButton collapsed={collapsedMakes} onToggle={toggleMakes} label="Vehicles by make" />
        </h3>
        <div className="collapse-body" style={collapsedMakes ? { display: 'none' } : undefined}>
        <p className="muted small">{vehicleTotal} vehicle{vehicleTotal === 1 ? '' : 's'} on file — all time.</p>
        {makes.length === 0 && <p className="muted">No vehicles on file yet.</p>}
        {makes.map((x) => (
          <BarRow
            key={x.make}
            name={x.make}
            value={x.count}
            display={String(x.count)}
            max={maxMake}
          />
        ))}
        </div>
      </div>

      <div className="ticket-section">
        <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Billed by month</span>
          <CollapseButton collapsed={collapsedMonthly} onToggle={toggleMonthly} label="Billed by month" />
        </h3>
        <div className="collapse-body" style={collapsedMonthly ? { display: 'none' } : undefined}>
        {monthly.every((x) => x.total === 0) && <p className="muted">No invoices in this period yet.</p>}
        <div className="month-chart">
          {monthly.map((x) => (
            <div className="month-col" key={x.key} title={`$${money(x.total)} billed`}>
              <div className="month-value">${money(x.total)}</div>
              <div className="month-bar" style={{ height: `${maxMonth > 0 ? Math.round((x.total / maxMonth) * 120) : 0}px` }} />
              <div className="month-label">{x.label}</div>
            </div>
          ))}
        </div>
      </div>
      </div>
      </div>
    </div>
  )
}
