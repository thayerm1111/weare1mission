-- CASHTRAP (owner 10-21): a separate binary-options signal module — its own tables only; no other
-- tool's table is touched. Server-side only: row level security is on and there are no policies, so
-- only the service role reads or writes; members see Cashtrap through its API routes.

-- Settings: the V1 assumptions (validated in code), who may view, the DMI source mode, the live switch.
create table if not exists public.cashtrap_settings (
  id                int primary key default 1 check (id = 1),
  assumptions       jsonb not null default '{}'::jsonb,
  visibility        text not null default 'admin' check (visibility in ('admin', 'members')),
  dmi_mode          text not null default 'calculation' check (dmi_mode in ('calculation', 'event-feed', 'off')),
  dmi_feed_verified boolean not null default false,
  live_enabled      boolean not null default true,
  updated_at        timestamptz not null default now(),
  updated_by        uuid
);
insert into public.cashtrap_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.cashtrap_settings_log (
  id           bigint generated always as identity primary key,
  changed_at   timestamptz not null default now(),
  changed_by   uuid,
  before_value jsonb,
  after_value  jsonb
);

-- One live runner at a time (acquire-if-expired, like flow_manage_lock but Cashtrap's own).
create table if not exists public.cashtrap_lock (
  id         int primary key,
  holder     text,
  expires_at timestamptz not null default now()
);
insert into public.cashtrap_lock (id, holder, expires_at) values (1, null, now()) on conflict (id) do nothing;

-- Completed 5-minute OHLC candles as received (open time t, UTC). A later different version is a
-- correction: the candle is updated, its revision bumped, and the change logged below.
create table if not exists public.cashtrap_candles (
  symbol        text not null,
  t             timestamptz not null,
  o             numeric not null,
  h             numeric not null,
  l             numeric not null,
  c             numeric not null,
  source        text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  revision      int not null default 0,
  primary key (symbol, t)
);

create table if not exists public.cashtrap_data_corrections (
  id          bigint generated always as identity primary key,
  symbol      text not null,
  t           timestamptz not null,
  before_ohlc jsonb not null,
  after_ohlc  jsonb not null,
  detected_at timestamptz not null default now()
);

-- The engine's state per symbol, so a restart continues exactly where it stopped.
create table if not exists public.cashtrap_state (
  symbol        text primary key,
  state         jsonb not null,
  last_candle_t timestamptz,
  updated_at    timestamptz not null default now()
);

-- What each market card shows right now (written by the live runner, read by the dashboard).
create table if not exists public.cashtrap_snapshots (
  symbol     text primary key,
  snapshot   jsonb not null,
  updated_at timestamptz not null default now()
);

-- Every decision on a completed candle, permanently (one per symbol, candle and strategy version).
create table if not exists public.cashtrap_decisions (
  id               bigint generated always as identity primary key,
  symbol           text not null,
  candle_t         timestamptz not null,
  decided_at       timestamptz not null,
  status           text not null,
  direction        text,
  leading_dir      text,
  met              int not null default 0,
  reason_code      text not null,
  reason           text not null,
  checklist        jsonb,
  ind_values       jsonb,
  zone_id          text,
  setup_id         text,
  strategy_version text not null,
  config_version   text not null,
  created_at       timestamptz not null default now(),
  unique (symbol, candle_t, strategy_version)
);

-- Armed setups and how each ended.
create table if not exists public.cashtrap_setups (
  id                text primary key,
  symbol            text not null,
  direction         text not null check (direction in ('BUY', 'SELL')),
  exhaustion_t      timestamptz not null,
  armed_at          timestamptz not null,
  status            text not null check (status in ('armed', 'confirmed', 'cancelled', 'expired')),
  reason            text,
  ended_at          timestamptz,
  confirm_t         timestamptz,
  published         boolean,
  suppressed_reason text,
  zone              jsonb,
  ind_values        jsonb,
  checklist         jsonb,
  strategy_version  text not null,
  config_version    text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Published signals (one per setup, ever) and their reference-feed outcome.
create table if not exists public.cashtrap_signals (
  id                  uuid primary key default gen_random_uuid(),
  dedupe_key          text not null unique,
  setup_id            text not null unique,
  symbol              text not null,
  direction           text not null check (direction in ('CALL', 'PUT')),
  setup_candle_t      timestamptz not null,
  confirmation_t      timestamptz not null,
  confirmed_at        timestamptz not null,
  published_at        timestamptz not null,
  entry_window_start  timestamptz not null,
  entry_deadline      timestamptz not null,
  expiry_mode         text not null check (expiry_mode in ('duration', 'fixed')),
  expiry_duration_sec int,
  expiry_at           timestamptz,
  reference_price     numeric,
  reference_at        timestamptz,
  reference_source    text,
  settlement_price    numeric,
  settlement_at       timestamptz,
  settlement_source   text,
  status              text not null check (status in ('published', 'active', 'missed', 'settled')),
  result              text not null check (result in ('pending', 'missed', 'win', 'loss', 'tie', 'unresolved')),
  record_type         text not null check (record_type in ('reference-feed', 'simulated', 'broker-verified')),
  payout_rate         numeric,
  payout              numeric,
  exhaustion_values   jsonb,
  confirmation_values jsonb,
  zone                jsonb,
  strategy_version    text not null,
  config_version      text not null,
  notes               jsonb not null default '[]'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Support/resistance zones: automatic (as found) and manual (marked by the owner).
create table if not exists public.cashtrap_zones (
  id                   text primary key,
  symbol               text not null,
  kind                 text not null check (kind in ('support', 'resistance')),
  origin               text not null check (origin in ('auto', 'manual')),
  lower                numeric not null,
  upper                numeric not null,
  center               numeric,
  pivot_t              timestamptz,
  created_at           timestamptz not null,
  confirmed_at         timestamptz,
  atr_at_creation      numeric,
  half_width           numeric,
  touches              int not null default 0,
  first_touch_t        timestamptz,
  last_touch_t         timestamptz,
  invalidated_at       timestamptz,
  invalidated_by_close numeric,
  active_from          timestamptz,
  active_until         timestamptz,
  note                 text,
  created_by           uuid,
  updated_at           timestamptz not null default now()
);

-- Timestamped DMI-Stochastic B/S events from an external feed (the "event-feed" mode).
create table if not exists public.cashtrap_dmi_events (
  id             bigint generated always as identity primary key,
  symbol         text not null,
  candle_t       timestamptz not null,
  type           text not null check (type in ('B', 'S')),
  source         text not null,
  source_version text,
  received_at    timestamptz not null default now(),
  payload        jsonb,
  unique (symbol, candle_t, type, source)
);

-- In-app alerts (one per event, ever) and deliveries to other channels (one per alert, channel, recipient).
create table if not exists public.cashtrap_alerts (
  id         bigint generated always as identity primary key,
  dedupe_key text not null unique,
  kind       text not null,
  symbol     text,
  signal_key text,
  setup_id   text,
  title      text not null,
  body       text not null,
  payload    jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.cashtrap_alert_deliveries (
  id           bigint generated always as identity primary key,
  alert_id     bigint not null references public.cashtrap_alerts (id) on delete cascade,
  channel      text not null,
  recipient    text not null,
  status       text not null,
  error        text,
  attempted_at timestamptz not null default now(),
  unique (alert_id, channel, recipient)
);

create table if not exists public.cashtrap_notification_prefs (
  user_id            uuid primary key,
  prefs              jsonb not null default '{}'::jsonb,
  last_seen_alert_at timestamptz,
  updated_at         timestamptz not null default now()
);

-- Replay/backtest runs: queued from the dashboard, run by the live runner, results kept.
create table if not exists public.cashtrap_replay_runs (
  id           uuid primary key default gen_random_uuid(),
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  params       jsonb not null,
  report       jsonb,
  signals      jsonb,
  error        text,
  requested_by uuid,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

create index if not exists cashtrap_decisions_symbol_t on public.cashtrap_decisions (symbol, candle_t desc);
create index if not exists cashtrap_signals_symbol_pub on public.cashtrap_signals (symbol, published_at desc);
create index if not exists cashtrap_signals_open on public.cashtrap_signals (status) where status in ('published', 'active');
create index if not exists cashtrap_setups_symbol_t on public.cashtrap_setups (symbol, exhaustion_t desc);
create index if not exists cashtrap_zones_symbol on public.cashtrap_zones (symbol, origin);
create index if not exists cashtrap_alerts_created on public.cashtrap_alerts (created_at desc);
create index if not exists cashtrap_dmi_events_symbol_t on public.cashtrap_dmi_events (symbol, candle_t);
create index if not exists cashtrap_replay_runs_status on public.cashtrap_replay_runs (status, created_at);

alter table public.cashtrap_settings enable row level security;
alter table public.cashtrap_settings_log enable row level security;
alter table public.cashtrap_lock enable row level security;
alter table public.cashtrap_candles enable row level security;
alter table public.cashtrap_data_corrections enable row level security;
alter table public.cashtrap_state enable row level security;
alter table public.cashtrap_snapshots enable row level security;
alter table public.cashtrap_decisions enable row level security;
alter table public.cashtrap_setups enable row level security;
alter table public.cashtrap_signals enable row level security;
alter table public.cashtrap_zones enable row level security;
alter table public.cashtrap_dmi_events enable row level security;
alter table public.cashtrap_alerts enable row level security;
alter table public.cashtrap_alert_deliveries enable row level security;
alter table public.cashtrap_notification_prefs enable row level security;
alter table public.cashtrap_replay_runs enable row level security;
