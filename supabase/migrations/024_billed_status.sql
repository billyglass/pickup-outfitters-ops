-- 024_billed_status.sql — run once in the live Supabase SQL Editor.
--
-- 'Billed' invoice status (Nov 25, 2026). Bill wants a visible change when
-- he hits Complete & bill, especially on the Sales side: the status becomes
-- 'Billed' — billed, not paid yet — and only changes to Paid once it is paid
-- in full. Model:
--   Draft = a ticket still being written (need to add stuff / waiting on info)
--   Issued (shown as Open) = a created invoice, not yet billed — no billing
--     date, no due date until billed
--   Billed = Complete & bill was hit (or the invoice was issued from a
--     Draft) — billing date stamped, due date running from billing
--   Partially Paid = some money in, balance left
--   Paid = paid in full. Void = dead.
--
-- No existing rows change status — nothing maps to 'Billed' automatically;
-- an invoice becomes Billed only through the app's billing actions
-- (Complete & bill, or issuing a Draft). The code deploy that adds 'Billed'
-- to the app's status lists must land before or with this migration: until
-- it runs, the DB check constraint rejects 'Billed' and any billing action
-- fails with a check violation.
--
-- Like migration 008: the old check constraint must be dropped BEFORE the
-- new one is added — updating statuses while the old check is still in
-- place would fail (the 008 lesson).

do $$
declare
  r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.invoices'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute 'alter table public.invoices drop constraint ' || quote_ident(r.conname);
  end loop;
end $$;

alter table public.invoices add constraint invoices_status_check check (status in ('Draft', 'Issued', 'Billed', 'Partially Paid', 'Paid', 'Void'));

-- The invoice_lines delete policy let any active user delete a line whose
-- parent invoice was Draft, Issued, or Partially Paid. Billed invoices are
-- editable like Issued ones, so Sales can delete lines on them too. Paid
-- and Void stay Admin-only for line deletes.
drop policy if exists "invoice_lines delete draft" on public.invoice_lines;
create policy "invoice_lines delete draft" on public.invoice_lines for delete
  using (
    public.is_active_user()
    and exists (
      select 1 from public.invoices i
      where i.id = invoice_lines.invoice_id and i.status in ('Draft', 'Issued', 'Billed', 'Partially Paid')
    )
  );
