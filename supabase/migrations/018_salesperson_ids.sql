-- 018_salesperson_ids.sql — run once in the live Supabase SQL Editor.
--
-- Multiple salespeople per ticket (Nov 23, 2026). Bill: two salesmen
-- sometimes work one ticket together and both get credit, and one
-- salesman sometimes writes a ticket up for another — so a ticket now
-- carries salesperson_ids, an array of profile UUIDs, instead of a
-- single salesperson_id.
--   - quotes.salesperson_ids / invoices.salesperson_ids — uuid[] not
--     null default '{}', backfilled from the old single salesperson_id
--     (ARRAY[salesperson_id]) where one was set.
--   - The old salesperson_id column is LEFT in place as legacy
--     (project precedent: plate, notes, discount columns were left
--     unused rather than dropped) — the app no longer reads or writes
--     it. No DB function, trigger, or RLS policy references it.
--
-- SEQUENCING — run this BEFORE Bill saves a ticket after the matching
-- code deploy. The app sends `salesperson_ids` in the ticket
-- insert/update payload (sbSaveTicket header whitelist) and in the
-- quote→invoice conversion insert, and PostgREST rejects an unknown
-- column (PGRST204), which aborts the whole ticket save. That covers
-- new and existing quotes AND invoices, plus conversions. Until this
-- runs, NO quote/invoice save or conversion works. Local mode is
-- unaffected.
alter table public.quotes add column if not exists salesperson_ids uuid[] not null default '{}';
alter table public.invoices add column if not exists salesperson_ids uuid[] not null default '{}';

update public.quotes
  set salesperson_ids = array[salesperson_id]
  where salesperson_id is not null
    and salesperson_ids = '{}';
update public.invoices
  set salesperson_ids = array[salesperson_id]
  where salesperson_id is not null
    and salesperson_ids = '{}';
