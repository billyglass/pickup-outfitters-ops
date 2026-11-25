// AR aging (Phase 3, Nov 25) — pure helpers for the Accounts receivable
// report. Aging runs off the invoice's due date, which only starts
// counting when the invoice is billed: Complete & bill stamps the billing
// date and the due date from terms (Nov 25 model). An Open (Issued)
// invoice that hasn't been billed yet has no due date, so nothing is due
// on it — it ages in the "Not yet billed" bucket, not in Current.
import { roundCents } from './tickets.js'

export const AGING_BUCKETS = ['not-billed', 'current', '1-30', '31-60', '61-90', '90+']

export const AGING_BUCKET_LABELS = {
  'not-billed': 'Not yet billed',
  current: 'Current',
  '1-30': '1–30 days',
  '31-60': '31–60 days',
  '61-90': '61–90 days',
  '90+': '90+ days',
}

export function agingBucketLabel(bucket) {
  return AGING_BUCKET_LABELS[bucket] || bucket
}

// Whole days between two YYYY-MM-DD dates (a - b), parsed as UTC so the
// shop's timezone never shifts a day boundary.
export function daysBetween(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(a || '').slice(0, 10))
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b || '').slice(0, 10))
  if (!pa || !pb) return null
  const ms = Date.UTC(+pa[1], +pa[2] - 1, +pa[3]) - Date.UTC(+pb[1], +pb[2] - 1, +pb[3])
  return Math.round(ms / 86400000)
}

// Days an invoice is past due (today - due_date). Null when the invoice
// has no due date (not yet billed). Zero or negative when the due date is
// today or still in the future.
export function daysPastDue(invoice, todayStr) {
  if (!invoice || !invoice.due_date) return null
  return daysBetween(todayStr, invoice.due_date)
}

// Which aging bucket an invoice belongs in. Boundary rule: due yesterday
// is 1-30; due exactly 30 days ago is 1-30; 31 is 31-60; 60 is 31-60;
// 61 is 61-90; 90 is 61-90; 91 is 90+.
export function agingBucket(invoice, todayStr) {
  if (!invoice || !invoice.due_date) return 'not-billed'
  const d = daysPastDue(invoice, todayStr)
  if (d === null || d <= 0) return 'current'
  if (d <= 30) return '1-30'
  if (d <= 60) return '31-60'
  if (d <= 90) return '61-90'
  return '90+'
}

// An invoice belongs in AR aging only when it is a live, unpaid
// receivable: Open (Issued), Billed, or Partially Paid with a positive
// balance. Drafts are still being written, Paid/Void are done, and a zero
// or negative balance (overpaid = a credit, not an amount owed) is not a
// receivable.
export function isAgingInvoice(invoice) {
  if (!invoice) return false
  if (!['Issued', 'Billed', 'Partially Paid'].includes(invoice.status)) return false
  return roundCents(Number(invoice.balance_due ?? invoice.total ?? 0)) > 0
}

// Totals for the aging report: the total open balance, one total per
// bucket, and creditsTotal — the sum of negative balances on live
// invoices (overpaid = a credit), reported as a positive number. Only
// the buckets carry receivables; credits are reported separately.
export function agingSummary(invoices, todayStr) {
  const buckets = { 'not-billed': 0, current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }
  let total = 0
  let creditsTotal = 0
  for (const inv of invoices || []) {
    const bal = roundCents(Number(inv.balance_due ?? inv.total ?? 0))
    if (isAgingInvoice(inv)) {
      const b = agingBucket(inv, todayStr)
      buckets[b] = roundCents(buckets[b] + bal)
      total = roundCents(total + bal)
    } else if (['Issued', 'Billed', 'Partially Paid'].includes(inv.status) && bal < 0) {
      creditsTotal = roundCents(creditsTotal - bal)
    }
  }
  return { total, buckets, creditsTotal }
}
