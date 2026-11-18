-- 007_separate_numbering.sql — run once in the live Supabase SQL Editor.
--
-- Separate ticket numbering (Nov 18, 2026): Bill chose two separate
-- numbering systems — quotes QT-A1001, QT-A1002, ... and invoices
-- INV-1001, INV-1002, ... The two systems are independent, so a quote
-- and an invoice CAN share the same numeric part (QT-A1003 and INV-1003
-- are different numbers); the letter in the quote prefix is what keeps
-- them apart.
--
-- This replaces migration 006's single shared sequence (ticket_number_seq,
-- left in place, unused). No existing ticket is renumbered: old quotes
-- QT-1001 / QT-1002 and old invoices INV-1001 / INV-1002 keep exactly
-- the numbers they already have, and stay searchable. Each per-kind
-- sequence is seeded AFTER the highest numeric suffix already used by
-- that kind, so no number is reused and no voided/deleted number is
-- recycled. With the live data as of Nov 18 (highest used 1002), the
-- next quote is QT-A1003 and the next invoice is INV-1003.

create sequence if not exists quote_number_seq start with 1001;
create sequence if not exists invoice_number_seq start with 1001;

do $$
declare
  v_max bigint;
begin
  select coalesce(max((substring(number from '[0-9]+$'))::bigint), 0)
    into v_max
    from public.quotes where number ~ '[0-9]+$';
  perform setval('quote_number_seq', greatest(v_max, 1000), true);
  update public.settings set next_quote_number = greatest(v_max, 1000) + 1 where id = 1;
end $$;

do $$
declare
  v_max bigint;
begin
  select coalesce(max((substring(number from '[0-9]+$'))::bigint), 0)
    into v_max
    from public.invoices where number ~ '[0-9]+$';
  perform setval('invoice_number_seq', greatest(v_max, 1000), true);
  update public.settings set next_invoice_number = greatest(v_max, 1000) + 1 where id = 1;
end $$;

-- Quote prefix becomes QT-A (was QT-). Invoice prefix stays INV-.
update public.settings set quote_prefix = 'QT-A' where id = 1;

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
  v_num := nextval('invoice_number_seq');
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

-- Admin: move the next automatic number forward. Each function moves its
-- OWN sequence now (separate systems) — setting the next invoice number
-- no longer moves the next quote number, and vice versa.
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
-- other records are never renumbered, and if the manual number is at/above
-- the sequence, the sequence is advanced past it so future automatic
-- numbering cannot collide with it. The cross-table quote check from
-- migration 006 is REMOVED: a QT-A number can never equal an INV- number,
-- so a manual INV-1005 must not be rejected because QT-A1005 exists.
create or replace function public.admin_renumber_invoice(p_invoice_id uuid, p_new_number text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_old text;
  v_digits text;
  v_num bigint;
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
  -- Advance the invoice sequence past a manual number so it can't collide later.
  v_digits := substring(p_new_number from '[0-9]+$');
  if v_digits is not null then
    v_num := v_digits::bigint;
    if v_num >= (select last_value from invoice_number_seq) then
      perform setval('invoice_number_seq', v_num, true);
      update public.settings set next_invoice_number = v_num + 1 where id = 1;
    end if;
  end if;
end;
$$;
