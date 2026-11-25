-- 025_invoice_cost_of_goods.sql — run once in the live Supabase SQL Editor.
--
-- End-of-day sheet (Nov 25, 2026): cost of goods per invoice, entered only
-- on the End of day tab — never on the invoice form. One number per
-- invoice: the sheet auto-fills Sale / Labor / Tax from the invoice and
-- Profit = Sale − Cost, % = Profit / Sale (the spreadsheet's math).
-- No data change, no RLS change: the "invoices update active" policy
-- already lets any active user update an invoice row (Sales save tickets
-- today), and the invoice_guard trigger still blocks non-Admin changes
-- to Paid / Void / closed-period invoices.
--
-- The code deploy that adds setInvoiceCost must land before or with this
-- migration: until it runs, the update fails with PGRST204 (unknown
-- column) and the app shows "Cost saving isn't ready yet" instead of
-- breaking the page. Invoices load with select('*'), so the read path is
-- safe pre-migration.

alter table public.invoices add column if not exists cost_of_goods numeric(12,2);
