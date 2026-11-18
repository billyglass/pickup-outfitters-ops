-- 008_quote_status_open_lost.sql — run once in the live Supabase SQL Editor.
--
-- Quote statuses simplify to two: Open and Lost (Nov 18, 2026). Bill uses
-- quotes as a sales tool: Open quotes are the ones to go after, Lost is
-- when the customer says no. Converting a quote to an invoice means it
-- was won — the quote leaves the Quotes tab (hidden by converted_invoice_id,
-- not deleted, and still findable by search), so there is no third status
-- for converted quotes and no Draft/Sent/Accepted/Declined/Expired.
--
-- Mapping: Draft/Sent/Accepted → Open, Declined/Expired → Lost. Already-
-- converted quotes map to Open by their old status, but they are hidden
-- from the Quotes tab by converted_invoice_id, so no third status is
-- needed for them. Invoice statuses are NOT touched (Draft/Issued/
-- Partially Paid/Paid/Void stay as they are).

-- FIX (Nov 18): the old check constraint must be dropped BEFORE updating
-- statuses — the first run failed with check violation 23514 because the
-- update to 'Open' ran while the old Draft/Sent/Accepted/Declined/Expired
-- check was still in place. Nothing was changed by the failed run.
do $$
declare
  r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.quotes'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute 'alter table public.quotes drop constraint ' || quote_ident(r.conname);
  end loop;
end $$;

update public.quotes set status = 'Open' where status in ('Draft', 'Sent', 'Accepted');
update public.quotes set status = 'Lost' where status in ('Declined', 'Expired');

alter table public.quotes add constraint quotes_status_check check (status in ('Open', 'Lost'));
alter table public.quotes alter column status set default 'Open';

-- The migration 002 line-delete policy let any active user delete a line
-- whose parent quote was still 'Draft'. Quotes are now Open/Lost, so
-- without this a Sales user removing a line from an Open quote would hit
-- an RLS error. Lost quotes stay locked to Sales in the app, so only
-- Open parents get the policy. (Invoice lines are untouched — invoices
-- still use Draft.)
drop policy if exists "quote_lines delete draft" on public.quote_lines;
create policy "quote_lines delete draft" on public.quote_lines for delete
  using (
    public.is_active_user()
    and exists (
      select 1 from public.quotes q
      where q.id = quote_lines.quote_id and q.status = 'Open'
    )
  );
