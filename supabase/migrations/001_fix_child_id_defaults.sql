-- Fix for: "null value in column "id" of relation "contacts" violates not-null constraint"
-- when adding a customer. The app fix (store.js) now sends only allowed
-- columns and never sends id, but belt-and-braces: make sure every child
-- table's id actually defaults to gen_random_uuid() in the live database.
-- Run in Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Idempotent — safe to run even if the defaults are already there.
alter table public.contacts alter column id set default gen_random_uuid();
alter table public.customer_addresses alter column id set default gen_random_uuid();
alter table public.customers alter column id set default gen_random_uuid();
alter table public.vehicles alter column id set default gen_random_uuid();
alter table public.quote_lines alter column id set default gen_random_uuid();
alter table public.invoice_lines alter column id set default gen_random_uuid();
