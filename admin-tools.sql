-- ============================================================================
-- ADMIN TOOLS  —  site-managed schedule + announcements (admins post from the site)
-- Run in the Supabase SQL editor. Safe to re-run.
-- Relies on current_is_admin() and current_is_active() from earlier migrations.
-- ============================================================================

-- 1) Weekly schedule / calendar --------------------------------------------------
create table if not exists public.schedule_events (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  day           text not null
                check (day in ('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')),
  time          text not null,                 -- "HH:MM" 24h in the team's source timezone
  duration_min  int  not null default 60,
  category      text not null default 'Business',
  access_level  text not null default 'Members Only',
  speaker       text,
  description   text,
  zoom_link     text,
  created_at    timestamptz not null default now()
);

alter table public.schedule_events enable row level security;

drop policy if exists schedule_events_select on public.schedule_events;
create policy schedule_events_select on public.schedule_events
  for select using (public.current_is_active());

drop policy if exists schedule_events_admin on public.schedule_events;
create policy schedule_events_admin on public.schedule_events
  for all using (public.current_is_admin()) with check (public.current_is_admin());

-- 2) Announcements (Mission Update) — let admins post/pin/delete from the site ----
-- team_updates already exists; just make sure admins can write to it.
alter table public.team_updates enable row level security;

drop policy if exists team_updates_admin_write on public.team_updates;
create policy team_updates_admin_write on public.team_updates
  for all using (public.current_is_admin()) with check (public.current_is_admin());

-- Make sure active members can read published updates (kept permissive; harmless if
-- an equivalent policy already exists).
drop policy if exists team_updates_read_published on public.team_updates;
create policy team_updates_read_published on public.team_updates
  for select using (published = true and public.current_is_active());
