-- 013_customer_flag.sql — run once in the live Supabase SQL Editor.
--
-- Customer flags (Nov 19, 2026). Bill wants to flag a customer (e.g.
-- "Needy") with a short note, so the flag pops up as an amber banner
-- when anyone opens the account or makes a quote/invoice for them.
--   - customers.flag — the flag itself, free text in the DB (the app
--     offers presets: Needy, Slow payer, VIP, Check with Bill first,
--     Do not discount; a custom flag stays possible later).
--   - customers.flag_note — a short note, e.g. "Calls twice a day,
--     wants updates". Cleared when the flag is cleared.
-- Both nullable, no backfill: existing customers simply have no flag
-- until someone sets one.
--
-- SEQUENCING — run this BEFORE Bill saves a customer after the matching
-- code deploy. The app sends `flag` and `flag_note` in the customer
-- insert/update payload, and PostgREST rejects an unknown column
-- (PGRST204), which aborts the whole customer save. That includes new
-- customers, edits, and walk-in save-as-customer. Everything else
-- (quotes, invoices, vehicles, search, photos) is unaffected.
alter table public.customers
  add column if not exists flag text,
  add column if not exists flag_note text;
