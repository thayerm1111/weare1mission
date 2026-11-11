-- ATLAS READ (owner 11-11: ATLAS as a real-time conversational market copilot).
--
-- One row each time the Command Center worker records ATLAS's directional read of gold: the lean, its
-- score (a signed measure of how much the evidence agrees, -100..100 — NOT a probability), the full read
-- (evidence for and against, what it is watching, what would invalidate it, one plain summary) and the
-- scenarios as they stood (base case, alternative, view change, each with an append-only status history).
-- Written when the lean or a scenario's status changes, and at most every few minutes otherwise. Rows are
-- appended, never updated: the history of what ATLAS thought, and when, is the point.
--
-- snapshot_id is the cc_snapshots row the read was computed from, when there is one. It is deliberately
-- NOT a foreign key: snapshots are pruned after 14 days, and the read history must neither block that
-- prune nor disappear with it. The worker prunes this table after 30 days.
--
-- Display and conversation only: nothing on a trading path reads this table.
-- Server-side only: row level security is on with no policies, so only the service role reads or writes.
create table if not exists public.cc_atlas_reads (
  id          bigserial primary key,
  at          timestamptz not null,           -- the time of the snapshot the read was computed from
  snapshot_id bigint,
  version     text,                           -- the read engine's version (ATLAS_READ_VERSION)
  lean        text,                           -- bullish_lean | bearish_lean | balanced | transitioning | insufficient_data
  score       int,
  read        jsonb,                          -- the AtlasRead (command-center/core/atlasContract.ts)
  scenarios   jsonb,                          -- Scenario[]
  reason      text,                           -- why this row was written (a lean change, a scenario change, or neither)
  created_at  timestamptz default now()
);

create index if not exists cc_atlas_reads_at_idx on public.cc_atlas_reads (at desc);

alter table public.cc_atlas_reads enable row level security;
-- No policies: service role only (the worker writes; the authenticated API route reads server-side).
