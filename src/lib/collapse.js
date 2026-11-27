// Collapsed (minimized) card state (Nov 27) — one shared pattern for
// every collapsible section in the app. Bill's ask: anyone can minimize
// any section; the header stays, the body collapses. Persistence is per
// person: one localStorage map, keyed by user id, then card id — so Jeff
// minimizing a section does not change Bill's view and vice versa.
// Same key style as the other localStorage maps in this app
// (po_ops_*_v1; see LS_CHAT_SEEN in store.js).
//
// Collapsing only hides the body with CSS (display: none) — it never
// unmounts anything, so no timers, state, or in-progress work is lost
// (the Shop chat keeps polling while collapsed). Everything starts
// expanded: an unknown card, a missing user, or corrupt stored JSON all
// read as expanded.

export const LS_COLLAPSED = 'po_ops_collapsed_v1'
export const COLLAPSED_FALLBACK_USER = 'shared'

export function readCollapsedMap() {
  try {
    const raw = localStorage.getItem(LS_COLLAPSED)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function writeCollapsedMap(map) {
  try {
    localStorage.setItem(LS_COLLAPSED, JSON.stringify(map || {}))
  } catch {
    // Private mode / storage full / unavailable — collapsing just won't
    // persist for this session. Never throw on a UI preference.
  }
}

export function isCardCollapsed(map, userId, cardId) {
  const perUser = (map || {})[userId || COLLAPSED_FALLBACK_USER]
  return !!(perUser && perUser[cardId])
}

// Returns a NEW map with the card's state set. Collapsed cards are stored
// as `true`; expanded cards are REMOVED from the map (not stored as
// false), so the map only ever holds what is actually minimized.
export function withCardCollapsed(map, userId, cardId, collapsed) {
  const key = userId || COLLAPSED_FALLBACK_USER
  const next = { ...(map || {}) }
  const perUser = { ...(next[key] || {}) }
  if (collapsed) perUser[cardId] = true
  else delete perUser[cardId]
  if (Object.keys(perUser).length) next[key] = perUser
  else delete next[key]
  return next
}
