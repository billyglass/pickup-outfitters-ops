-- ============================================================================
-- Pickup Outfitters — Shop Operations (pickup-outfitters-ops)
-- Phase 1 schema + Phase 2 numbering scaffolding
-- Run in a NEW Supabase project (separate from the Installer Job Tracker):
--   Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
-- No seed customers. Settings are seeded with the approved defaults.
-- Money is numeric(12,2) everywhere. Never float for money.
-- ============================================================================

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Sequences: the authority for numbering. settings.next_* mirrors them for
-- display / Admin editing; the sequence is what prevents duplicates.
-- Two SEPARATE systems (migration 007): quotes QT-A1001, QT-A1002, ... from
-- quote_number_seq, invoices INV-1001, INV-1002, ... from
-- invoice_number_seq. The letter in the quote prefix is what keeps a quote
-- apart from an invoice — the two can share the same numeric part.
-- The migration-006 shared sequence (ticket_number_seq) is left in the
-- live database, unused; fresh installs do not create it.
-- ---------------------------------------------------------------------------
create sequence if not exists quote_number_seq start with 1001;
create sequence if not exists invoice_number_seq start with 1001;

-- ---------------------------------------------------------------------------
-- profiles table FIRST: is_admin()/is_active_user() below reference it, and
-- Postgres validates those references at CREATE FUNCTION time, so the table
-- must exist first. The full profiles definition is repeated below (idempotent).
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  email text not null,
  role text not null check (role in ('sales', 'admin')),
  active boolean not null default true,
  mfa_enrolled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so RLS policies can call them without
-- recursing into profiles RLS).
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active = true
  );
$$;

create or replace function public.is_active_user()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and active = true
  );
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per Auth user. Role is the permission source of truth.
-- Deactivation: active=false blocks ALL data access via RLS immediately.
-- NOTE (honest limitation): RLS cannot block the Supabase Auth login itself.
-- A deactivated user can still obtain a JWT, but every table policy above
-- requires active=true, so they see nothing. To fully block login, also
-- disable the user in Supabase Auth (Dashboard -> Authentication -> Users,
-- or the Admin API). User management UI for that is Phase 2.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  email text not null,
  role text not null check (role in ('sales', 'admin')),
  active boolean not null default true,
  mfa_enrolled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists profiles_email_idx on public.profiles (lower(email));

-- Only an Admin may change role / active / mfa_enrolled.
create or replace function public.profiles_guard()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if (old.role is distinct from new.role
      or old.active is distinct from new.active
      or old.mfa_enrolled is distinct from new.mfa_enrolled)
     and not public.is_admin() then
    raise exception 'Only an Admin can change role, active status, or MFA status';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- ---------------------------------------------------------------------------
-- settings — single row (id = 1). Admin-only table.
-- Sales get tax_rate / terms only through the SECURITY DEFINER function
-- public_settings() below — they never SELECT this table.
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  id integer primary key check (id = 1),
  company_name text not null default 'Pickup Outfitters',
  company_address text,
  company_phone text,
  company_email text,
  company_website text,
  tax_rate numeric(6,4) not null default 0.0774,
  invoice_prefix text not null default 'INV-',
  quote_prefix text not null default 'QT-A',
  next_invoice_number integer not null default 1001,
  next_quote_number integer not null default 1001,
  default_payment_terms text not null default 'Net 30',
  quote_validity_days integer not null default 15,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);
insert into public.settings (id) values (1)
  on conflict (id) do nothing;

create or replace function public.public_settings()
returns table (tax_rate numeric, default_payment_terms text, quote_validity_days integer, company_name text)
language sql stable security definer
set search_path = public
as $$
  select tax_rate, default_payment_terms, quote_validity_days, company_name
  from public.settings where id = 1;
$$;

-- ---------------------------------------------------------------------------
-- customers / contacts / customer_addresses
-- ---------------------------------------------------------------------------
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  customer_type text not null default 'Retail' check (customer_type in ('Retail', 'Fleet')),
  fleet_size integer,
  flag text,
  flag_note text,
  tax_exempt boolean not null default false,
  tax_exempt_doc_note text,
  payment_terms text not null default 'Net 30',
  notes text,
  po_requirements text,
  archived_at timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index if not exists customers_company_trgm_idx
  on public.customers using gin (company gin_trgm_ops);
create index if not exists customers_created_idx on public.customers (created_at desc);
create index if not exists customers_type_idx on public.customers (customer_type);

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  name text not null,
  phone text,
  email text,
  title text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index if not exists contacts_customer_idx on public.contacts (customer_id);
create index if not exists contacts_phone_idx on public.contacts (phone);
create index if not exists contacts_email_trgm_idx on public.contacts using gin (email gin_trgm_ops);

create table if not exists public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  address_type text not null check (address_type in ('billing', 'service', 'both')),
  line1 text,
  line2 text,
  city text,
  state text,
  zip text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index if not exists customer_addresses_customer_idx
  on public.customer_addresses (customer_id);

-- ---------------------------------------------------------------------------
-- vehicles — VIN is normalized (uppercase, alphanumeric only) and stored.
-- Duplicate VINs warn in the app; they do NOT block (legitimate exceptions
-- exist, e.g. a VIN re-entered for a second customer record). Uniqueness is
-- therefore an index for fast lookup, not a hard unique constraint — see
-- README / docs. Search: full VIN, last 6, last 8 via reverse() index.
-- ---------------------------------------------------------------------------
create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  -- Nullable (migration 003): a walk-in ticket's vehicle has no customer
  -- record, so customer_id is null for those vehicles.
  customer_id uuid references public.customers (id) on delete cascade,
  vin text,
  vin_normalized text generated always as
    (upper(regexp_replace(coalesce(vin, ''), '[^A-Za-z0-9]', '', 'g'))) stored,
  year integer check (year is null or (year between 1900 and 2100)),
  make text,
  model text,
  bed_size text,
  fleet_unit text,
  color text,
  plate text,
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index if not exists vehicles_customer_idx on public.vehicles (customer_id);
create index if not exists vehicles_vin_idx on public.vehicles (vin_normalized);
create index if not exists vehicles_vin_reverse_idx
  on public.vehicles (reverse(vin_normalized));
create index if not exists vehicles_vin_trgm_idx
  on public.vehicles using gin (vin_normalized gin_trgm_ops);
create index if not exists vehicles_fleet_idx on public.vehicles (fleet_unit);
create index if not exists vehicles_plate_idx on public.vehicles (plate);

-- ---------------------------------------------------------------------------
-- products — NO cost column here, by design. Cost lives in product_costs
-- (Admin-only, below). That is what makes cost protection enforceable:
-- Postgres has no column-level RLS, and Supabase Authenticated users share
-- one DB role, so column grants cannot distinguish Sales from Admin.
-- Splitting the table is the enforceable separation.
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  part_number text,
  name text not null,
  description text,
  default_price numeric(12,2) not null default 0,
  taxable boolean not null default true,
  type text not null check (type in ('part', 'labor', 'service')),
  active boolean not null default true,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index if not exists products_part_idx on public.products (part_number);
create index if not exists products_name_trgm_idx
  on public.products using gin (name gin_trgm_ops);

create table if not exists public.product_costs (
  product_id uuid primary key references public.products (id) on delete cascade,
  cost numeric(12,2) not null default 0,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

-- Convenience view: same non-cost columns as products, for the app / API
-- layer to use instead of the table. Cost is not in this view because it
-- is not in the products table at all.
create or replace view public.products_public as
  select id, part_number, name, description, default_price, taxable, type,
         active, created_at, updated_at
  from public.products;

-- ---------------------------------------------------------------------------
-- quotes / quote_lines / quote_revisions  (Phase 2 scaffolding — tables
-- exist now so numbering, links, and search can be built on them.)
-- ---------------------------------------------------------------------------
create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  idempotency_key text unique,
  -- Nullable (migration 003): walk-in / one-off tickets have no customer
  -- record — name + phone live in customer_snapshot, customer_id is null.
  customer_id uuid references public.customers (id),
  vehicle_id uuid references public.vehicles (id),
  salesperson_id uuid references auth.users (id),
  created_by uuid references auth.users (id),
  status text not null default 'Open'
    check (status in ('Open', 'Lost')),
  issue_date date,
  expires_on date,
  follow_up_on date,
  po_number text,
  payment_terms text not null default 'Net 30',
  customer_notes text,
  internal_notes text,
  -- Snapshots taken at issue so later customer/vehicle edits don't rewrite history
  customer_snapshot jsonb,
  vehicle_snapshot jsonb,
  subtotal numeric(12,2) not null default 0,
  tax_total numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  converted_invoice_id uuid,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index if not exists quotes_customer_idx on public.quotes (customer_id);
create index if not exists quotes_status_idx on public.quotes (status);
create index if not exists quotes_number_idx on public.quotes (number);
create index if not exists quotes_po_idx on public.quotes (po_number);

create table if not exists public.quote_lines (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes (id) on delete cascade,
  product_id uuid references public.products (id),
  part_number text,
  description text not null,
  quantity numeric(10,2) not null default 1,
  unit_price numeric(12,2) not null default 0,
  labor_amount numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  taxable boolean not null default true,
  line_kind text not null default 'part' check (line_kind in ('part', 'labor', 'service')),
  line_total numeric(12,2) not null default 0,
  sort_order integer not null default 0
);
create index if not exists quote_lines_quote_idx on public.quote_lines (quote_id);
create index if not exists quote_lines_desc_trgm_idx
  on public.quote_lines using gin (description gin_trgm_ops);

create table if not exists public.quote_revisions (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes (id) on delete cascade,
  revision_no integer not null,
  snapshot jsonb not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- invoices / invoice_lines  (Phase 2 scaffolding)
-- previous_numbers keeps every former display number, searchable, so a
-- renumber never breaks a lookup by the old number.
-- ---------------------------------------------------------------------------
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  previous_numbers text[] not null default '{}',
  idempotency_key text unique,
  quote_id uuid references public.quotes (id),
  -- Nullable (migration 003): walk-in / one-off tickets, see quotes above.
  customer_id uuid references public.customers (id),
  vehicle_id uuid references public.vehicles (id),
  salesperson_id uuid references auth.users (id),
  created_by uuid references auth.users (id),
  status text not null default 'Draft'
    check (status in ('Draft', 'Issued', 'Partially Paid', 'Paid', 'Void')),
  issue_date date,
  due_date date,
  po_number text,
  payment_terms text not null default 'Net 30',
  customer_notes text,
  internal_notes text,
  customer_snapshot jsonb,
  vehicle_snapshot jsonb,
  subtotal numeric(12,2) not null default 0,
  tax_total numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  balance_due numeric(12,2) not null default 0,
  accounting_period_closed boolean not null default false,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index if not exists invoices_customer_idx on public.invoices (customer_id);
create index if not exists invoices_status_idx on public.invoices (status);
create index if not exists invoices_number_idx on public.invoices (number);
create index if not exists invoices_prev_numbers_idx
  on public.invoices using gin (previous_numbers);
create index if not exists invoices_po_idx on public.invoices (po_number);
create index if not exists invoices_due_idx on public.invoices (due_date);

create table if not exists public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  product_id uuid references public.products (id),
  part_number text,
  description text not null,
  quantity numeric(10,2) not null default 1,
  unit_price numeric(12,2) not null default 0,
  labor_amount numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  taxable boolean not null default true,
  line_kind text not null default 'part' check (line_kind in ('part', 'labor', 'service')),
  line_total numeric(12,2) not null default 0,
  sort_order integer not null default 0
);
create index if not exists invoice_lines_invoice_idx on public.invoice_lines (invoice_id);
create index if not exists invoice_lines_desc_trgm_idx
  on public.invoice_lines using gin (description gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- payments / payment_allocations / vendors / vendor_bills / vendor_payments
-- (Phase 3 scaffolding — Admin-only tables, see RLS below.)
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers (id),
  type text not null check (type in ('payment', 'deposit', 'credit', 'refund', 'adjustment')),
  payment_date date not null,
  amount numeric(12,2) not null,
  method text,
  reference text,
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index if not exists payments_customer_idx on public.payments (customer_id);

create table if not exists public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id),
  amount numeric(12,2) not null,
  created_at timestamptz not null default now()
);
create index if not exists payment_allocations_invoice_idx
  on public.payment_allocations (invoice_id);

create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  phone text,
  email text,
  payment_terms text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table if not exists public.vendor_bills (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors (id),
  vendor_invoice_number text,
  bill_date date,
  due_date date,
  category text,
  amount numeric(12,2) not null default 0,
  balance_due numeric(12,2) not null default 0,
  status text not null default 'Unpaid'
    check (status in ('Unpaid', 'Partially Paid', 'Paid', 'Overdue')),
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index if not exists vendor_bills_vendor_idx on public.vendor_bills (vendor_id);

create table if not exists public.vendor_payments (
  id uuid primary key default gen_random_uuid(),
  vendor_bill_id uuid not null references public.vendor_bills (id) on delete cascade,
  payment_date date not null,
  amount numeric(12,2) not null,
  method text,
  reference text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- installer_job_links — Phase 5 scaffolding. Links by permanent UUIDs,
-- never by invoice number alone.
-- ---------------------------------------------------------------------------
create table if not exists public.installer_job_links (
  id uuid primary key default gen_random_uuid(),
  tracker_job_id uuid not null,
  invoice_id uuid references public.invoices (id),
  customer_id uuid references public.customers (id),
  vehicle_id uuid references public.vehicles (id),
  status text,
  hours numeric(6,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists installer_job_links_tracker_idx
  on public.installer_job_links (tracker_job_id);
create index if not exists installer_job_links_invoice_idx
  on public.installer_job_links (invoice_id);

-- ---------------------------------------------------------------------------
-- audit_log — Admin-read-only. Written by the audit trigger (SECURITY
-- DEFINER), not by the app, so a user cannot edit their own trail.
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id uuid,
  action text not null,
  changed_by uuid references auth.users (id),
  changed_at timestamptz not null default now(),
  before_data jsonb,
  after_data jsonb
);
create index if not exists audit_log_record_idx
  on public.audit_log (table_name, record_id, changed_at desc);

-- ---------------------------------------------------------------------------
-- attachments — metadata only. Files themselves go to Supabase Storage
-- (Phase 6); no file bytes are stored in Postgres.
-- ---------------------------------------------------------------------------
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  record_type text not null,
  record_id uuid not null,
  file_name text not null,
  file_path text,
  file_size integer,
  uploaded_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index if not exists attachments_record_idx
  on public.attachments (record_type, record_id);

-- ---------------------------------------------------------------------------
-- customer_photos — one row per photo on a customer record (mini-CRM).
-- File bytes live in the private 'customer-photos' Storage bucket; the app
-- serves 1-hour signed URLs. Deleting the customer deletes its photos.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Triggers: updated_at / version bump, and audit logging.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  if tg_table_name not in ('settings') then
    new.version = coalesce(old.version, 1) + 1;
  end if;
  if tg_table_name in ('customers', 'vehicles', 'quotes', 'invoices') then
    new.updated_by = auth.uid();
  end if;
  return new;
end;
$$;

-- Apply to tables that carry version / updated_at.
do $$
declare t text;
begin
  for t in select unnest(array[
    'customers','contacts','customer_addresses','vehicles',
    'products','quotes','invoices','payments','vendors','vendor_bills'
  ]) loop
    execute format(
      'drop trigger if exists a_set_updated_at on public.%I; ' ||
      'create trigger a_set_updated_at before update on public.%I ' ||
      'for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

create or replace function public.audit_trigger()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.audit_log (table_name, record_id, action, changed_by, before_data, after_data)
  values (
    tg_table_name,
    coalesce(old.id, new.id),
    tg_op,
    auth.uid(),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;

-- Audit customers, vehicles, quotes, invoices (insert + update + delete).
do $$
declare t text;
begin
  for t in select unnest(array['customers','vehicles','quotes','invoices']) loop
    execute format(
      'drop trigger if exists z_audit_log on public.%I; ' ||
      'create trigger z_audit_log after insert or update or delete on public.%I ' ||
      'for each row execute function public.audit_trigger()', t, t);
  end loop;
end $$;

-- Paid / Void / closed-period invoices: only Admin may change them.
create or replace function public.invoice_guard()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('Paid', 'Void') or old.accounting_period_closed then
    if not public.is_admin() then
      raise exception 'Paid, void, or closed-period invoices can only be changed by an Admin';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists invoice_guard on public.invoices;
create trigger invoice_guard before update on public.invoices
  for each row execute function public.invoice_guard();

-- ---------------------------------------------------------------------------
-- Atomic numbering. Call inside the same transaction as the INSERT.
-- nextval() is atomic in Postgres: two concurrent callers never get the
-- same value, and the unique constraint on number is the backstop.
-- ---------------------------------------------------------------------------
create or replace function public.next_invoice_number()
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_prefix text;
  v_num bigint;
begin
  if not public.is_active_user() then
    raise exception 'Not an active user';
  end if;
  select invoice_prefix into v_prefix from public.settings where id = 1;
  -- Separate system: invoices draw from invoice_number_seq only.
  -- Loop: a manually-set number may sit ahead of the sequence, so skip
  -- any candidate that is already on an invoice.
  loop
    v_num := nextval('invoice_number_seq');
    exit when not exists (
      select 1 from public.invoices where number = v_prefix || v_num::text
    );
  end loop;
  update public.settings set next_invoice_number = v_num + 1 where id = 1;
  return v_prefix || v_num::text;
end;
$$;

create or replace function public.next_quote_number()
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_prefix text;
  v_num bigint;
begin
  if not public.is_active_user() then
    raise exception 'Not an active user';
  end if;
  select quote_prefix into v_prefix from public.settings where id = 1;
  -- Separate system: quotes draw from quote_number_seq only.
  v_num := nextval('quote_number_seq');
  update public.settings set next_quote_number = v_num + 1 where id = 1;
  return v_prefix || v_num::text;
end;
$$;

-- Admin: move the next automatic number forward (never backward past a
-- number already issued, and never below an existing invoice number).
-- Each function moves its OWN sequence (separate systems) — setting the
-- next invoice number does not move the next quote number, and vice versa.
create or replace function public.admin_set_next_invoice_number(p_next integer)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only';
  end if;
  if p_next < 1 then raise exception 'Next number must be >= 1'; end if;
  perform setval('invoice_number_seq', p_next - 1, true);
  update public.settings set next_invoice_number = p_next where id = 1;
end;
$$;

create or replace function public.admin_set_next_quote_number(p_next integer)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
begin
  if not public.is_admin() then
    raise exception 'Admin only';
  end if;
  if p_next < 1 then raise exception 'Next number must be >= 1'; end if;
  perform setval('quote_number_seq', p_next - 1, true);
  update public.settings set next_quote_number = p_next where id = 1;
end;
$$;

-- Admin manual renumber: old number is kept in previous_numbers (searchable),
-- other records are never renumbered, and the auto-number sequence is NOT
-- touched — the next new invoice still gets the next sequence number.
-- If the sequence later reaches a manually-set number,
-- next_invoice_number() skips it (see above).
create or replace function public.admin_renumber_invoice(p_invoice_id uuid, p_new_number text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_old text;
begin
  if not public.is_admin() then
    raise exception 'Admin only';
  end if;
  if p_new_number is null or btrim(p_new_number) = '' then
    raise exception 'New number must not be empty';
  end if;
  select number into v_old from public.invoices where id = p_invoice_id;
  if v_old is null then raise exception 'Invoice not found'; end if;
  if exists (select 1 from public.invoices where number = p_new_number and id <> p_invoice_id) then
    raise exception 'That invoice number is already in use';
  end if;
  -- No cross-table quote check: quotes use QT-A numbers, which can never
  -- equal an INV- number, so a manual INV-1005 is fine even if QT-A1005 exists.
  update public.invoices
    set number = p_new_number,
        previous_numbers = array_append(coalesce(previous_numbers, '{}'), v_old)
    where id = p_invoice_id;
  -- The invoice sequence is deliberately NOT advanced here. A manual
  -- number never moves the next automatic number; if the sequence later
  -- reaches a manually-set number, next_invoice_number() skips it.
  -- (The UPDATE above fires the audit trigger, so the renumber — old
  -- number to new number — is recorded in audit_log automatically.)
end;
$$;

-- ============================================================================
-- RLS — enable on every table, then policies.
-- Shared rule: every policy requires is_active_user() (profile.active=true),
-- so deactivation blocks data access immediately.
-- ============================================================================
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.customers enable row level security;
alter table public.contacts enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.vehicles enable row level security;
alter table public.products enable row level security;
alter table public.product_costs enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_lines enable row level security;
alter table public.quote_revisions enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.vendors enable row level security;
alter table public.vendor_bills enable row level security;
alter table public.vendor_payments enable row level security;
alter table public.installer_job_links enable row level security;
alter table public.audit_log enable row level security;
alter table public.attachments enable row level security;
alter table public.customer_photos enable row level security;

-- profiles: read own row, or any row if Admin. Insert own row (first setup)
-- or Admin. Update own name/email, or Admin for everything (guard trigger
-- enforces role/active changes are Admin-only).
drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select
  using (auth.uid() = id or public.is_admin());
drop policy if exists "profiles insert" on public.profiles;
create policy "profiles insert" on public.profiles for insert
  with check (auth.uid() = id or public.is_admin());
drop policy if exists "profiles update" on public.profiles;
create policy "profiles update" on public.profiles for update
  using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());

-- settings: Admin only.
drop policy if exists "settings admin only" on public.settings;
create policy "settings admin only" on public.settings for all
  using (public.is_admin()) with check (public.is_admin());

-- Shared customer/vehicle data: any active user (Sales + Admin) can read
-- and write; only Admin can delete.
-- (One policy block per table; same pattern repeated for clarity.)
drop policy if exists "customers read/write" on public.customers;
create policy "customers read/write" on public.customers for select
  using (public.is_active_user());
drop policy if exists "customers insert" on public.customers;
create policy "customers insert" on public.customers for insert
  with check (public.is_active_user());
drop policy if exists "customers update" on public.customers;
create policy "customers update" on public.customers for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "customers delete admin" on public.customers;
create policy "customers delete admin" on public.customers for delete
  using (public.is_admin());

drop policy if exists "contacts all active" on public.contacts;
create policy "contacts read active" on public.contacts for select
  using (public.is_active_user());
drop policy if exists "contacts insert active" on public.contacts;
create policy "contacts insert active" on public.contacts for insert
  with check (public.is_active_user());
drop policy if exists "contacts update active" on public.contacts;
create policy "contacts update active" on public.contacts for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "contacts delete admin" on public.contacts;
create policy "contacts delete admin" on public.contacts for delete
  using (public.is_admin());

drop policy if exists "addresses all active" on public.customer_addresses;
create policy "addresses read active" on public.customer_addresses for select
  using (public.is_active_user());
drop policy if exists "addresses insert active" on public.customer_addresses;
create policy "addresses insert active" on public.customer_addresses for insert
  with check (public.is_active_user());
drop policy if exists "addresses update active" on public.customer_addresses;
create policy "addresses update active" on public.customer_addresses for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "addresses delete admin" on public.customer_addresses;
create policy "addresses delete admin" on public.customer_addresses for delete
  using (public.is_admin());

drop policy if exists "vehicles read/write" on public.vehicles;
create policy "vehicles read/write" on public.vehicles for select
  using (public.is_active_user());
drop policy if exists "vehicles insert" on public.vehicles;
create policy "vehicles insert" on public.vehicles for insert
  with check (public.is_active_user());
drop policy if exists "vehicles update" on public.vehicles;
create policy "vehicles update" on public.vehicles for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "vehicles delete admin" on public.vehicles;
create policy "vehicles delete admin" on public.vehicles for delete
  using (public.is_admin());

-- products (no cost column): any active user can read/write the catalog.
-- Cost is in product_costs, Admin-only, below.
drop policy if exists "products all active" on public.products;
create policy "products all active" on public.products for select
  using (public.is_active_user());
drop policy if exists "products insert active" on public.products;
create policy "products insert active" on public.products for insert
  with check (public.is_active_user());
drop policy if exists "products update active" on public.products;
create policy "products update active" on public.products for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "products delete admin" on public.products;
create policy "products delete admin" on public.products for delete
  using (public.is_admin());

-- product_costs: Admin only. This is the enforceable cost protection.
drop policy if exists "product_costs admin only" on public.product_costs;
create policy "product_costs admin only" on public.product_costs for all
  using (public.is_admin()) with check (public.is_admin());

-- quotes / invoices / lines: active users read/write; Admin-only delete.
-- (The invoice_guard trigger additionally locks Paid/Void/closed invoices
-- to non-Admins on update.)
drop policy if exists "quotes all active" on public.quotes;
create policy "quotes all active" on public.quotes for select
  using (public.is_active_user());
drop policy if exists "quotes insert active" on public.quotes;
create policy "quotes insert active" on public.quotes for insert
  with check (public.is_active_user());
drop policy if exists "quotes update active" on public.quotes;
create policy "quotes update active" on public.quotes for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "quotes delete admin" on public.quotes;
create policy "quotes delete admin" on public.quotes for delete
  using (public.is_admin());

drop policy if exists "quote_lines all active" on public.quote_lines;
create policy "quote_lines read active" on public.quote_lines for select
  using (public.is_active_user());
drop policy if exists "quote_lines insert active" on public.quote_lines;
create policy "quote_lines insert active" on public.quote_lines for insert
  with check (public.is_active_user());
drop policy if exists "quote_lines update active" on public.quote_lines;
create policy "quote_lines update active" on public.quote_lines for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "quote_lines delete admin" on public.quote_lines;
create policy "quote_lines delete admin" on public.quote_lines for delete
  using (public.is_admin());

drop policy if exists "quote_revisions read active" on public.quote_revisions;
create policy "quote_revisions read active" on public.quote_revisions for select
  using (public.is_active_user());
drop policy if exists "quote_revisions insert active" on public.quote_revisions;
create policy "quote_revisions insert active" on public.quote_revisions for insert
  with check (public.is_active_user());

drop policy if exists "invoices all active" on public.invoices;
create policy "invoices all active" on public.invoices for select
  using (public.is_active_user());
drop policy if exists "invoices insert active" on public.invoices;
create policy "invoices insert active" on public.invoices for insert
  with check (public.is_active_user());
drop policy if exists "invoices update active" on public.invoices;
create policy "invoices update active" on public.invoices for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "invoices delete admin" on public.invoices;
create policy "invoices delete admin" on public.invoices for delete
  using (public.is_admin());

drop policy if exists "invoice_lines all active" on public.invoice_lines;
create policy "invoice_lines read active" on public.invoice_lines for select
  using (public.is_active_user());
drop policy if exists "invoice_lines insert active" on public.invoice_lines;
create policy "invoice_lines insert active" on public.invoice_lines for insert
  with check (public.is_active_user());
drop policy if exists "invoice_lines update active" on public.invoice_lines;
create policy "invoice_lines update active" on public.invoice_lines for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "invoice_lines delete admin" on public.invoice_lines;
create policy "invoice_lines delete admin" on public.invoice_lines for delete
  using (public.is_admin());

-- Financial tables: Admin only. Sales get a hard deny at the database —
-- not a hidden button. Any Sales query to these tables returns no rows
-- (RLS) / is rejected, including via search, export, or a direct link.
drop policy if exists "payments admin only" on public.payments;
create policy "payments admin only" on public.payments for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "payment_allocations admin only" on public.payment_allocations;
create policy "payment_allocations admin only" on public.payment_allocations for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "vendors admin only" on public.vendors;
create policy "vendors admin only" on public.vendors for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "vendor_bills admin only" on public.vendor_bills;
create policy "vendor_bills admin only" on public.vendor_bills for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "vendor_payments admin only" on public.vendor_payments;
create policy "vendor_payments admin only" on public.vendor_payments for all
  using (public.is_admin()) with check (public.is_admin());

-- installer_job_links: read for active users, write for Admin (Phase 5
-- will refine this once tracker logins exist).
drop policy if exists "installer_links read active" on public.installer_job_links;
create policy "installer_links read active" on public.installer_job_links for select
  using (public.is_active_user());
drop policy if exists "installer_links write admin" on public.installer_job_links;
create policy "installer_links write admin" on public.installer_job_links for all
  using (public.is_admin()) with check (public.is_admin());

-- audit_log: Admin read-only. App/trigger inserts bypass RLS via
-- SECURITY DEFINER; no user INSERT/UPDATE/DELETE policy exists.
drop policy if exists "audit_log admin read" on public.audit_log;
create policy "audit_log admin read" on public.audit_log for select
  using (public.is_admin());

-- attachments: active users read/insert metadata; Admin deletes.
drop policy if exists "attachments read active" on public.attachments;
create policy "attachments read active" on public.attachments for select
  using (public.is_active_user());
drop policy if exists "attachments insert active" on public.attachments;
create policy "attachments insert active" on public.attachments for insert
  with check (public.is_active_user());
drop policy if exists "attachments delete admin" on public.attachments;
create policy "attachments delete admin" on public.attachments for delete
  using (public.is_admin());

-- customer_photos: any active user can read/insert/update/delete. A photo
-- is not a business record, so delete is NOT Admin-only here (the app
-- still asks for a confirm first).
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

-- Private storage bucket for customer photos + its object policies.
-- The bucket stays private — the app serves 1-hour signed URLs, never
-- public URLs.
insert into storage.buckets (id, name, public)
values ('customer-photos', 'customer-photos', false)
on conflict (id) do nothing;
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

-- ---------------------------------------------------------------------------
-- RLS limitations — read this before relying on the policies above.
-- 1. Column-level protection is NOT possible with RLS. Cost is therefore
--    physically separated into product_costs (Admin-only table). If a cost
--    column is ever added to products, Sales WILL be able to select it.
--    Never add cost/margin columns to a Sales-readable table.
-- 2. Deactivation blocks data via RLS, but does not revoke the Auth JWT
--    or block login. Also disable the user in Supabase Auth.
-- 3. SECURITY DEFINER functions (next_*_number, admin_renumber_invoice,
--    public_settings) run as the function owner and bypass RLS by design.
--    They check is_admin() / is_active_user() internally — do not remove
--    those checks, and do not grant them to anon.
-- 4. The audit trigger is SECURITY DEFINER so it can write audit_log
--    (which has no user INSERT policy). That is intentional.
-- 5. products_public is a plain view over products (which has no cost).
--    It is a convenience, not a security boundary — the boundary is the
--    table split in (1).
-- ---------------------------------------------------------------------------
