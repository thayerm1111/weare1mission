-- FLOOR GOLD MAP HISTORY (owner 09-17: "add a previous analysis to the Floor, where the map of the gold
-- prediction is"). The Floor's Gold Setup panel computes the read live and kept nothing, so a member could
-- never look back at the map they traded from. One snapshot per mode every ~10 minutes (payload = the GENX
-- read + the candles behind the chart). Service-role only; members read it through /api/floor/setup.
create table if not exists public.floor_setup_history (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  mode text not null,
  price double precision,
  action text,
  confidence integer,
  payload jsonb not null
);
create index if not exists floor_setup_history_mode_at on public.floor_setup_history (mode, at desc);
alter table public.floor_setup_history enable row level security;
revoke all on public.floor_setup_history from public, anon, authenticated;
