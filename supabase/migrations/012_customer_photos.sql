-- 012_customer_photos.sql — run once in the live Supabase SQL Editor.
--
-- Mini-CRM on the customer profile (Nov 19, 2026): a photo gallery for
-- customer records (especially fleet customers) plus a fleet-size field.
--
-- 1. customers.fleet_size — approximate number of vehicles in the fleet.
--    Nullable; blank is fine for retail customers and small fleets.
-- 2. customer_photos table — one row per uploaded photo; the file bytes
--    live in Supabase Storage (private bucket 'customer-photos'), never
--    in Postgres. Photos are shown via 1-hour signed URLs from the app.
-- 3. Storage bucket 'customer-photos' (PRIVATE) + storage.objects
--    policies: any active user (Sales + Admin) can upload, view, and
--    delete photos in that bucket. The bucket must stay private — never
--    flip it public; the app only ever serves signed URLs.
--
-- SEQUENCING — run this BEFORE Bill uses the Photos section or saves a
-- customer after the matching code deploy:
--   - Photo upload fails until this runs (no customer_photos table and
--     no 'customer-photos' bucket — the upload errors and nothing saves).
--   - Customer saves ALSO fail until this runs: the app sends fleet_size
--     in the customer insert/update payload, and PostgREST rejects an
--     unknown column (PGRST204), which aborts the whole customer save.
--     That includes new customers, edits, and walk-in save-as-customer.
--   - Everything else (quotes, invoices, vehicles, search) is unaffected.

alter table public.customers
  add column if not exists fleet_size integer;

create table if not exists public.customer_photos (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  storage_path text not null,
  file_name text,
  caption text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index if not exists customer_photos_customer_idx
  on public.customer_photos (customer_id);

alter table public.customer_photos enable row level security;

-- Photos follow the shared customer/vehicle rule, except delete: a photo
-- is not a business record, so any active user may delete one (the app
-- still asks for a confirm first). No Admin-only delete here.
drop policy if exists "customer_photos read active" on public.customer_photos;
create policy "customer_photos read active" on public.customer_photos for select
  using (public.is_active_user());
drop policy if exists "customer_photos insert active" on public.customer_photos;
create policy "customer_photos insert active" on public.customer_photos for insert
  with check (public.is_active_user());
drop policy if exists "customer_photos update active" on public.customer_photos;
create policy "customer_photos update active" on public.customer_photos for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "customer_photos delete active" on public.customer_photos;
create policy "customer_photos delete active" on public.customer_photos for delete
  using (public.is_active_user());

-- Private storage bucket for customer photos.
insert into storage.buckets (id, name, public)
values ('customer-photos', 'customer-photos', false)
on conflict (id) do nothing;

-- Storage policies for that bucket (storage.objects RLS is on by default).
-- Active users only; the bucket stays private — the app serves 1-hour
-- signed URLs, never public URLs.
drop policy if exists "customer photos upload" on storage.objects;
create policy "customer photos upload" on storage.objects for insert
  to authenticated
  with check (bucket_id = 'customer-photos' and public.is_active_user());
drop policy if exists "customer photos view" on storage.objects;
create policy "customer photos view" on storage.objects for select
  to authenticated
  using (bucket_id = 'customer-photos' and public.is_active_user());
drop policy if exists "customer photos delete" on storage.objects;
create policy "customer photos delete" on storage.objects for delete
  to authenticated
  using (bucket_id = 'customer-photos' and public.is_active_user());
