-- =============================================================================
-- 1 MISSION — Referral / downline update  (run ONCE in Supabase SQL Editor)
-- Adds personal usernames + referral links, a multi-level downline tree, phone
-- numbers, and CLOSES a privilege-escalation gap so members can't edit their
-- own role/tier/status.
-- =============================================================================

-- ---- new columns ----
alter table public.profiles add column if not exists username text unique;
alter table public.profiles add column if not exists referred_by uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists phone text;

alter table public.profiles drop constraint if exists profiles_username_format;
alter table public.profiles add constraint profiles_username_format
  check (username is null or username ~ '^[a-z0-9-]{3,30}$');

create index if not exists profiles_referred_by_idx on public.profiles(referred_by);

-- ---- SECURITY FIX: members may only edit safe fields on their own profile ----
-- role / tier / status / referred_by / email are protected from self-editing.
create or replace function public.protect_profile_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.current_is_admin() then
    new.role := old.role;
    new.tier := old.tier;
    new.status := old.status;
    new.referred_by := old.referred_by;
    new.email := old.email;
  end if;
  return new;
end;
$$;
drop trigger if exists protect_profile_fields_trg on public.profiles;
create trigger protect_profile_fields_trg
  before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- ---- referral resolution on sign-up ----
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, phone, referred_by)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'phone',
    (select p.id from public.profiles p
       where p.username = lower(new.raw_user_meta_data->>'referred_by_username') limit 1)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---- helper RPCs ----
-- Is a username free? (used by the account page)
create or replace function public.is_username_available(u text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where username = lower(u));
$$;

-- Public lookup for the /username referral landing page.
create or replace function public.get_referrer(u text)
returns table(id uuid, full_name text) language sql stable security definer set search_path = public as $$
  select id, full_name from public.profiles
  where username = lower(u) and status = 'active' limit 1;
$$;

-- The caller's full multi-level downline (everyone below them), with level.
create or replace function public.get_my_downline()
returns table(
  id uuid, full_name text, email text, phone text, username text,
  tier text, status text, created_at timestamptz, level int, referred_by uuid
)
language sql stable security definer set search_path = public as $$
  with recursive tree as (
    select p.id, p.full_name, p.email, p.phone, p.username, p.tier, p.status,
           p.created_at, 1 as level, p.referred_by
    from public.profiles p
    where p.referred_by = auth.uid()
    union all
    select c.id, c.full_name, c.email, c.phone, c.username, c.tier, c.status,
           c.created_at, t.level + 1, c.referred_by
    from public.profiles c
    join tree t on c.referred_by = t.id
  )
  select * from tree order by level, created_at;
$$;

grant execute on function public.is_username_available(text) to anon, authenticated;
grant execute on function public.get_referrer(text) to anon, authenticated;
grant execute on function public.get_my_downline() to authenticated;
