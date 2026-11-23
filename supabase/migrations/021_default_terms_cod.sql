-- Migration 021 — shop default payment terms become COD (Nov 23).
-- Run in Supabase Dashboard -> SQL Editor -> New query.
-- Why: most of the shop's customers are COD, not terms. New quotes and
-- invoices must auto-default to COD instead of Net 30; a terms customer
-- is the exception, set on their profile (picking one still brings their
-- terms onto the ticket) or changed by hand on the ticket.
-- What this changes: the settings row (so the app's default_payment_terms
-- reads COD) and the column defaults on settings/customers/quotes/invoices
-- (so a record saved without explicit terms gets COD, not Net 30).
-- Existing tickets are untouched — their saved terms stay exactly as they
-- are. Existing customer profiles keep whatever terms they already have.
-- Idempotent — safe to re-run.

update public.settings set default_payment_terms = 'COD' where id = 1;
alter table public.settings alter column default_payment_terms set default 'COD';
alter table public.customers alter column payment_terms set default 'COD';
alter table public.quotes alter column payment_terms set default 'COD';
alter table public.invoices alter column payment_terms set default 'COD';
