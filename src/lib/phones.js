// Phone formatting (Nov 23, 2026): Bill wants every phone number to look
// the same — (314) 892-0032 — no matter how it was typed in.
// Format on BLUR only (never on every keystroke, so partial typing is never
// destroyed) and on SAVE as a safety net; format on READ at display sites so
// older unformatted numbers print the same way. Stored digits are never
// changed — only the punctuation around them.

export function digitsOnly(value) {
  return String(value == null ? '' : value).replace(/[^0-9]/g, '')
}

export function formatPhone(value) {
  const input = value == null ? '' : String(value)
  let d = digitsOnly(input)
  // A leading 1 (country code) is dropped: 13148920032 -> (314) 892-0032.
  if (d.length === 11 && d[0] === '1') d = d.slice(1)
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  // Anything else (too short, too long, empty) comes back unchanged, so a
  // half-typed number is never mangled.
  return input
}

// Does a search query match a phone? Digits compare, so typing 3148920032
// finds (314) 892-0032. A query with no digits falls back to plain text.
export function phoneMatches(query, phone) {
  const qd = digitsOnly(query)
  const pd = digitsOnly(phone)
  if (qd && pd) return pd.includes(qd)
  return String(phone || '').toLowerCase().includes(String(query || '').toLowerCase())
}
