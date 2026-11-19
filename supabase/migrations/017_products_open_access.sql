-- 017_products_open_access.sql — run once in the live Supabase SQL Editor.
--
-- Shared products-and-services catalog (Nov 19, 2026). Bill explicitly
-- overrides the original Admin-only cost rule: the Products tab is now a
-- shared catalog for everyone — any active user (Sales + Admin) can view,
-- add, and edit products/services INCLUDING the cost, so a salesman can
-- price a custom service when Bill isn't there. Cost still lives in the
-- separate product_costs table (no cost column is added to products);
-- what changes is who may read/write that table.
--   - product_costs RLS: any active user can select/insert/update; delete
--     stays Admin-only.
--   - products RLS: select/insert/update were already any active user;
--     DELETE changes from Admin-only to any active user (Nov 19 — Bill's
--     correction: anyone can delete a product). The delete BUTTON still
--     lives only in the edit form's danger zone behind a two-step confirm,
--     never on a list row — the same "delete lives in the edit tab" pattern
--     as customers, vehicles, quotes, and invoices.
--   - product_notes table — dated running log on a product/service record,
--     same shape/RLS as customer_notes (any active user, delete not
--     Admin-only).
--   - product_photos table + PRIVATE storage bucket 'product-photos' —
--     same shape/RLS/policies as the customer-photos bucket (012).
--   - No new column lands in the products table, so the products save
--     payload is unchanged. The `type` column already exists
--     ('part'/'labor'/'service'); the app now labels it Product/Service/
--     Labor — no data change needed.
--
-- SEQUENCING — run this BEFORE Bill (or a salesman) uses the Products tab
-- after the matching code deploy:
--   (a) The tab is visible to everyone after the deploy, but until this
--       runs, Sales users are still blocked by RLS on product_costs: the
--       catalog loads (products RLS was already open) but every product's
--       cost shows as blank/0 for Sales, and saving a product as Sales
--       FAILS — the app upserts the cost row after saving the product row,
--       and the upsert is rejected by the still-Admin-only policy, so the
--       save throws with an error. (Admin saves work pre-migration: Admins
--       could already write product_costs. The product row itself saves
--       before the cost upsert, so a failed Sales save can leave a product
--       with no cost row — retry the save after the migration runs and the
--       cost lands.) Deleting a product as Sales also fails until this runs
--       (delete is still Admin-only RLS) — the button is visible in the
--       edit form, the delete itself errors.
--   (b) The PGRST204 pattern (unknown column in a save payload, as with
--       color/bed-size/labor-lump) does NOT apply here: no new column is
--       added to products, so the product insert/update payload is exactly
--       what it was. Only the separate product_costs upsert is affected,
--       per (a).
--   (c) The Notes/Photos sections on a product detail query the new
--       tables/bucket, so until this runs they fail gracefully (plain
--       "Could not load notes/photos" error, rest of the detail still
--       loads) and no note/photo can be added. Quotes, invoices, vehicles,
--       search, customers, and payments are unaffected.

-- product_costs: open to any active user for select/insert/update.
-- Delete stays Admin-only (a cost row is deleted only with its product,
-- which is itself Admin-only delete).
drop policy if exists "product_costs admin only" on public.product_costs;
drop policy if exists "product_costs read active" on public.product_costs;
create policy "product_costs read active" on public.product_costs for select
  using (public.is_active_user());
drop policy if exists "product_costs insert active" on public.product_costs;
create policy "product_costs insert active" on public.product_costs for insert
  with check (public.is_active_user());
drop policy if exists "product_costs update active" on public.product_costs;
create policy "product_costs update active" on public.product_costs for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "product_costs delete admin" on public.product_costs;
create policy "product_costs delete admin" on public.product_costs for delete
  using (public.is_admin());

-- products delete: any active user (was Admin-only). The button still
-- lives only in the edit form's danger zone, never on a list row.
drop policy if exists "products delete admin" on public.products;
drop policy if exists "products delete active" on public.products;
create policy "products delete active" on public.products for delete
  using (public.is_active_user());

-- product_notes — dated running log on a product/service record.
create table if not exists public.product_notes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  body text not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index if not exists product_notes_product_idx
  on public.product_notes (product_id, created_at desc);

alter table public.product_notes enable row level security;

drop policy if exists "product_notes read active" on public.product_notes;
create policy "product_notes read active" on public.product_notes for select
  using (public.is_active_user());
drop policy if exists "product_notes insert active" on public.product_notes;
create policy "product_notes insert active" on public.product_notes for insert
  with check (public.is_active_user());
drop policy if exists "product_notes update active" on public.product_notes;
create policy "product_notes update active" on public.product_notes for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "product_notes delete active" on public.product_notes;
create policy "product_notes delete active" on public.product_notes for delete
  using (public.is_active_user());

-- product_photos — one row per photo on a product/service record.
create table if not exists public.product_photos (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  storage_path text not null,
  file_name text,
  caption text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index if not exists product_photos_product_idx
  on public.product_photos (product_id);

alter table public.product_photos enable row level security;

drop policy if exists "product_photos read active" on public.product_photos;
create policy "product_photos read active" on public.product_photos for select
  using (public.is_active_user());
drop policy if exists "product_photos insert active" on public.product_photos;
create policy "product_photos insert active" on public.product_photos for insert
  with check (public.is_active_user());
drop policy if exists "product_photos update active" on public.product_photos;
create policy "product_photos update active" on public.product_photos for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "product_photos delete active" on public.product_photos;
create policy "product_photos delete active" on public.product_photos for delete
  using (public.is_active_user());

-- Private storage bucket for product photos.
insert into storage.buckets (id, name, public)
values ('product-photos', 'product-photos', false)
on conflict (id) do nothing;

-- Storage policies for that bucket (storage.objects RLS is on by default).
-- Active users only; the bucket stays private — the app serves 1-hour
-- signed URLs, never public URLs.
drop policy if exists "product photos upload" on storage.objects;
create policy "product photos upload" on storage.objects for insert
  to authenticated
  with check (bucket_id = 'product-photos' and public.is_active_user());
drop policy if exists "product photos view" on storage.objects;
create policy "product photos view" on storage.objects for select
  to authenticated
  using (bucket_id = 'product-photos' and public.is_active_user());
drop policy if exists "product photos delete" on storage.objects;
create policy "product photos delete" on storage.objects for delete
  to authenticated
  using (bucket_id = 'product-photos' and public.is_active_user());
