// Collapsible cards (Nov 27) — the ONE collapse pattern for the whole
// app. Three exports, used together:
//
//   useCollapsed(userId, cardId) — the hook. Reads the per-user
//     collapsed state from localStorage once (on mount — components
//     remount on tab switch, so the stored state is re-read then), and
//     toggles it. Everything starts expanded.
//   CollapseButton — the small quiet "−" / "+" button. Plain secondary
//     style, no orange fill: it must not shout.
//   CollapsibleCard — the standard wrapper for a plain `.card` (or any
//     block) with a title row: title on the left, any existing header
//     controls, then the minimize button at the FAR RIGHT. The body is
//     hidden with CSS (display: none), never unmounted.
//
// For `.ticket-section` blocks the h3 is a direct-child heading band
// (index.css `.ticket-section > h3`), so those do NOT use
// CollapsibleCard — they use useCollapsed + CollapseButton directly,
// with the button inside the h3 (h3 as a flex row), so the band CSS
// still applies. Same hook, same button, same persistence.
import { useCallback, useEffect, useState } from 'react'
import { readCollapsedMap, writeCollapsedMap, isCardCollapsed, withCardCollapsed, COLLAPSED_FALLBACK_USER } from '../lib/collapse.js'

export function useCollapsed(userId, cardId) {
  const key = userId || COLLAPSED_FALLBACK_USER
  const [collapsed, setCollapsed] = useState(() => isCardCollapsed(readCollapsedMap(), key, cardId))
  // The user id arrives after sign-in (App mounts with user null) — re-read
  // the stored state when the key changes, so the right person's
  // preferences load instead of the shared fallback's.
  useEffect(() => {
    setCollapsed(isCardCollapsed(readCollapsedMap(), key, cardId))
  }, [key, cardId])
  const toggle = useCallback(() => {
    const next = !collapsed
    setCollapsed(next)
    writeCollapsedMap(withCardCollapsed(readCollapsedMap(), key, cardId, next))
  }, [collapsed, key, cardId])
  return { collapsed, toggle }
}

export function CollapseButton({ collapsed, onToggle, label }) {
  return (
    <button
      type="button"
      className="btn secondary small collapse-btn"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? 'Expand' : 'Minimize'} ${label}`}
      title={collapsed ? `Expand ${label}` : `Minimize ${label}`}
    >
      {collapsed ? '+' : '−'}
    </button>
  )
}

export default function CollapsibleCard({ id, userId, title, label, titleStyle, headerExtra, className = 'card', children }) {
  const { collapsed, toggle } = useCollapsed(userId, id)
  return (
    <div className={className}>
      <div className="row-between">
        <h2 style={{ margin: 0, ...titleStyle }}>{title}</h2>
        <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          {headerExtra}
          <CollapseButton collapsed={collapsed} onToggle={toggle} label={label || (typeof title === 'string' ? title : id)} />
        </span>
      </div>
      <div className="collapse-body" style={collapsed ? { display: 'none' } : undefined}>
        {children}
      </div>
    </div>
  )
}
