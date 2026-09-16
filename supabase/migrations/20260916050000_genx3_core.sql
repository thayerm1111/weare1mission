-- GENX 3.0 core schema. Additive only: no existing table is altered or dropped.
-- All times UTC (timestamptz). Service role only (RLS on, no policies).

-- ── Control: operating mode + live scope (one row). The global kill switch remains
--    flow_switches.genx_enabled; this row is the GENX 3.0 signal-generation switch.
create table if not exists public.genx3_control (
  id               smallint primary key default 1 check (id = 1),
  mode             text not null default 'MONITOR' check (mode in ('OFF','MONITOR','LIVE','EMERGENCY_DISABLED')),
  live_scope       text not null default 'designated' check (live_scope in ('designated','authorized')),
  designated_user_ids uuid[] not null default '{}',
  strategy_version text not null default '3.0.0',
  note             text,
  updated_by       text,
  updated_at       timestamptz not null default now()
);
insert into public.genx3_control (id) values (1) on conflict (id) do nothing;

create table if not exists public.genx3_control_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  old_mode text, new_mode text, old_scope text, new_scope text,
  designated_user_ids uuid[], strategy_version text, note text, updated_by text
);
create or replace function public.genx3_control_audit() returns trigger language plpgsql as $$
begin
  insert into public.genx3_control_events (old_mode, new_mode, old_scope, new_scope, designated_user_ids, strategy_version, note, updated_by)
  values (old.mode, new.mode, old.live_scope, new.live_scope, new.designated_user_ids, new.strategy_version, new.note, new.updated_by);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists genx3_control_audit on public.genx3_control;
create trigger genx3_control_audit before update on public.genx3_control for each row execute function public.genx3_control_audit();

-- ── Decisions: one row per closed 5m decision candle per strategy version (NO_TRADE included).
create table if not exists public.genx3_decisions (
  id                    uuid primary key default gen_random_uuid(),
  strategy_version      text not null,
  snapshot_id           uuid not null,
  as_of                 timestamptz not null,
  decision_candle_close timestamptz not null,
  mode                  text not null,
  data_state            text not null check (data_state in ('HEALTHY','DEGRADED','INVALID')),
  data_issues           jsonb not null default '[]',
  feed_age_ms           integer,
  news_state            text not null check (news_state in ('CLEAR','BLOCKED','UNKNOWN')),
  regime                text,
  regime_confidence     smallint,
  regime_detail         jsonb,
  candidates            jsonb not null default '[]',
  no_trade_reasons      text[] not null default '{}',
  signal_id             uuid,
  worker                text,
  created_at            timestamptz not null default now(),
  unique (strategy_version, decision_candle_close)
);
create index if not exists genx3_decisions_close_idx on public.genx3_decisions (decision_candle_close desc);

-- ── Setups + state machine (transitions validated in the database).
create table if not exists public.genx3_setups (
  setup_id         uuid primary key,
  strategy_version text not null,
  setup_key        text not null,
  setup_type       text not null check (setup_type in ('TREND_PULLBACK','SWEEP_RECLAIM','BREAKOUT_RETEST','RANGE_REJECTION')),
  side             text not null check (side in ('BUY','SELL')),
  state            text not null check (state in ('WAIT','WATCHING','APPROACHING','ARMED','TRIGGERED','PUBLISHED','EXPIRED','INVALIDATED','REJECTED_BY_FLOW')),
  snapshot_id      uuid not null,
  first_seen_at    timestamptz not null default now(),
  state_at         timestamptz not null default now(),
  expires_at       timestamptz not null,
  detail           jsonb not null default '{}',
  unique (strategy_version, setup_key)
);
create index if not exists genx3_setups_live_idx on public.genx3_setups (state) where state not in ('PUBLISHED','EXPIRED','INVALIDATED','REJECTED_BY_FLOW');

create table if not exists public.genx3_setup_transitions (
  id          bigserial primary key,
  setup_id    uuid not null references public.genx3_setups(setup_id),
  from_state  text,
  to_state    text not null,
  at          timestamptz not null default now(),
  snapshot_id uuid,
  reason      text
);

create or replace function public.genx3_setup_guard() returns trigger language plpgsql as $$
declare ord_from int; ord_to int;
begin
  if tg_op = 'UPDATE' then
    if new.setup_id <> old.setup_id or new.setup_key <> old.setup_key or new.strategy_version <> old.strategy_version
       or new.side <> old.side or new.setup_type <> old.setup_type then
      raise exception 'genx3_setups identity fields are immutable';
    end if;
    if new.state = old.state then return new; end if;
    if old.state in ('PUBLISHED','EXPIRED','INVALIDATED','REJECTED_BY_FLOW') and not (old.state = 'PUBLISHED' and new.state = 'REJECTED_BY_FLOW') then
      raise exception 'genx3 setup % is terminal (%), cannot move to %', old.setup_id, old.state, new.state;
    end if;
    ord_from := array_position(array['WAIT','WATCHING','APPROACHING','ARMED','TRIGGERED','PUBLISHED'], old.state);
    ord_to   := array_position(array['WAIT','WATCHING','APPROACHING','ARMED','TRIGGERED','PUBLISHED'], new.state);
    if new.state = 'PUBLISHED' and old.state <> 'TRIGGERED' then
      raise exception 'genx3 setup can only be PUBLISHED from TRIGGERED (was %)', old.state;
    end if;
    if ord_to is not null and ord_from is not null and ord_to <= ord_from then
      raise exception 'genx3 setup cannot move backwards % -> %', old.state, new.state;
    end if;
    new.state_at := now();
  end if;
  insert into public.genx3_setup_transitions (setup_id, from_state, to_state, snapshot_id, reason)
  values (new.setup_id, case when tg_op = 'UPDATE' then old.state end, new.state, new.snapshot_id, new.detail->>'transition_reason');
  return new;
end $$;
drop trigger if exists genx3_setup_guard on public.genx3_setups;
create trigger genx3_setup_guard before insert or update on public.genx3_setups for each row execute function public.genx3_setup_guard();

-- ── Published signals: immutable payload, globally unique idempotency key.
create table if not exists public.genx3_signals (
  signal_id        uuid primary key,
  idempotency_key  text not null unique check (idempotency_key ~ '^[0-9a-f]{64}$'),
  setup_id         uuid not null references public.genx3_setups(setup_id),
  strategy_version text not null,
  decision_candle_close timestamptz not null,
  side             text not null check (side in ('BUY','SELL')),
  entry_zone_low   numeric not null, entry_zone_high numeric not null,
  stop_price       numeric not null, target_price numeric not null,
  payload          jsonb not null,
  mode             text not null check (mode in ('MONITOR','LIVE')),
  status           text not null default 'PUBLISHED' check (status in ('PUBLISHED','DELIVERING','DELIVERED','PARTIAL','FAILED','BLOCKED','NOT_DELIVERED_MONITOR')),
  delivery_attempts smallint not null default 0,
  delivery_started_at timestamptz, delivery_finished_at timestamptz,
  delivery_summary jsonb,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  check (entry_zone_low <= entry_zone_high),
  check ((side = 'BUY' and stop_price < entry_zone_low and target_price > entry_zone_high) or (side = 'SELL' and stop_price > entry_zone_high and target_price < entry_zone_low))
);
create unique index if not exists genx3_signals_one_per_setup on public.genx3_signals (setup_id);
create or replace function public.genx3_signal_immutable() returns trigger language plpgsql as $$
begin
  if new.payload <> old.payload or new.idempotency_key <> old.idempotency_key or new.stop_price <> old.stop_price
     or new.target_price <> old.target_price or new.entry_zone_low <> old.entry_zone_low or new.entry_zone_high <> old.entry_zone_high
     or new.side <> old.side or new.setup_id <> old.setup_id or new.mode <> old.mode then
    raise exception 'genx3_signals decision fields are immutable';
  end if;
  return new;
end $$;
drop trigger if exists genx3_signal_immutable on public.genx3_signals;
create trigger genx3_signal_immutable before update on public.genx3_signals for each row execute function public.genx3_signal_immutable();

-- Claim a signal for delivery exactly once (compare-and-set). Returns true only to the first caller.
create or replace function public.genx3_claim_delivery(p_signal_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.genx3_signals
     set status = 'DELIVERING', delivery_attempts = delivery_attempts + 1, delivery_started_at = now()
   where signal_id = p_signal_id and status = 'PUBLISHED' and mode = 'LIVE' and expires_at > now();
  return found;
end $$;

-- ── Per-account delivery outcomes (one row per signal per account).
create table if not exists public.genx3_deliveries (
  id          bigserial primary key,
  signal_id   uuid not null references public.genx3_signals(signal_id),
  account_id  text not null,
  user_id     uuid,
  path        text not null check (path in ('copy','follower')),
  status      text not null check (status in ('placed','error','deferred','uncertain','skipped')),
  reason      text,
  order_id    text,
  qty         numeric,
  at          timestamptz not null default now(),
  unique (signal_id, account_id)
);

-- ── Post-trade reviews (filled by the learning job; recommendations never auto-apply).
create table if not exists public.genx3_trade_reviews (
  id               bigserial primary key,
  signal_id        uuid not null references public.genx3_signals(signal_id),
  account_id       text,
  position_id      text,
  outcome          text,
  result_usd_move  numeric,
  mfe_usd numeric, mae_usd numeric, minutes_to_mfe integer, minutes_to_mae integer,
  entry_slippage_usd numeric,
  classification   text check (classification in ('correct_thesis_correct_execution','correct_thesis_poor_timing','correct_direction_unrealistic_target','stop_too_tight','invalid_structure','false_breakout','failed_sweep','regime_transition','late_or_chased_entry','spread_or_slippage','data_quality','news_event','flow_execution','normal_valid_loss')),
  notes            jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  unique (signal_id, account_id)
);

create table if not exists public.genx3_recommendations (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  strategy_version text not null,
  title text not null,
  evidence jsonb not null,
  proposed_change jsonb not null,
  status text not null default 'PROPOSED' check (status in ('PROPOSED','APPROVED','REJECTED','DEPLOYED')),
  decided_at timestamptz, decided_by text
);

create table if not exists public.genx3_incidents (
  id bigserial primary key,
  at timestamptz not null default now(),
  kind text not null,
  severity text not null check (severity in ('info','warn','critical')),
  detail jsonb not null default '{}'
);

-- Lock row for the single GENX 3.0 engine loop.
insert into public.flow_manage_lock (id, holder, expires_at) values (3, null, now()) on conflict (id) do nothing;

alter table public.genx3_control enable row level security;
alter table public.genx3_control_events enable row level security;
alter table public.genx3_decisions enable row level security;
alter table public.genx3_setups enable row level security;
alter table public.genx3_setup_transitions enable row level security;
alter table public.genx3_signals enable row level security;
alter table public.genx3_deliveries enable row level security;
alter table public.genx3_trade_reviews enable row level security;
alter table public.genx3_recommendations enable row level security;
alter table public.genx3_incidents enable row level security;
