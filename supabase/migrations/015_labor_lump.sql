-- 015_labor_lump.sql — run once in the live Supabase SQL Editor.
--
-- Lump-sum labor on quotes/invoices (Nov 19, 2026). Bill likes the
-- per-line Labor $ boxes, but sometimes labor is a single lump sum
-- instead of a line item — so the totals block gets an editable
-- lump-sum labor amount. Labor total = sum of per-line Labor $ +
-- lump-sum labor; labor is never taxed (lump included).
--   - quotes.labor_lump / invoices.labor_lump — nullable in spirit,
--     stored as numeric(12,2) not null default 0.
--
-- SEQUENCING — run this BEFORE Bill saves a ticket after the matching
-- code deploy. The app sends `labor_lump` in the ticket insert/update
-- payload (sbSaveTicket header whitelist) and in the quote→invoice
-- conversion insert, and PostgREST rejects an unknown column (PGRST204),
-- which aborts the whole ticket save. That covers new and existing
-- quotes AND invoices, plus conversions. Quotes, invoices, vehicles,
-- search, and photos are otherwise unaffected — but do not rely on that;
-- run the migration first.
alter table public.quotes add column if not exists labor_lump numeric(12,2) not null default 0;
alter table public.invoices add column if not exists labor_lump numeric(12,2) not null default 0;
