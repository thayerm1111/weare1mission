-- GENX 3.2.2 — PDH_PDL_BREAK_RETEST_CONTINUATION. Additive only.
alter table public.genx3_setups drop constraint if exists genx3_setups_setup_type_check;
alter table public.genx3_setups add constraint genx3_setups_setup_type_check check (setup_type in (
  'TREND_PULLBACK','SWEEP_RECLAIM','BREAKOUT_RETEST','RANGE_REJECTION','MOMENTUM_CONTINUATION','COMPRESSION_BREAKOUT','FAILED_BREAKOUT','SESSION_BREAK','BOS_PULLBACK',
  'MICRO_CONTINUATION','BREAKOUT_RETEST_V2','COMPRESSION_EXPANSION','SWEEP_RECLAIM_DISPLACEMENT','TREND_REENTRY','MOMENTUM_EXPANSION',
  'PDH_PDL_BREAK_RETEST_CONTINUATION'));

-- One row per PDH/PDL state machine (level × trading day × cycle): the full sequence, evidence and why it was taken or rejected.
create table if not exists public.genx3_pd_setups (
  anchor text primary key,                         -- PD32:<PDH|PDL>:<BUY|SELL>:<trading day>:c<cycle>
  strategy_version text not null,
  level text not null check (level in ('PDH','PDL')), side text not null check (side in ('BUY','SELL')),
  trading_day date not null, cycle smallint not null, level_price numeric not null,
  phase text not null, fail_reason text,
  break_at timestamptz, break_displacement_atr5 numeric, breakout_extreme numeric,
  acceptance_score numeric, acceptance_evidence jsonb not null default '[]', accepted_at timestamptz,
  retest_at timestamptz, retest_extreme numeric, retest_depth numeric, retest_zone jsonb,
  defense_score numeric, defense_evidence jsonb not null default '[]', trigger_price numeric,
  entry_at timestamptz, entry_price numeric, entry_trigger text,
  stop numeric, target numeric, confidence smallint, candidate_status text, candidate_reasons text[] not null default '{}', engine_mode text, signal_id uuid,
  transitions jsonb not null default '[]',
  updated_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create index if not exists genx3_pd_setups_day_idx on public.genx3_pd_setups (trading_day desc, level);
alter table public.genx3_pd_setups enable row level security;
