-- SUPPORT CHAT (owner 09-24: "set up a support chat on weare1mission... connected to you to where you
-- can read it, and then you can report back to me of what needs help or what needs changing").
--
-- One open thread per member. Members write; Claude reads the whole table through the service role,
-- diagnoses against the member's own account data, and leaves a DRAFT reply. A draft is invisible to
-- the member until the owner approves it — that is the point of the `visibility` column, and the RLS
-- policy below is what enforces it rather than any application code remembering to filter.

create table if not exists public.support_threads (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  subject       text,
  -- open        = needs someone to look
  -- answered    = a reply has been sent, waiting on the member
  -- resolved    = done
  status        text not null default 'open',
  -- set by Claude during triage so the digest can lead with what actually matters
  priority      text not null default 'normal',   -- urgent | normal | low
  topic         text,                             -- credits | trades | billing | account | other
  -- Claude's read of the member's situation, checked against their account. Never shown to the member.
  triage_note   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_member_at timestamptz,
  last_staff_at  timestamptz
);
create index if not exists support_threads_user on public.support_threads(user_id);
create index if not exists support_threads_status on public.support_threads(status, updated_at desc);

create table if not exists public.support_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.support_threads(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,  -- null when it is from the desk
  role        text not null,                       -- 'member' | 'staff'
  body        text not null,
  -- 'member'  = the member can see it (their own message, or an approved reply)
  -- 'draft'   = Claude wrote it, awaiting the owner's approval; the member CANNOT see it
  visibility  text not null default 'member',
  approved_by uuid references auth.users(id) on delete set null,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists support_messages_thread on public.support_messages(thread_id, created_at);
create index if not exists support_messages_drafts on public.support_messages(visibility) where visibility = 'draft';

alter table public.support_threads enable row level security;
alter table public.support_messages enable row level security;

-- Members: their own threads only.
drop policy if exists "own threads select" on public.support_threads;
create policy "own threads select" on public.support_threads
  for select using (auth.uid() = user_id);
drop policy if exists "own threads insert" on public.support_threads;
create policy "own threads insert" on public.support_threads
  for insert with check (auth.uid() = user_id);

-- Members: messages in their own thread, and NEVER a draft. The visibility check lives here so a
-- forgotten filter in a route cannot leak an unapproved reply.
drop policy if exists "own messages select" on public.support_messages;
create policy "own messages select" on public.support_messages
  for select using (
    visibility = 'member'
    and exists (select 1 from public.support_threads t where t.id = thread_id and t.user_id = auth.uid())
  );
drop policy if exists "own messages insert" on public.support_messages;
create policy "own messages insert" on public.support_messages
  for insert with check (
    role = 'member'
    and visibility = 'member'
    and auth.uid() = user_id
    and exists (select 1 from public.support_threads t where t.id = thread_id and t.user_id = auth.uid())
  );

-- Keep the thread's clock honest without the app having to remember.
create or replace function public.support_touch_thread() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.support_threads t
     set updated_at = now(),
         last_member_at = case when new.role = 'member' then now() else t.last_member_at end,
         last_staff_at  = case when new.role = 'staff' and new.visibility = 'member' then now() else t.last_staff_at end,
         -- a member replying to an answered thread reopens it
         status = case when new.role = 'member' and t.status = 'answered' then 'open' else t.status end
   where t.id = new.thread_id;
  return new;
end $$;
drop trigger if exists support_messages_touch on public.support_messages;
create trigger support_messages_touch after insert on public.support_messages
  for each row execute function public.support_touch_thread();
