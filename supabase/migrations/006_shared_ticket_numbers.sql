-- 006_shared_ticket_numbers.sql — run once in the live Supabase SQL Editor.
--
-- Shared ticket numbering (Nov 18, 2026): quotes and invoices must NEVER
-- share a number — Bill does not want a QT-1001 and an INV-1001. Previously
-- there were two separate sequences (invoice_number_seq, quote_number_seq),
-- both starting at 1001, so the numeric parts collided by design.
--
-- This replaces them with ONE sequence, ticket_number_seq, used by both
-- next_quote_number() and next_invoice_number(). The prefixes stay
-- different (QT- / INV-) but the numbers never repeat: QT-1001, INV-1002,
-- QT-1003, ... The sequence is seeded AFTER the highest number already
-- used by either table, so no existing ticket is renumbered and no
-- voided/deleted number is recycled. The old sequences are left in place,
-- unused, so nothing that references them breaks.
--
-- Both admin_set_next_* functions now move the SAME shared sequence, and
-- admin_renumber_invoice now checks BOTH tables for a collision and
-- advances the shared sequence past a manual number.

create sequence if not exists ticket_number_seq start with 1001;

do $$
declare
  v_max bigint;
begin
  select coalesce(max(n), 0) into v_max
  from (
    select (substring(number from '[0-9]+$'))::bigint as n
    from public.quotes where number ~ '[0-9]+$'
    union all
    select (substring(number from '[0-9]+$'))::bigint
    from public.invoices where number ~ '[0-9]+$'
  ) s;
  -- setval(..., true) means the NEXT nextval is v_max + 1; with no tickets
  -- yet v_max is 0, so greatest(0, 1000) = 1000 and the first number issued
  -- is 1001, as before.
  perform setval('ticket_number_seq', greatest(v_max, 1000), true);
end $$;

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
  -- Shared sequence: quotes and invoices draw from the same counter, so a
  -- numeric value can never be issued as both a QT- and an INV- number.
  v_num := nextval('ticket_number_seq');
  update public.settings
    set next_invoice_number = v_num + 1, next_quote_number = v_num + 1
    where id = 1;
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
  -- Shared sequence: see next_invoice_number().
  v_num := nextval('ticket_number_seq');
  update public.settings
    set next_invoice_number = v_num + 1, next_quote_number = v_num + 1
    where id = 1;
  return v_prefix || v_num::text;
end;
$$;

-- Admin: move the next automatic number forward. Both functions move the
-- SAME shared sequence (and both settings mirrors), so setting the next
-- invoice number also moves the next quote number, and vice versa.
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
  perform setval('ticket_number_seq', p_next - 1, true);
  update public.settings
    set next_invoice_number = p_next, next_quote_number = p_next
    where id = 1;
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
  perform setval('ticket_number_seq', p_next - 1, true);
  update public.settings
    set next_invoice_number = p_next, next_quote_number = p_next
    where id = 1;
end;
$$;

-- Admin manual renumber: now checks BOTH tables, so a manual INV-1005 is
-- rejected if QT-1005 exists (and vice versa), and advances the shared
-- sequence past a manual number so future automatic numbering cannot
-- collide with it.
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
  if exists (select 1 from public.quotes where number = p_new_number) then
    raise exception 'That number is already in use as a quote number';
  end if;
  update public.invoices
    set number = p_new_number,
        previous_numbers = array_append(coalesce(previous_numbers, '{}'), v_old)
    where id = p_invoice_id;
  -- Advance the shared sequence past a manual number so it can't collide later.
  v_digits := substring(p_new_number from '[0-9]+$');
  if v_digits is not null then
    v_num := v_digits::bigint;
    if v_num >= (select last_value from ticket_number_seq) then
      perform setval('ticket_number_seq', v_num, true);
      update public.settings
        set next_invoice_number = v_num + 1, next_quote_number = v_num + 1
        where id = 1;
    end if;
  end if;
end;
$$;
