-- 014_customer_notes_log.sql — run once in the live Supabase SQL Editor.
--
-- Dated running log for customer notes (Nov 19, 2026). Bill wants notes
-- as a dated log on the customer profile — viewable and addable without
-- opening Edit — instead of the single notes box that got overwritten.
--   - customer_notes table — one row per note; the app shows newest
--     first, with the date (and the author's name when known).
--   - Existing notes are imported: one log entry per customer that had
--     text in customers.notes, dated with that customer's updated_at
--     (the original note date was never stored — updated_at is the best
--     available proxy; author is null for imported notes).
--   - customers.notes stays in the DB, unused. The app no longer reads
--     or writes it after this change; the values live on in the log.
--
-- SEQUENCING — run this BEFORE Bill opens a customer profile after the
-- matching code deploy. The profile's Notes section queries the
-- customer_notes table; until this runs, the list query fails and the
-- section shows a plain "Could not load notes" error instead of the log
-- (it fails gracefully — the rest of the profile still loads). Customer
-- saves, quotes, invoices, vehicles, search, and photos are unaffected:
-- this migration adds a table and copies text — it changes no existing
-- column and no other feature reads this table.
create table if not exists public.customer_notes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  body text not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index if not exists customer_notes_customer_idx
  on public.customer_notes (customer_id, created_at desc);

alter table public.customer_notes enable row level security;

-- customer_notes: any active user can read/insert/update/delete. A note
-- is not a business record, so delete is NOT Admin-only here (the app
-- still asks for a confirm first) — same as customer_photos.
drop policy if exists "customer_notes read active" on public.customer_notes;
create policy "customer_notes read active" on public.customer_notes for select
  using (public.is_active_user());
drop policy if exists "customer_notes insert active" on public.customer_notes;
create policy "customer_notes insert active" on public.customer_notes for insert
  with check (public.is_active_user());
drop policy if exists "customer_notes update active" on public.customer_notes;
create policy "customer_notes update active" on public.customer_notes for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "customer_notes delete active" on public.customer_notes;
create policy "customer_notes delete active" on public.customer_notes for delete
  using (public.is_active_user());

-- Carry over whatever was already written in the old notes box, so
-- nothing Bill wrote is lost.
insert into public.customer_notes (customer_id, body, created_by, created_at)
select id, notes, null, updated_at
from public.customers
where notes is not null and btrim(notes) <> '';
