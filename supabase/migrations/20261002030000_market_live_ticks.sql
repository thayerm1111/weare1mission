-- The newest streamed tick per symbol (owner 10-01: "when I talk to ATLAS it's behind on actual live
-- price"). The price stream in the worker holds its ticks in memory, so nothing outside that process
-- could read them, and ATLAS quoted the price out of a snapshot written about once a minute. The
-- stream now publishes its newest tick here (one row per symbol, at most once a second) and the
-- Command Center reads it at the moment of an answer.
--
-- Server-side only: row level security is on with no policies, so only the service role reads or writes.
create table if not exists public.market_live_ticks (
  symbol      text primary key,
  price       numeric not null,
  tick_at     timestamptz not null,   -- the provider's own timestamp for the tick
  received_at timestamptz not null,   -- when the stream received it (what freshness is judged by)
  updated_at  timestamptz not null default now()
);
alter table public.market_live_ticks enable row level security;
