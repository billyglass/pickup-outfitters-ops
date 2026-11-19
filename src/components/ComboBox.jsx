import { useEffect, useMemo, useState } from 'react'

// Type-to-search dropdown, shared everywhere a long list needs picking:
// customer filters on Quotes / Invoices / Search, and the customer field
// on the vehicle form. (The ticket customer picker in TicketForm has the
// same behaviour with extra contact-name matching — it predates this and
// was left alone.) Type to narrow, click (or arrow keys + Enter) to pick.
// The first option is usually the "all / none" choice (value '').
export default function ComboBox({ options, value, onChange, placeholder, emptyText, disabled, ariaLabel }) {
  const labelOf = (v) => options.find((o) => o.value === v)?.label || ''
  const [query, setQuery] = useState(() => labelOf(value))
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)

  // Keep the shown text in sync when the selection changes elsewhere.
  // Options is a fresh array each render, so only value is a dep.
  useEffect(() => { setQuery(labelOf(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const scored = options.map((o) => {
      const hay = (o.label || '').toLowerCase()
      return { o, starts: q !== '' && hay.startsWith(q), contains: q === '' || hay.includes(q) }
    }).filter((s) => s.contains)
    scored.sort((a, b) => (b.starts - a.starts) || 0)
    return scored.map((s) => s.o)
  }, [options, query])
  const shown = matches.slice(0, 8)

  function pick(o) {
    onChange(o.value)
    setQuery(o.label)
    setOpen(false)
  }

  return (
    <div className="combo" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) { setQuery(labelOf(value)); setOpen(false) } }}>
      <input
        value={query}
        disabled={disabled}
        autoComplete="off"
        placeholder={placeholder || 'Type to search…'}
        aria-label={ariaLabel}
        onFocus={(e) => { setOpen(true); setHi(0); e.target.select() }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setHi(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, shown.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); if (open && shown[hi]) pick(shown[hi]) }
          else if (e.key === 'Escape') { setQuery(labelOf(value)); setOpen(false) }
        }}
      />
      {open && !disabled && (
        <div className="combo-list" role="listbox">
          {shown.length === 0 ? (
            <div className="combo-item muted">{emptyText || `No matches for “${query.trim()}”.`}</div>
          ) : (
            shown.map((o, i) => (
              <div
                key={o.value === '' ? 'all' : o.value} role="option" aria-selected={i === hi}
                className={`combo-item${i === hi ? ' active' : ''}${o.value === value ? ' selected' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); pick(o) }}
                onMouseEnter={() => setHi(i)}
              >
                <strong>{o.label}</strong>{o.tag ? <> <span className="pill">{o.tag}</span></> : ''}{o.sub ? <span className="muted small"> · {o.sub}</span> : ''}
              </div>
            ))
          )}
          {matches.length > shown.length && (
            <div className="combo-foot muted small">Showing {shown.length} of {matches.length} — keep typing to narrow it down.</div>
          )}
        </div>
      )}
    </div>
  )
}
