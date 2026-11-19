-- 010_invoice_renumber.sql — run once in the live Supabase SQL Editor.
--
-- Admin manual invoice renumber (Nov 19, 2026). Bill wants to change an
-- invoice number to whatever he wants — or delete an invoice — without
-- touching any other invoice's number.
--
-- 1. previous_numbers on invoices: the old number is kept when an invoice
--    is renamed, so the invoice is still found by searching its old number.
--    (The column is already in schema.sql for fresh setups; this adds it
--    to the live database.)
-- 2. next_invoice_number() becomes collision-tolerant: it draws from the
--    invoice sequence and skips any candidate number that already exists
--    on an invoice (e.g. because an Admin manually set one to a number
--    the sequence would later reach), so a manual renumber can never
--    break a future automatic number.
-- 3. admin_renumber_invoice() is redefined WITHOUT the sequence-advance
--    block from migration 007: renaming must NOT touch the auto-number
--    sequence at all — the next new invoice still gets the next sequence
--    number, and the loop in next_invoice_number() is what keeps a manual
--    number from colliding later. Other records are never renumbered.
--
-- SEQUENCING — run this BEFORE Bill uses Renumber in the app. The app's
-- rename call writes the previous_numbers column (via
-- admin_renumber_invoice), so it fails until this migration runs live.
-- Delete is unaffected by this migration: deleting an invoice never
-- renumbers anything and never reuses the deleted number.
alter table public.invoices
  add column if not exists previous_numbers text[] not null default '{}';

-- Collision-tolerant automatic numbering: loop until the sequence yields
-- a number no invoice already has. Skipped sequence values are simply
-- gaps — numbers are never reused and no other row is ever renumbered.
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

-- Admin manual renumber: old number is kept in previous_numbers (searchable),
-- other records are never renumbered, and the auto-number sequence is NOT
-- touched — the next new invoice still gets the next sequence number.
-- The cross-table quote check from migration 006 stays REMOVED: a QT-A
-- number can never equal an INV- number, so a manual INV-1005 must not be
-- rejected because QT-A1005 exists.
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
