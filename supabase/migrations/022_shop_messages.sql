-- Migration 022 — shop message board (Nov 24).
-- Run in Supabase Dashboard -> SQL Editor -> New query.
-- Why: a shop-wide chat on the dashboard (iMessage-style) so Admin and
-- salesmen can post messages to each other. No private messages in v1.
-- One row per message; the author name resolves from profiles in the
-- app. Anyone signed in can post; a user can delete their own messages
-- and Admin can delete anyone's. No editing in v1 (no update policy).
-- NOTE: run this live before messages will post — until it runs, the
-- chat shows a note that it is not set up yet and the input stays
-- disabled; nothing else on the page is affected.
-- Idempotent — safe to re-run.

create table if not exists public.shop_messages (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists shop_messages_created_idx
  on public.shop_messages (created_at desc);

alter table public.shop_messages enable row level security;

drop policy if exists "shop_messages read active" on public.shop_messages;
create policy "shop_messages read active" on public.shop_messages for select
  using (public.is_active_user());
drop policy if exists "shop_messages insert active" on public.shop_messages;
create policy "shop_messages insert active" on public.shop_messages for insert
  with check (public.is_active_user());
drop policy if exists "shop_messages delete own or admin" on public.shop_messages;
create policy "shop_messages delete own or admin" on public.shop_messages for delete
  using (auth.uid() = author_id or public.is_admin());
