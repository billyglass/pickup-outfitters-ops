-- Migration 023 — chat seen tracking for the new-message dot (Nov 24).
-- Run in Supabase Dashboard -> SQL Editor -> New query.
-- Why: the Shop chat shows a small orange-red dot when someone else has
-- posted since you last looked. The dot is driven by chat_seen_at on
-- your own profiles row, so it works across devices (reading on your
-- phone clears the dot on the desktop too).
-- Safety: NO broad self-update policy on profiles — a sales user must
-- never be able to change their own role. The only write path is the
-- SECURITY DEFINER function below, which updates nothing but the
-- caller's own chat_seen_at. The profiles_guard trigger still blocks
-- non-Admins from changing role / active / mfa_enrolled.
-- NOTE: run this live before the dot's seen-tracking works. Until it
-- runs, mark_chat_seen fails silently, seen_at stays null, and the dot
-- may show until the migration runs — the chat itself and everything
-- else keep working. Idempotent — safe to re-run.

alter table public.profiles add column if not exists chat_seen_at timestamptz;

create or replace function public.mark_chat_seen()
returns void
language sql security definer
set search_path = public
as $$
  update public.profiles set chat_seen_at = now() where id = auth.uid();
$$;

grant execute on function public.mark_chat_seen() to authenticated;
revoke execute on function public.mark_chat_seen() from anon;
