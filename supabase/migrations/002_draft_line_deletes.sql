-- Phase 2 migration — run in Supabase Dashboard -> SQL Editor -> New query.
-- Why: the Phase 1 schema only lets Admins DELETE quote_lines /
-- invoice_lines. A Sales user editing a Draft ticket (removing a line)
-- would therefore fail with an RLS error, even though Drafts are
-- explicitly editable by Sales. This adds a narrow extra policy:
-- any active user may delete a line whose parent ticket is still Draft.
-- Admins keep the existing delete-any-line policy (policies are OR'd).
-- Paid / Void / closed-period invoices are still protected by the
-- invoice_guard trigger, and non-Draft quotes are unaffected.
-- Idempotent — safe to re-run.

drop policy if exists "quote_lines delete draft" on public.quote_lines;
create policy "quote_lines delete draft" on public.quote_lines for delete
  using (
    public.is_active_user()
    and exists (
      select 1 from public.quotes q
      where q.id = quote_lines.quote_id and q.status = 'Draft'
    )
  );

drop policy if exists "invoice_lines delete draft" on public.invoice_lines;
create policy "invoice_lines delete draft" on public.invoice_lines for delete
  using (
    public.is_active_user()
    and exists (
      select 1 from public.invoices i
      where i.id = invoice_lines.invoice_id and i.status = 'Draft'
    )
  );
