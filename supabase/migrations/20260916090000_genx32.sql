-- GENX 3.2 — additive only (no drops of data).
alter table public.genx3_control add column if not exists designated_account_ids text[] not null default '{}';

alter table public.genx3_setups drop constraint if exists genx3_setups_setup_type_check;
alter table public.genx3_setups add constraint genx3_setups_setup_type_check check (setup_type in (
  'TREND_PULLBACK','SWEEP_RECLAIM','BREAKOUT_RETEST','RANGE_REJECTION','MOMENTUM_CONTINUATION','COMPRESSION_BREAKOUT','FAILED_BREAKOUT','SESSION_BREAK','BOS_PULLBACK',
  'MICRO_CONTINUATION','BREAKOUT_RETEST_V2','COMPRESSION_EXPANSION','SWEEP_RECLAIM_DISPLACEMENT','TREND_REENTRY','MOMENTUM_EXPANSION'));

-- Every candidate / wait with its status, reasons, score, threshold, market state and the shadow outcome.
create table if not exists public.genx3_candidates (
  id uuid primary key default gen_random_uuid(),
  strategy_version text not null,
  at timestamptz not null,                 -- closed-minute decision time
  setup text not null, side text not null check (side in ('BUY','SELL')), anchor text not null,
  status text not null check (status in ('PASSED','FAILED','WAITED','EXPIRED','INVALIDATED','LOST_ARBITRATION','NOT_ROUTED','SHADOW_ONLY','SELECTED')),
  reasons text[] not null default '{}', score smallint, threshold smallint, components jsonb not null default '{}',
  engine_mode text, market_state text, htf jsonb,
  entry numeric, stop numeric, target numeric, risk numeric, target_r numeric, room_r numeric, evidence jsonb not null default '[]',
  signal_id uuid,
  shadow_status text not null default 'NA' check (shadow_status in ('NA','OPEN','RESOLVED','NOT_FILLED')),
  shadow_fill numeric, shadow_fill_at timestamptz, shadow_exit numeric, shadow_exit_at timestamptz, shadow_result text,
  shadow_r numeric, shadow_mfe_r numeric, shadow_mae_r numeric, resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists genx3_candidates_at_idx on public.genx3_candidates (strategy_version, at desc);
create index if not exists genx3_candidates_open_idx on public.genx3_candidates (shadow_status, at) where shadow_status = 'OPEN';
create index if not exists genx3_candidates_anchor_idx on public.genx3_candidates (strategy_version, anchor);

-- Real execution telemetry per live order attempt.
create table if not exists public.genx3_executions (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null, account_id text not null, strategy_version text not null, setup text, market_state text,
  signal_at timestamptz, signal_price numeric, requested_entry numeric, signal_stop numeric, signal_target numeric,
  bid numeric, ask numeric, spread numeric, quote_at timestamptz, limit_price numeric, qty numeric, risk_pct numeric, equity numeric,
  order_stop numeric, order_target numeric, submit_at timestamptz, ack_at timestamptz,
  ok boolean not null, order_id text, position_id text, error text,
  fill_price numeric, fill_at timestamptz, slippage numeric, filled_qty numeric,
  created_at timestamptz not null default now()
);
create index if not exists genx3_executions_signal_idx on public.genx3_executions (signal_id);

alter table public.genx3_candidates enable row level security;
alter table public.genx3_executions enable row level security;
