-- 026_end_of_day_added.sql — run once in the live Supabase SQL Editor.
--
-- End-of-day sheet (Nov 27, 2026): invoices added by number now stick
-- to the day instead of living in React state — they survive refreshes
-- and tab switches until the day is closed out. Two small tables:
--   end_of_day_added — one row per invoice added to a day's sheet
--     (unique per day + invoice, so adding the same invoice twice is a
--     no-op; deleting the invoice deletes its rows).
--   end_of_day_closes — one row per closed day (closed_by NULL means
--     the day closed itself at end of day, via autoClosePastDays).
-- Closing a day only ever touches these two tables — payments, costs,
-- and invoices are never deleted or changed by closing.
--
-- The code deploy that uses these tables must land before or with this
-- migration: until it runs, the app keeps the old in-memory behavior
-- (an added invoice shows on the sheet now but does not stick after a
-- refresh) and the Close day button says the update is still deploying
-- instead of breaking the page.
--
-- Idempotent — safe to re-run.

create table if not exists public.end_of_day_added (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  added_by uuid,
  created_at timestamptz not null default now(),
  unique (day, invoice_id)
);
create index if not exists end_of_day_added_day_idx
  on public.end_of_day_added (day);

create table if not exists public.end_of_day_closes (
  day date primary key,
  closed_by uuid,
  closed_at timestamptz not null default now()
);

alter table public.end_of_day_added enable row level security;
alter table public.end_of_day_closes enable row level security;

drop policy if exists "end_of_day_added read active" on public.end_of_day_added;
create policy "end_of_day_added read active" on public.end_of_day_added for select
  using (public.is_active_user());
drop policy if exists "end_of_day_added insert active" on public.end_of_day_added;
create policy "end_of_day_added insert active" on public.end_of_day_added for insert
  with check (public.is_active_user());
drop policy if exists "end_of_day_added delete active" on public.end_of_day_added;
create policy "end_of_day_added delete active" on public.end_of_day_added for delete
  using (public.is_active_user());

drop policy if exists "end_of_day_closes read active" on public.end_of_day_closes;
create policy "end_of_day_closes read active" on public.end_of_day_closes for select
  using (public.is_active_user());
drop policy if exists "end_of_day_closes insert active" on public.end_of_day_closes;
create policy "end_of_day_closes insert active" on public.end_of_day_closes for insert
  with check (public.is_active_user());
drop policy if exists "end_of_day_closes delete active" on public.end_of_day_closes;
create policy "end_of_day_closes delete active" on public.end_of_day_closes for delete
  using (public.is_active_user());
