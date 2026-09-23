-- One-time in-portal announcements (owner 09-22): a member sees each announcement once, on any device.
create table if not exists public.portal_announcements_seen (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  seen_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.portal_announcements_seen enable row level security;
drop policy if exists "own announcements select" on public.portal_announcements_seen;
create policy "own announcements select" on public.portal_announcements_seen for select using (auth.uid() = user_id);
drop policy if exists "own announcements insert" on public.portal_announcements_seen;
create policy "own announcements insert" on public.portal_announcements_seen for insert with check (auth.uid() = user_id);
