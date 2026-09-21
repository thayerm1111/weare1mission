-- COMMAND CENTER CHART CANDLES — display only.
-- The worker already fetches 5m/15m/1h/4h/1d gold bars every pass for THE BRAIN. It now also leaves the
-- latest set here (one row per timeframe, overwritten) so the Command Center chart can show every
-- timeframe without a second upstream feed call per viewer. Nothing on a trading path reads this table.
create table if not exists public.cc_chart_bars (
  tf text primary key,
  bars jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.cc_chart_bars enable row level security;
-- No policies: service role only (the worker writes, the authenticated API route reads server-side).
