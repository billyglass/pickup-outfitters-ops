-- 016_invoice_payments.sql — run once in the live Supabase SQL Editor.
--
-- Invoice payments (Phase 3, payments piece — Nov 19, 2026). Bill's
-- workflow: COD accounts require a deposit when product is ordered, terms
-- accounts require none, and the deposit is whatever the customer puts
-- down — no fixed amount, no percentage. A customer may pay a deposit,
-- come back and pay a little more, then pay the rest — so an invoice
-- takes MULTIPLE partial payments, each one lowering the balance.
--   - invoice_payments — one row per payment on an invoice (amount,
--     date, method, check/reference number, note). A deposit is just a
--     payment; nothing in the data model distinguishes one.
--   - balance_due / status on the invoice are derived from the payments
--     (see deriveInvoiceBalance in src/lib/tickets.js): balance = total
--     - paid; Paid when paid covers the total, Partially Paid when
--     something is paid, Issued when nothing is — Draft and Void are
--     never touched by that logic.
--   - Delete is Admin-only (RLS + the app). Any active user may record a
--     payment — the sales counter takes the money.
--   - The audit trigger is attached, so payment adds/deletes land in
--     audit_log the same way invoice edits do.
-- NOTE: the older Phase 3 scaffold tables `payments` (customer-level)
-- and `payment_allocations` already exist in schema.sql but are unused
-- by the app; this invoice-level table is the one the app uses for
-- deposits / partial payments. The scaffold stays for later AR work.
--
-- SEQUENCING — run this BEFORE Bill records a payment after the matching
-- code deploy. The Payments section on an invoice queries the
-- invoice_payments table; until this runs, the section shows a plain
-- "Could not load payments" error instead of the history (it fails
-- gracefully — the rest of the form works). Ticket saves keep working
-- pre-migration: sbSaveTicket looks up payments best-effort and falls
-- back to paid = 0 if the table doesn't exist yet, so a save never
-- fails because of this migration. No other feature reads this table.
create table if not exists public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  amount numeric(12,2) not null,
  payment_date date not null default CURRENT_DATE,
  method text,
  reference text,
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index if not exists invoice_payments_invoice_idx
  on public.invoice_payments (invoice_id, payment_date);

alter table public.invoice_payments enable row level security;

-- Any active user can read / record a payment; only Admin can delete one.
drop policy if exists "invoice_payments read active" on public.invoice_payments;
create policy "invoice_payments read active" on public.invoice_payments for select
  using (public.is_active_user());
drop policy if exists "invoice_payments insert active" on public.invoice_payments;
create policy "invoice_payments insert active" on public.invoice_payments for insert
  with check (public.is_active_user());
drop policy if exists "invoice_payments update active" on public.invoice_payments;
create policy "invoice_payments update active" on public.invoice_payments for update
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "invoice_payments delete admin" on public.invoice_payments;
create policy "invoice_payments delete admin" on public.invoice_payments for delete
  using (public.is_admin());

-- Audit trail: payment adds/deletes are logged like invoice edits.
drop trigger if exists z_audit_log on public.invoice_payments;
create trigger z_audit_log after insert or update or delete on public.invoice_payments
  for each row execute function public.audit_trigger();
