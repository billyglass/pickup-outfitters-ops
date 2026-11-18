-- 004_customer_type.sql — run once in the live Supabase SQL Editor.
--
-- Fleet vs Retail customers (Nov 18, 2026): Pickup Outfitters is both a
-- fleet shop and a regular retail store, and Bill wants to separate fleet
-- customers from retail customers when searching customers. Every customer
-- gets a type, Retail or Fleet. Existing customers default to Retail —
-- Bill can flip any of them to Fleet in the customer form.
-- Also used by "Save walk-in as customer": the type chosen on the ticket
-- is stored on the new customer record.
alter table public.customers add column if not exists customer_type text not null default 'Retail' check (customer_type in ('Retail', 'Fleet'));
create index if not exists customers_type_idx on public.customers (customer_type);
