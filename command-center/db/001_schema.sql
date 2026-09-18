-- COMMAND CENTER XAUUSD — schema v1 (applied 2026-09-18).
-- Own namespace (cc_*). No foreign keys to, and no reads from, the older desk tables.
-- Service-role only; member reads go through authenticated API routes.
-- Tables: cc_snapshots · cc_decisions · cc_execution_states · cc_positions · cc_position_health
--         cc_audit · cc_lessons
-- The full statement set is in the applied migration; this file is the repo's copy of record.

create table if not exists public.cc_snapshots (
  id bigserial primary key, at timestamptz not null default now(), snapshot_version text not null,
  price double precision not null, bid double precision, ask double precision, spread double precision,
  session text not null, regime text not null, pressure_net int,
  timeframes jsonb not null default '{}'::jsonb, levels jsonb not null default '[]'::jsonb,
  feeds jsonb not null default '[]'::jsonb, warnings text[] not null default '{}');

create table if not exists public.cc_decisions (
  decision_id uuid primary key default gen_random_uuid(), at timestamptz not null default now(),
  snapshot_version text not null, snapshot_id bigint references public.cc_snapshots(id),
  strategy text not null, mode text not null, side text not null,
  entry_low double precision, entry_high double precision, stop double precision not null,
  targets double precision[] not null default '{}', confidence int, probability double precision,
  expectancy_pips double precision, thesis jsonb not null,
  evidence text[] not null default '{}', conflicts text[] not null default '{}',
  shadow boolean not null default true);

create table if not exists public.cc_execution_states (
  id bigserial primary key, at timestamptz not null default now(),
  decision_id uuid references public.cc_decisions(decision_id), execution_id uuid not null,
  user_id uuid, account_id text, state text not null, prev_state text, reason text,
  broker_order_id text, broker_position_id text);
-- one terminal row per execution: a trade can only end once
create unique index if not exists cc_exec_one_terminal on public.cc_execution_states (execution_id)
  where state in ('closed','canceled','invalidated');

create table if not exists public.cc_positions (
  id uuid primary key default gen_random_uuid(), opened_at timestamptz not null default now(),
  closed_at timestamptz, user_id uuid not null, account_id text not null, connection_id uuid,
  decision_id uuid references public.cc_decisions(decision_id), execution_id uuid not null,
  broker_position_id text, side text not null, mode text not null, strategy text not null,
  entry double precision not null, qty double precision not null,
  init_stop double precision not null, cur_stop double precision not null,
  targets double precision[] not null default '{}', state text not null default 'open',
  thesis jsonb not null, mfe_pips double precision default 0, mae_pips double precision default 0,
  realized_pips double precision, outcome text,
  unique (account_id, broker_position_id));   -- the broker's id is the truth; one row per position

create table if not exists public.cc_position_health (
  id bigserial primary key, at timestamptz not null default now(),
  position_id uuid references public.cc_positions(id) on delete cascade,
  score int not null, prev_score int, verdict text not null,
  drivers jsonb not null default '[]'::jsonb, action text, why text);

create table if not exists public.cc_audit (
  id bigserial primary key, at timestamptz not null default now(), user_id uuid, account_id text,
  actor text not null, action text not null, reason text, price double precision,
  snapshot_version text, model_version text, strategy_version text,
  risk_before jsonb, risk_after jsonb, api_result jsonb, final_state text);

create table if not exists public.cc_lessons (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
  user_id uuid not null, original_text text not null, structured jsonb not null default '{}'::jsonb,
  kind text, modes text[], strategies text[], regimes text[], sessions text[],
  priority int not null default 5, active boolean not null default true,
  expires_at timestamptz, version int not null default 1);

-- RLS on every table; service role only.
