// Name formatting (Nov 18, 2026): Bill wants customer names — first/last
// and company names — to look consistent, so they are automatically
// title-cased when typed in (on blur in the form) and again on save as a
// safety net. Existing names are NOT rewritten retroactively; they change
// only the next time the record is edited and saved.
//
// Rules: capitalize the first letter of each word, lowercase the rest;
// hyphenated parts each capitalized (Smith-Jones); Mc- names (McDonald)
// and O'- names (O'Brien); common business suffixes/acronyms stay
// uppercase (LLC, INC, LTD, CO, CORP, DBA); small words (and, of, the,
// for) stay lowercase unless they are the first word. Extra spaces are
// collapsed. Idempotent: running it twice gives the same result.

const SMALL_WORDS = new Set(['and', 'of', 'the', 'for'])
const UPPERCASE_WORDS = new Set(['llc', 'inc', 'ltd', 'co', 'corp', 'dba'])

function capPart(part) {
  if (!part) return part
  if (/^mc[a-z]/.test(part)) return 'Mc' + part[2].toUpperCase() + part.slice(3)
  if (/^o'[a-z]/.test(part)) return "O'" + part[2].toUpperCase() + part.slice(3)
  return part.charAt(0).toUpperCase() + part.slice(1)
}

function titleCaseWord(word, isFirst) {
  const lower = word.toLowerCase()
  if (!isFirst && SMALL_WORDS.has(lower)) return lower
  if (UPPERCASE_WORDS.has(lower)) return lower.toUpperCase()
  // Split on hyphens and periods, keeping the separators, so each part is
  // capitalized (Smith-Jones, A.J. Smith).
  return lower
    .split(/([-.])/)
    .map((part) => (part === '-' || part === '.' ? part : capPart(part)))
    .join('')
}

export function titleCaseName(value) {
  if (value == null) return value === '' ? '' : value
  const cleaned = String(value).trim().replace(/\s+/g, ' ')
  if (!cleaned) return ''
  return cleaned
    .split(' ')
    .map((word, i) => titleCaseWord(word, i === 0))
    .join(' ')
}
