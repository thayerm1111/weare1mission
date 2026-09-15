-- Gold candle archive for GENX replays/backtests. Market prices only; RLS on, no policies
-- (service role only). Filled by the monitor cron (src/lib/genx/candleArchive.ts).
create table if not exists public.genx_candle_archive (
  symbol   text        not null,
  interval text        not null,
  t        timestamptz not null,
  o numeric not null, h numeric not null, l numeric not null, c numeric not null,
  primary key (symbol, interval, t)
);
alter table public.genx_candle_archive enable row level security;
