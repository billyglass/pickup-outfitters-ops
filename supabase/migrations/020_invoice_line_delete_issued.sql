-- Migration 020 — let Sales delete lines on editable invoices.
-- Run in Supabase Dashboard -> SQL Editor -> New query.
-- Why: the migration 002 policy lets any active user delete an invoice
-- line only while the parent invoice is still Draft. But Sales can edit
-- Draft, Issued, and Partially Paid invoices (see canEditTicket), so a
-- salesman removing a line from an Issued invoice — e.g. the customer
-- changed their mind on a part — hits an RLS error and the whole save
-- fails, even though the form lets him remove the line. This widens the
-- policy to the same statuses Sales may edit. Paid and Void invoices stay
-- Admin-only for line deletes (the invoice_guard trigger also locks Paid /
-- Void / closed-period invoices to non-Admins on update, and the app locks
-- Sales out of Paid/Void forms entirely). Deleting a whole invoice stays
-- Admin-only — this changes line deletes only. Admins keep the existing
-- delete-any-line policy (policies are OR'd). Quote lines are untouched —
-- migration 008 already allows Open-quote line deletes for Sales, and Lost
-- quotes stay locked. Idempotent — safe to re-run.

drop policy if exists "invoice_lines delete draft" on public.invoice_lines;
create policy "invoice_lines delete draft" on public.invoice_lines for delete
  using (
    public.is_active_user()
    and exists (
      select 1 from public.invoices i
      where i.id = invoice_lines.invoice_id and i.status in ('Draft', 'Issued', 'Partially Paid')
    )
  );
