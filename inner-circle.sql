-- ============================================================================
-- THE INNER CIRCLE  —  creator profiles, posts, and follows
-- Run this in the Supabase SQL editor (after the earlier migrations).
-- Safe to re-run: uses "if not exists" / "or replace" throughout.
-- ============================================================================

-- 1) Creator fields on profiles ------------------------------------------------
alter table public.profiles add column if not exists is_creator boolean not null default false;
alter table public.profiles add column if not exists headline text;   -- e.g. "Lead Educator"
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists avatar_url text;

-- Only admins may flip the creator flag. (Separate trigger so we don't touch
-- the existing protect_profile_fields() function.) current_is_admin() already
-- exists from the approval migration.
create or replace function public.protect_creator_flag()
returns trigger language plpgsql security definer as $$
begin
  if (new.is_creator is distinct from old.is_creator) and not public.current_is_admin() then
    new.is_creator := old.is_creator;   -- silently ignore self-promotion attempts
  end if;
  return new;
end $$;

drop trigger if exists trg_protect_creator_flag on public.profiles;
create trigger trg_protect_creator_flag
  before update on public.profiles
  for each row execute function public.protect_creator_flag();

-- 2) Posts --------------------------------------------------------------------
create table if not exists public.inner_posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles(id) on delete cascade,
  kind        text not null default 'status'
              check (kind in ('status','video','audio','pdf')),
  body        text,                 -- status text / caption
  media_url   text,                 -- link for video/audio/pdf (Phase B: storage)
  created_at  timestamptz not null default now()
);
create index if not exists inner_posts_author_created_idx
  on public.inner_posts (author_id, created_at desc);

-- 3) Follows ------------------------------------------------------------------
create table if not exists public.inner_follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  creator_id  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, creator_id)
);

-- 4) Row-level security -------------------------------------------------------
alter table public.inner_posts   enable row level security;
alter table public.inner_follows enable row level security;

-- Posts: any active member can read; only the (creator) author or an admin writes.
drop policy if exists inner_posts_select on public.inner_posts;
create policy inner_posts_select on public.inner_posts
  for select using (public.current_is_active());

drop policy if exists inner_posts_insert on public.inner_posts;
create policy inner_posts_insert on public.inner_posts
  for insert with check (
    author_id = auth.uid()
    and exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.is_creator and p.status = 'active')
  );

drop policy if exists inner_posts_modify on public.inner_posts;
create policy inner_posts_modify on public.inner_posts
  for update using (author_id = auth.uid() or public.current_is_admin());

drop policy if exists inner_posts_delete on public.inner_posts;
create policy inner_posts_delete on public.inner_posts
  for delete using (author_id = auth.uid() or public.current_is_admin());

-- Follows: you manage your own follows only.
drop policy if exists inner_follows_select on public.inner_follows;
create policy inner_follows_select on public.inner_follows
  for select using (follower_id = auth.uid());

drop policy if exists inner_follows_write on public.inner_follows;
create policy inner_follows_write on public.inner_follows
  for all using (follower_id = auth.uid()) with check (follower_id = auth.uid());

-- 5) RPC helpers --------------------------------------------------------------

-- List creator profiles (for the "who to follow" panel), with follow state.
create or replace function public.get_creators()
returns table (
  id uuid, full_name text, username text, headline text, bio text,
  avatar_url text, is_following boolean, post_count bigint
)
language sql security definer set search_path = public as $$
  select p.id, p.full_name, p.username, p.headline, p.bio, p.avatar_url,
         exists(select 1 from inner_follows f
                where f.creator_id = p.id and f.follower_id = auth.uid()) as is_following,
         (select count(*) from inner_posts ip where ip.author_id = p.id) as post_count
  from profiles p
  where p.is_creator = true
  order by p.full_name nulls last;
$$;

-- The feed. only_following = true → just the creators you follow.
create or replace function public.get_inner_feed(only_following boolean default false)
returns table (
  id uuid, kind text, body text, media_url text, created_at timestamptz,
  author_id uuid, author_name text, author_username text,
  author_headline text, author_avatar text
)
language sql security definer set search_path = public as $$
  select ip.id, ip.kind, ip.body, ip.media_url, ip.created_at,
         p.id, p.full_name, p.username, p.headline, p.avatar_url
  from inner_posts ip
  join profiles p on p.id = ip.author_id
  where public.current_is_active()
    and (
      only_following = false
      or exists(select 1 from inner_follows f
                where f.creator_id = ip.author_id and f.follower_id = auth.uid())
    )
  order by ip.created_at desc
  limit 100;
$$;

-- Follow / unfollow a creator (returns the new state).
create or replace function public.toggle_follow(target uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare now_following boolean;
begin
  if exists(select 1 from inner_follows where follower_id = auth.uid() and creator_id = target) then
    delete from inner_follows where follower_id = auth.uid() and creator_id = target;
    return false;
  else
    insert into inner_follows(follower_id, creator_id) values (auth.uid(), target)
      on conflict do nothing;
    return true;
  end if;
end $$;

-- Create a post (creators only; enforced again in the RLS insert policy).
create or replace function public.create_inner_post(p_kind text, p_body text, p_media_url text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if not exists(select 1 from profiles where id = auth.uid() and is_creator and status = 'active') then
    raise exception 'Not authorized to post in The Inner Circle';
  end if;
  insert into inner_posts(author_id, kind, body, media_url)
  values (auth.uid(), coalesce(p_kind,'status'), p_body, p_media_url)
  returning id into new_id;
  return new_id;
end $$;

grant execute on function public.get_creators(),
                        public.get_inner_feed(boolean),
                        public.toggle_follow(uuid),
                        public.create_inner_post(text, text, text) to authenticated;
