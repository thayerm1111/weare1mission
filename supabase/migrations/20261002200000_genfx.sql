-- GEN FX (owner 10-02: "an exact system, just like Gen X, but for Euro USD and GBP JPY … its own
-- tool on the floor … the same capabilities of being automatically used in trade").
--
-- Everything here is NEW and additive. No GENX table is altered, no gold row is read differently.
-- The one shared table that changes is flow_broker_accounts, which gains two switches that default to
-- off: an account takes a GEN FX pair only when its member turns that pair on for it. Nobody's gold
-- settings carry over.
--
-- Access: genfx_control, genfx_alerts and genfx_fills' writes are the server's (service role) — RLS is
-- on with no write policy, exactly as genx_alerts is. A member can read their own page reads, their
-- own saved setups and their own fills.
--
-- APPLIED 2026-10-02 21:28 UTC to project pguzevnkmpwfuzcjbcbx, in five steps recorded as
-- genfx_control, genfx_alerts_fills, genfx_signals, genfx_tracked and genfx_account_switches (each
-- under `set local lock_timeout = '5s'`, so a busy table would have failed the step instead of
-- queueing in front of the trade manager). This file is the same schema as one re-runnable script.

-- ── The switches. One row. Read at decision time; an unreadable row means "do nothing". ──
create table if not exists public.genfx_control (
  id integer primary key default 1 check (id = 1),
  scan_enabled boolean not null default true,       -- the scanner reads, records and grades (no money)
  auto_enabled boolean not null default false,      -- placement; off = no order leaves for anyone
  auto_scope text not null default 'demo' check (auto_scope in ('owner', 'demo', 'all')),
  billing_enabled boolean not null default false,   -- off = reads and trades cost no credits
  telegram_enabled boolean not null default false,  -- off = nothing is posted to the channel
  config jsonb not null default '{}'::jsonb,        -- tunables; see src/lib/genfx/control.ts
  replay_request jsonb,                             -- set to an object to ask the worker for a history replay
  replay_result jsonb,
  updated_at timestamptz not null default now()
);
insert into public.genfx_control (id) values (1) on conflict (id) do nothing;
alter table public.genfx_control enable row level security;

-- ── What the scanner found and what became of it (genx_alerts, plus the pair). ──
create table if not exists public.genfx_alerts (
  id uuid primary key default gen_random_uuid(),
  pair text not null check (pair in ('EURUSD', 'GBPJPY')),
  dedupe_key text not null unique,
  mode text not null,
  side text not null,
  action text not null,
  entry numeric, entry_low numeric, entry_high numeric,
  stop numeric, tp1 numeric, tp2 numeric, tp3 numeric,
  invalidation numeric, watch numeric,
  confidence integer,
  trigger_tf text,
  state text not null default 'forming',
  heads_up_sent_at timestamptz, enter_sent_at timestamptz, last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  enter_price numeric,
  outcome text, result_pips numeric, resolved_at timestamptz, win_posted_at timestamptz,
  quality_ok boolean
);
create index if not exists genfx_alerts_state_idx on public.genfx_alerts (state);
create index if not exists genfx_alerts_pair_created_idx on public.genfx_alerts (pair, created_at desc);
create index if not exists genfx_alerts_outcome_idx on public.genfx_alerts (outcome);
alter table public.genfx_alerts enable row level security;

-- ── Every read a member runs on the GEN FX page, exactly as it was shown (genx_signals, plus the pair). ──
create table if not exists public.genfx_signals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  pair text not null check (pair in ('EURUSD', 'GBPJPY')),
  symbol text not null,
  mode text not null,
  action text, direction text,
  entry double precision, entry_low double precision, entry_high double precision,
  stop_loss double precision, tp1 double precision, tp2 double precision, tp3 double precision,
  stop_pips double precision, tp1_pips double precision, tp2_pips double precision, tp3_pips double precision,
  confidence integer,
  market_regime text, market_structure text, momentum text,
  closest_support double precision, closest_resistance double precision,
  setup_type text,
  status text default 'generated',
  reasoning jsonb, market_snapshot jsonb,
  model_version text, prompt_version text, engine_version text,
  outcome text, filled boolean,
  tp1_hit boolean, tp2_hit boolean, tp3_hit boolean, sl_hit boolean,
  mfe_pips double precision, mae_pips double precision,
  minutes_to_tp double precision, minutes_to_sl double precision,
  directional_correct boolean, resolved_at timestamptz
);
create index if not exists genfx_signals_created_idx on public.genfx_signals (created_at desc);
create index if not exists genfx_signals_user_idx on public.genfx_signals (user_id, created_at desc);
create index if not exists genfx_signals_open_idx on public.genfx_signals (outcome) where outcome is null;
alter table public.genfx_signals enable row level security;
drop policy if exists genfx_signals_select_own on public.genfx_signals;
create policy genfx_signals_select_own on public.genfx_signals for select using (auth.uid() = user_id or public.current_is_admin());

-- ── A member's saved setups, synced between their devices (genx_tracked). ──
create table if not exists public.genfx_tracked (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_id)
);
create index if not exists genfx_tracked_user_idx on public.genfx_tracked (user_id, created_at desc);
alter table public.genfx_tracked enable row level security;
drop policy if exists genfx_tracked_select_own on public.genfx_tracked;
drop policy if exists genfx_tracked_insert_own on public.genfx_tracked;
drop policy if exists genfx_tracked_update_own on public.genfx_tracked;
drop policy if exists genfx_tracked_delete_own on public.genfx_tracked;
create policy genfx_tracked_select_own on public.genfx_tracked for select using (auth.uid() = user_id);
create policy genfx_tracked_insert_own on public.genfx_tracked for insert with check (auth.uid() = user_id);
create policy genfx_tracked_update_own on public.genfx_tracked for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy genfx_tracked_delete_own on public.genfx_tracked for delete using (auth.uid() = user_id);

-- ── One fill per call per account. The primary key IS the rule: a second pass over the same call on
--    the same account cannot insert, so it cannot place. ──
create table if not exists public.genfx_fills (
  signal_key text not null,
  account_id text not null,
  user_id uuid not null,
  connection_id uuid,
  acc_num text,
  environment text,
  pair text not null check (pair in ('EURUSD', 'GBPJPY')),
  side text not null,
  mode text,
  setup text,
  alert_id uuid,
  status text not null default 'reserved',          -- reserved → placed → managed | cancelled | uncertain
  qty numeric, entry numeric, stop numeric, tp numeric,
  risk_pct numeric, est_loss numeric,
  order_id text, position_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (signal_key, account_id)
);
create index if not exists genfx_fills_status_idx on public.genfx_fills (status, created_at desc);
create index if not exists genfx_fills_user_idx on public.genfx_fills (user_id, created_at desc);
create index if not exists genfx_fills_order_idx on public.genfx_fills (account_id, order_id);
alter table public.genfx_fills enable row level security;
drop policy if exists genfx_fills_select_own on public.genfx_fills;
create policy genfx_fills_select_own on public.genfx_fills for select using (auth.uid() = user_id);

-- ── The GEN FX loop's lock: exactly one process scans and watches at a time (rows 1–5 are taken). ──
insert into public.flow_manage_lock (id, holder, expires_at) values (6, null, now()) on conflict (id) do nothing;

-- ── The per-account switches. Off for everybody until they turn one on. ──
alter table public.flow_broker_accounts
  add column if not exists genfx_eurusd boolean not null default false,
  add column if not exists genfx_gbpjpy boolean not null default false;
create index if not exists flow_broker_accounts_genfx_idx on public.flow_broker_accounts (user_id) where genfx_eurusd or genfx_gbpjpy;

-- GEN FX rows in the shared trade ledger are found by their strategy stamp.
create index if not exists flow_managed_positions_genfx_idx on public.flow_managed_positions (symbol, created_at desc) where strategy_version = 'genfx-1.0';
