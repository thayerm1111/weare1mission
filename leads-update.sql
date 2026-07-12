-- =============================================================================
-- 1 MISSION — Prospects / video-tracking update  (run ONCE in Supabase SQL Editor)
-- Captures prospects who watch the community video via a member's link, tracks
-- how much of the video they watched, and lets the referrer see + contact them.
-- =============================================================================

create table if not exists public.leads (
  id             uuid primary key default gen_random_uuid(),
  referrer_id    uuid not null references public.profiles(id) on delete cascade,
  name           text,
  email          text,
  phone          text,
  video_seconds  numeric not null default 0,
  video_duration numeric,
  video_percent  int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists leads_referrer_idx on public.leads(referrer_id);

alter table public.leads enable row level security;

-- The referrer (and admins) can read their own prospects.
drop policy if exists "leads_select_own" on public.leads;
create policy "leads_select_own" on public.leads
  for select to authenticated
  using (referrer_id = auth.uid() or public.current_is_admin());

-- Prospects are anonymous, so writes go through security-definer RPCs.
create or replace function public.create_lead(ref_username text, p_name text, p_email text, p_phone text)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; lid uuid;
begin
  select id into rid from public.profiles
    where username = lower(ref_username) and status = 'active' limit 1;
  if rid is null then return null; end if;
  insert into public.leads (referrer_id, name, email, phone)
    values (rid, p_name, p_email, p_phone) returning id into lid;
  return lid;
end;
$$;

create or replace function public.update_lead_progress(p_lead_id uuid, p_seconds numeric, p_duration numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.leads
  set video_seconds  = greatest(video_seconds, coalesce(p_seconds, 0)),
      video_duration = coalesce(p_duration, video_duration),
      video_percent  = case when coalesce(p_duration, 0) > 0
                         then least(100, round(greatest(video_seconds, coalesce(p_seconds, 0)) / p_duration * 100))::int
                         else video_percent end,
      updated_at = now()
  where id = p_lead_id;
end;
$$;

grant execute on function public.create_lead(text, text, text, text) to anon, authenticated;
grant execute on function public.update_lead_progress(uuid, numeric, numeric) to anon, authenticated;
