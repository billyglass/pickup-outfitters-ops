// Minimal CSV parser — handles quoted fields, commas, and doubled quotes.
// No extra dependency. Used for the QuickBooks customer import preview.

export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export function rowsToObjects(rows) {
  if (!rows.length) return []
  const headers = rows[0].map((h) => (h || '').trim())
  return rows.slice(1).map((r) => {
    const obj = {}
    headers.forEach((h, i) => {
      obj[h] = (r[i] ?? '').trim()
    })
    return obj
  })
}

export function csvEscape(value) {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function downloadCsv(filename, headers, rows) {
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((r) => r.map(csvEscape).join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

// QuickBooks customer import template — columns match docs/QUICKBOOKS_IMPORT.md
export const QB_TEMPLATE_HEADERS = [
  'Company',
  'Contact',
  'Phone',
  'Email',
  'Billing Address',
  'Billing City',
  'Billing State',
  'Billing ZIP',
  'Terms',
  'Tax Exempt',
]

export function downloadQbTemplate() {
  downloadCsv('quickbooks-customers-template.csv', QB_TEMPLATE_HEADERS, [
    ['Example Company LLC', 'Jane Smith', '314-555-0100', 'jane@example.com', '123 Main St', 'St. Ann', 'MO', '63074', 'Net 30', 'No'],
  ])
}

export function normalizeVin(vin) {
  return String(vin || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

export function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9]/g, '')
}
