-- 019_profiles_read_all_active.sql — run once in the live Supabase SQL Editor.
--
-- Let every active user read ALL profiles, not just their own row
-- (Nov 23, 2026). The old policy (auth.uid() = id or is_admin()) meant
-- a Sales user signing in saw only their own profiles row, so the
-- salesperson picker on a ticket showed nobody to add — Jeff could not
-- add Billy to a ticket, and the Quotes/Invoices salesperson filters
-- listed only himself. Every other table's read policy already uses
-- is_active_user(); profiles now matches. Insert/update policies are
-- UNCHANGED. is_active_user() is SECURITY DEFINER, so there is no RLS
-- recursion on the profiles table itself.
--
-- SEQUENCING — run this before Bill tests the salesperson picker as
-- Jeff. Until it runs, a Sales user still sees only their own row and
-- the owner dropdown / "Add salesman" list has nobody in it (the old
-- behaviour — nothing breaks, the lists are just short).
drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select
  using (public.is_active_user());
