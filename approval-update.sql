-- =============================================================================
-- 1 MISSION — Member approval update
-- Run this ONCE in Supabase → SQL Editor after the initial schema.sql.
-- It makes new sign-ups "pending" until an admin approves them, lets admins
-- manage members, and restricts member content to approved (active) members.
-- =============================================================================

-- New members start as "pending" until approved.
alter table public.profiles alter column status set default 'pending';

-- Helper: is the current user an approved (active) member?
create or replace function public.current_is_active()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active');
$$;

-- Admins can update any profile (approve, set tier/role, suspend).
drop policy if exists "profiles_admin_update" on public.profiles;
create policy "profiles_admin_update" on public.profiles
  for update to authenticated
  using (public.current_is_admin())
  with check (public.current_is_admin());

-- Content is visible only to APPROVED members (admins always see everything).
drop policy if exists "updates_select" on public.team_updates;
create policy "updates_select" on public.team_updates
  for select to authenticated
  using (public.current_is_admin() or (public.current_is_active() and published));

drop policy if exists "live_select" on public.live_sessions;
create policy "live_select" on public.live_sessions
  for select to authenticated
  using (public.current_is_admin() or (public.current_is_active() and published and public.tier_rank(required_tier) <= public.current_tier_rank()));

drop policy if exists "trading_select" on public.trading_content;
create policy "trading_select" on public.trading_content
  for select to authenticated
  using (public.current_is_admin() or (public.current_is_active() and published and public.tier_rank(required_tier) <= public.current_tier_rank()));
