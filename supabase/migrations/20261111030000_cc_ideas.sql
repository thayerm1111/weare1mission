-- ATLAS TRADE IDEAS (owner 11-11: "When I click generate I want atlas to give me the trade idea and where
-- I should enter").
--
-- One row each time a member presses GENERATE in the Command Center: the idea exactly as ATLAS gave it
-- (side, entry, stop, targets, reasoning, what would invalidate it — command-center/engines/idea.ts), the
-- options it was generated with, and, once it has been followed, how it turned out on real candles.
-- The idea itself is never edited after it is written: `status`, `result` and `graded_at` are the only
-- columns that change, and they record the outcome, not a revision of the call.
--
-- snapshot_id is the cc_snapshots row the idea was built from. Deliberately NOT a foreign key: snapshots
-- are pruned after 14 days and an idea's record must neither block that prune nor vanish with it.
--
-- Nothing on a trading path reads this table. An idea never places an order; taking one goes through the
-- existing trade route, with its own validation, consent and idempotency.
-- Server-side only: row level security is on with no policies, so only the service role reads or writes
-- (the authenticated API route reads a member's own rows server-side).
create table if not exists public.cc_ideas (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  created_at  timestamptz not null default now(),
  snapshot_id bigint,
  snapshot_at timestamptz,
  version     text,                           -- ATLAS_IDEA_VERSION
  kind        text not null,                  -- enter_now | on_confirmation | at_level | on_break | stand_aside
  source      text,                           -- setup_engine | read_plan
  side        text,
  style       text,
  price_at    numeric,                        -- gold when the idea was generated
  entry       numeric,                        -- the reference entry
  stop        numeric,
  tp1         numeric,
  idea        jsonb not null,                 -- the AtlasIdea
  options     jsonb not null default '{}'::jsonb,
  status      text not null default 'new',    -- the last IdeaState it was followed to ('new' until followed)
  result      jsonb,                          -- the last IdeaFollow
  graded_at   timestamptz,
  expires_at  timestamptz
);

create index if not exists cc_ideas_user_created_idx on public.cc_ideas (user_id, created_at desc);

alter table public.cc_ideas enable row level security;
-- No policies: service role only.
