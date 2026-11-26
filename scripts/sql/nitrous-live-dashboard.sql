-- Display-only telemetry from verified broker position reads.
alter table public.nitrous_positions add column if not exists live_observed_at timestamptz;
alter table public.nitrous_positions add column if not exists live_unrealized_pnl numeric;
