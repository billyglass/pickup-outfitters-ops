-- 003_walkin_customer_nullable.sql — run once in the live Supabase SQL Editor.
--
-- Walk-in / one-off tickets (Nov 18, 2026): a quick invoice or quote for a
-- small one-off purchase must not require creating a customer record. The
-- ticket carries name + phone in its customer_snapshot with customer_id =
-- NULL. No fake "Walk-in Customer" record is created.
--
-- Also makes vehicles.customer_id nullable: a walk-in ticket's vehicle
-- (VIN + Year/Make/Model entered on the ticket) still upserts into the
-- Vehicles directory, with customer_id NULL. Existing customer-linked
-- records are untouched.
alter table public.quotes alter column customer_id drop not null;
alter table public.invoices alter column customer_id drop not null;
alter table public.vehicles alter column customer_id drop not null;
