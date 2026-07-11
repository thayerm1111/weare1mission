-- =============================================================================
-- 1 MISSION — Supabase schema
-- Run this in Supabase → SQL Editor (paste all, click Run) once, after creating
-- your project. It sets up profiles, member content, and row-level security.
-- Safe to re-run: it uses "if not exists" / "or replace" where possible.
-- =============================================================================

-- ---------- PROFILES ---------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       text not null default 'member'  check (role   in ('member','admin')),
  tier       text not null default 'starter' check (tier   in ('starter','core','elite')),
  status     text not null default 'active'  check (status in ('active','pending','suspended')),
  created_at timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user signs up (magic link).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper functions used by RLS policies.
create or replace function public.current_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

create or replace function public.current_tier_rank()
returns int language sql stable security definer set search_path = public as $$
  select case (select tier from public.profiles where id = auth.uid())
    when 'elite' then 3 when 'core' then 2 when 'starter' then 1 else 0 end;
$$;

create or replace function public.tier_rank(t text)
returns int language sql immutable as $$
  select case t when 'elite' then 3 when 'core' then 2 when 'starter' then 1 else 0 end;
$$;

-- ---------- MEMBER CONTENT TABLES -------------------------------------------
create table if not exists public.team_updates (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null,
  category    text default 'General',
  pinned      boolean not null default false,
  published   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.live_sessions (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  host          text,
  starts_at     timestamptz not null,
  join_url      text,
  category      text default 'Community',
  required_tier text not null default 'starter' check (required_tier in ('starter','core','elite')),
  published     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists public.trading_content (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  body          text,
  video_url     text,
  category      text default 'Education',
  required_tier text not null default 'starter' check (required_tier in ('starter','core','elite')),
  published     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------- ROW LEVEL SECURITY ----------------------------------------------
alter table public.profiles        enable row level security;
alter table public.team_updates    enable row level security;
alter table public.live_sessions   enable row level security;
alter table public.trading_content enable row level security;

-- Profiles: a user can read/update their own row; admins can read all.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id or public.current_is_admin());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

-- Team updates: any signed-in member can read published updates.
drop policy if exists "updates_select" on public.team_updates;
create policy "updates_select" on public.team_updates
  for select to authenticated
  using (published or public.current_is_admin());

-- Live sessions & trading content: signed-in members can read published rows
-- AT OR BELOW their tier. Admins see everything. (Tier gating enforced in DB.)
drop policy if exists "live_select" on public.live_sessions;
create policy "live_select" on public.live_sessions
  for select to authenticated
  using (public.current_is_admin() or (published and public.tier_rank(required_tier) <= public.current_tier_rank()));

drop policy if exists "trading_select" on public.trading_content;
create policy "trading_select" on public.trading_content
  for select to authenticated
  using (public.current_is_admin() or (published and public.tier_rank(required_tier) <= public.current_tier_rank()));

-- NOTE: inserts/updates to content are intentionally not exposed to members.
-- Manage content from the Supabase dashboard, or add admin-only policies later.

-- ---------- SEED PLACEHOLDER CONTENT (replace before launch) -----------------
insert into public.team_updates (title, body, category, pinned) values
  ('Welcome to the 1 Mission member portal', 'This is placeholder content. Post real team updates here. Members see the latest news the moment they log in.', 'Announcement', true),
  ('This week''s focus', 'Placeholder: share the theme, goals, or challenge for the week to keep everyone aligned.', 'Weekly', false)
on conflict do nothing;

insert into public.live_sessions (title, description, host, starts_at, join_url, category, required_tier) values
  ('Monday Leadership Call', 'Placeholder session. Weekly leadership focus and Q&A.', 'Leadership Team', now() + interval '2 days', '#', 'Leadership', 'starter'),
  ('Core Trading Room', 'Placeholder. Live education session for Core members and above.', 'Education Team', now() + interval '3 days', '#', 'Trading', 'core')
on conflict do nothing;

insert into public.trading_content (title, description, body, category, required_tier) values
  ('Trading Foundations (Placeholder)', 'Educational overview of core concepts. Education only — not financial advice.', 'Replace with your real lesson content.', 'Education', 'starter'),
  ('Advanced Concepts (Placeholder)', 'Deeper material for Core/Elite members.', 'Replace with your real lesson content.', 'Education', 'core')
on conflict do nothing;
