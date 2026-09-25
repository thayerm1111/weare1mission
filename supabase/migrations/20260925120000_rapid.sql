-- =================================================================================================
-- RAPID (matty_rapid_v1) — durable state for the XAUUSD Rapid analysis and execution feature.
--
-- Everything Rapid owns is prefixed rapid_. Nothing here alters a FLOW, GENX, Command Center,
-- Matty Pips or AURIC table. Every table has RLS enabled; members may read only their own rows and
-- write nothing, because every write path is a service-role worker or an authenticated route that
-- has already checked ownership. Credential storage is deny-all even to its owner.
--
-- The design rule behind the schema: a decision is a ROW, written at the time it is made, carrying
-- the source quote, the level version, the structural references, the costs and the reason. Nothing
-- is recomputed later to explain what happened.
-- =================================================================================================

-- ---- Strategy and configuration versions --------------------------------------------------------
create table if not exists public.rapid_config_versions (
  config_version  text primary key,
  strategy_version text not null,
  management_version text not null,
  config          jsonb not null,
  notes           text,
  created_at      timestamptz not null default now(),
  created_by      text
);

-- ---- Global control. One row. The kill switch and the feature flag live here. --------------------
create table if not exists public.rapid_control (
  id                smallint primary key default 1 check (id = 1),
  mode              text not null default 'off' check (mode in ('off','analyze_only','live')),
  strategy_version  text not null default 'matty_rapid_v1',
  config_version    text not null default 'matty_rapid_v1.cfg.1',
  -- When true no new entries are submitted anywhere. Protection and management keep running.
  entries_paused    boolean not null default true,
  pause_reason      text,
  note              text,
  updated_by        text,
  updated_at        timestamptz not null default now()
);
insert into public.rapid_control (id) values (1) on conflict (id) do nothing;

create table if not exists public.rapid_control_events (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  old_mode      text,
  new_mode      text,
  entries_paused boolean,
  reason        text,
  updated_by    text
);

-- ---- Broker connections and accounts -------------------------------------------------------------
-- Tokens are encrypted at rest with a key held outside the database. The password is never stored
-- unless the member explicitly opts into unattended reconnection.
create table if not exists public.rapid_broker_connections (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  environment    text not null check (environment in ('demo','live')),
  server         text not null,
  email_masked   text not null,
  enc_refresh    text,
  enc_password   text,
  access_token   text,
  token_expires_at timestamptz,
  last_auth_at   timestamptz,
  status         text not null default 'connected' check (status in ('connected','reconnect_required','error','revoked')),
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists rapid_conn_user on public.rapid_broker_connections (user_id, updated_at desc);

create table if not exists public.rapid_accounts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  connection_id      uuid not null references public.rapid_broker_connections(id) on delete cascade,
  -- TradeLocker identity: the path segment and the accNum header are DIFFERENT values.
  broker_account_id  text not null,
  acc_num            text not null,
  environment        text not null check (environment in ('demo','live')),
  server             text not null,
  name               text,
  currency           text,
  balance            numeric,
  equity             numeric,
  equity_at          timestamptz,
  -- Resolved instrument, cached with its provenance so an ambiguous match can be re-checked.
  instrument_spec    jsonb,
  spec_missing       text[] not null default '{}',
  instrument_resolved_at timestamptz,
  -- The four product controls.
  automation_enabled boolean not null default false,
  automation_enabled_at timestamptz,
  automation_version bigint not null default 0,
  management_enabled boolean not null default true,
  risk_pct           numeric not null default 0.5 check (risk_pct > 0 and risk_pct <= 5),
  -- Account-level isolation: another product trading the same broker account shares its equity.
  allow_shared_account boolean not null default false,
  ownership_check    jsonb,
  status             text not null default 'linked' check (status in ('linked','blocked','disabled')),
  block_reason       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (connection_id, broker_account_id)
);
-- One Rapid owner per physical broker account, across all app users.
create unique index if not exists rapid_accounts_physical
  on public.rapid_accounts (environment, server, broker_account_id);
create index if not exists rapid_accounts_user on public.rapid_accounts (user_id);
create index if not exists rapid_accounts_armed on public.rapid_accounts (automation_enabled) where automation_enabled;

-- ---- Level versions -------------------------------------------------------------------------------
create table if not exists public.rapid_zone_versions (
  zone_id        text not null,
  version        integer not null,
  parent_id      text not null,
  role           text not null check (role in ('support','resistance','range')),
  low            numeric not null,
  high           numeric not null,
  origin         text not null,
  tier           text not null check (tier in ('primary','execution')),
  provenance     jsonb not null,
  known_at       timestamptz not null,
  role_since     timestamptz not null,
  previous_role  text,
  reactions      jsonb not null default '[]',
  failed_stops   smallint not null default 0,
  invalidated_at timestamptz,
  invalid_reason text,
  merged_from    text[] not null default '{}',
  created_at     timestamptz not null default now(),
  primary key (zone_id, version),
  check (high >= low)
);
create index if not exists rapid_zone_parent on public.rapid_zone_versions (parent_id, known_at desc);

-- ---- Analysis snapshots ----------------------------------------------------------------------------
create table if not exists public.rapid_snapshots (
  snapshot_id       text primary key,
  strategy_version  text not null,
  config_version    text not null,
  generated_at      timestamptz not null,
  market_event_time timestamptz not null,
  feed_source       text not null check (feed_source in ('broker','reference')),
  quote_age_ms      integer,
  health            jsonb not null,
  regimes           jsonb not null,
  regime_conflict   boolean not null default false,
  payload           jsonb not null,
  created_at        timestamptz not null default now()
);
create index if not exists rapid_snap_time on public.rapid_snapshots (generated_at desc);

-- ---- Setups and visits -------------------------------------------------------------------------------
create table if not exists public.rapid_setup_visits (
  visit_id       text primary key,
  visit_key      text not null,
  setup_id       text not null,
  strategy_version text not null,
  config_version text not null,
  family         text not null check (family in ('range_reaction','break_retest','trend_pullback','momentum')),
  side           text not null check (side in ('buy','sell')),
  timeframe      text not null,
  zone_id        text not null,
  zone_version   integer not null,
  parent_id      text not null,
  state          text not null check (state in ('watching','approaching','armed','triggered','consumed','waiting_for_departure','invalidated','expired')),
  -- The frozen plan. None of this is recomputed once the visit exists.
  tolerances     jsonb not null,
  entry_band_low numeric not null,
  entry_band_high numeric not null,
  invalidation   numeric not null,
  stop           numeric not null,
  target         numeric not null,
  ref_entry      numeric not null,
  opposing_level_id text,
  opposing_price numeric,
  break_evidence jsonb,
  conditions_met text[] not null default '{}',
  conditions_pending text[] not null default '{}',
  created_at     timestamptz not null default now(),
  state_at       timestamptz not null default now(),
  expires_at     timestamptz not null,
  snapshot_id    text
);
create index if not exists rapid_visit_key on public.rapid_setup_visits (visit_key, state);
create index if not exists rapid_visit_open on public.rapid_setup_visits (state) where state not in ('consumed','invalidated','expired');

create table if not exists public.rapid_visit_transitions (
  id         bigserial primary key,
  visit_id   text not null references public.rapid_setup_visits(visit_id) on delete cascade,
  from_state text not null,
  to_state   text not null,
  at         timestamptz not null,
  reason     text not null,
  evidence   jsonb not null default '{}'
);
create index if not exists rapid_transitions_visit on public.rapid_visit_transitions (visit_id, at);

-- ---- Automation sessions ---------------------------------------------------------------------------
-- One row per continuous period during which an account was armed. Ending one is how "Automation
-- OFF" becomes auditable rather than just a boolean that changed at some point.
create table if not exists public.rapid_automation_sessions (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.rapid_accounts(id) on delete cascade,
  user_id        uuid not null,
  started_at     timestamptz not null default now(),
  started_by     text,
  ended_at       timestamptz,
  ended_reason   text,
  -- Equity at the start of the risk session, used for the session loss ceiling.
  session_start_equity numeric,
  session_date   date not null,
  deposits_withdrawals numeric not null default 0,
  realised_pnl   numeric not null default 0,
  entries_paused boolean not null default false,
  pause_reason   text,
  config_version text not null,
  management_version text not null
);
create index if not exists rapid_autosess_open on public.rapid_automation_sessions (account_id) where ended_at is null;

-- ---- Risk reservations -------------------------------------------------------------------------------
-- Reserved BEFORE an order is sent, released or converted after the outcome is known. This is what
-- makes "how much is this account risking right now" answerable while an order is in flight.
create table if not exists public.rapid_risk_reservations (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.rapid_accounts(id) on delete cascade,
  visit_id      text not null,
  intent_key    text not null,
  amount        numeric not null check (amount >= 0),
  currency      text,
  state         text not null default 'held' check (state in ('held','converted','released')),
  created_at    timestamptz not null default now(),
  settled_at    timestamptz,
  unique (intent_key)
);
create index if not exists rapid_resv_held on public.rapid_risk_reservations (account_id) where state = 'held';

-- ---- Order intents --------------------------------------------------------------------------------
-- `intent_key` is the durable idempotency key: account + strategy version + economic setup + visit.
-- A unique constraint cannot guarantee exactly-once EXTERNAL execution, so `submission_unknown` is a
-- first-class state and reconciliation, not a retry, is what resolves it.
create table if not exists public.rapid_intents (
  id                uuid primary key default gen_random_uuid(),
  intent_key        text not null unique,
  account_id        uuid not null references public.rapid_accounts(id) on delete cascade,
  user_id           uuid not null,
  session_id        uuid references public.rapid_automation_sessions(id),
  visit_id          text not null,
  setup_id          text not null,
  snapshot_id       text,
  strategy_version  text not null,
  config_version    text not null,
  management_version text not null,
  family            text not null,
  side              text not null check (side in ('buy','sell')),
  state             text not null default 'reserved' check (state in (
    'reserved','submitting','acknowledged','partially_filled','filled',
    'protection_pending','protected','cancel_requested','cancelled',
    'rejected','submission_unknown','closed')),
  -- The plan, frozen at approval.
  planned_entry     numeric not null,
  planned_stop      numeric not null,
  planned_target    numeric not null,
  qty               numeric not null check (qty > 0),
  risk_pct          numeric not null,
  estimated_risk    numeric,
  -- The quote the decision was made on.
  quote_bid         numeric,
  quote_ask         numeric,
  quote_age_ms      integer,
  spread            numeric,
  -- The account's view of the toggle when the intent was approved; checked again before submission.
  automation_version bigint not null default 0,
  -- Fencing token of the lease that created this intent. A stale worker's writes are refused.
  fence             bigint not null default 0,
  broker_strategy_id text,
  broker_order_id   text,
  broker_position_id text,
  submitted_at      timestamptz,
  ack_at            timestamptz,
  ack_latency_ms    integer,
  fill_price        numeric,
  filled_qty        numeric,
  slippage          numeric,
  error             text,
  detail            jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists rapid_intent_account on public.rapid_intents (account_id, created_at desc);
create index if not exists rapid_intent_live on public.rapid_intents (state)
  where state in ('reserved','submitting','acknowledged','partially_filled','protection_pending','submission_unknown','cancel_requested');
-- One live intent per account at a time. The concurrency policy, enforced by the database.
create unique index if not exists rapid_intent_one_live_per_account on public.rapid_intents (account_id)
  where state in ('reserved','submitting','acknowledged','partially_filled','filled','protection_pending','protected','cancel_requested','submission_unknown');

-- ---- Broker order and fill mapping -------------------------------------------------------------------
create table if not exists public.rapid_broker_events (
  id            bigserial primary key,
  intent_id     uuid references public.rapid_intents(id) on delete cascade,
  account_id    uuid not null references public.rapid_accounts(id) on delete cascade,
  at            timestamptz not null default now(),
  kind          text not null,
  http_status   integer,
  order_id      text,
  position_id   text,
  qty           numeric,
  price         numeric,
  latency_ms    integer,
  ok            boolean,
  uncertain     boolean not null default false,
  error         text,
  payload       jsonb
);
create index if not exists rapid_bevents_intent on public.rapid_broker_events (intent_id, at);
create index if not exists rapid_bevents_account on public.rapid_broker_events (account_id, at desc);

-- ---- Owned positions ---------------------------------------------------------------------------------
create table if not exists public.rapid_positions (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references public.rapid_accounts(id) on delete cascade,
  user_id            uuid not null,
  intent_id          uuid references public.rapid_intents(id),
  session_id         uuid references public.rapid_automation_sessions(id),
  broker_position_id text not null,
  broker_strategy_id text,
  side               text not null check (side in ('buy','sell')),
  -- Pinned at fill. A later settings change applies to the NEXT trade, not this one.
  strategy_version   text not null,
  config_version     text not null,
  management_version text not null,
  management_enabled boolean not null,
  risk_pct           numeric not null,
  entry              numeric not null,
  original_qty       numeric not null,
  current_qty        numeric not null,
  initial_stop       numeric not null,
  current_stop       numeric,
  target             numeric,
  atr_at_fill        numeric,
  cost_price         numeric not null default 0,
  protected_swing    numeric,
  -- Protection is only "achieved" once the broker has acknowledged it.
  protection_state   text not null default 'pending' check (protection_state in ('pending','protected','unconfirmed','removed')),
  protection_attempts smallint not null default 0,
  breakeven_done     boolean not null default false,
  breakeven_at       timestamptz,
  partial_done       boolean not null default false,
  partial_at         timestamptz,
  best_price         numeric,
  worst_price        numeric,
  opened_at          timestamptz not null default now(),
  status             text not null default 'open' check (status in ('open','closing','closed','orphan_review')),
  closed_at          timestamptz,
  close_reason       text,
  exit_price         numeric,
  realised_pnl       numeric,
  result_price_move  numeric,
  updated_at         timestamptz not null default now(),
  unique (account_id, broker_position_id)
);
create index if not exists rapid_pos_open on public.rapid_positions (account_id) where status in ('open','closing');
create index if not exists rapid_pos_user on public.rapid_positions (user_id, opened_at desc);

create table if not exists public.rapid_position_actions (
  id           bigserial primary key,
  position_id  uuid not null references public.rapid_positions(id) on delete cascade,
  at           timestamptz not null default now(),
  action       text not null check (action in ('breakeven','partial','trail','exit','target_hit','stop_hit','manual_close','emergency_close','reconcile')),
  requested    jsonb,
  acknowledged boolean not null default false,
  ack_at       timestamptz,
  reason       text not null,
  error        text
);
create index if not exists rapid_pos_actions on public.rapid_position_actions (position_id, at);

-- ---- Durable partial-close guard ------------------------------------------------------------------------
create table if not exists public.rapid_partial_operations (
  environment   text not null,
  account_id    text not null,
  position_id   text not null,
  before_qty    numeric not null,
  requested_qty numeric not null,
  state         text not null default 'pending' check (state in ('pending','confirmed','abandoned')),
  created_at    timestamptz not null default now(),
  settled_at    timestamptz,
  primary key (environment, account_id, position_id)
);

-- ---- Execution leases, with fencing -----------------------------------------------------------------------
-- A lease is per ACCOUNT, not per process: two workers may both be alive, but only one may command a
-- given account. `fence` increases on every acquisition, and every write carries the fence it was
-- made under, so an old owner that wakes up late cannot issue a command that still lands.
create table if not exists public.rapid_leases (
  account_id  uuid primary key references public.rapid_accounts(id) on delete cascade,
  owner       text not null,
  fence       bigint not null default 1,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- ---- Health, incidents and the decision journal ---------------------------------------------------------
create table if not exists public.rapid_health_events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  component  text not null,
  state      text not null check (state in ('ok','degraded','blocked')),
  account_id uuid,
  detail     jsonb
);
create index if not exists rapid_health_recent on public.rapid_health_events (component, at desc);

create table if not exists public.rapid_heartbeat (
  component text primary key,
  at        timestamptz not null default now(),
  info      jsonb
);

-- Append-only. No update or delete policy exists for it, by design.
create table if not exists public.rapid_journal (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  account_id   uuid,
  user_id      uuid,
  visit_id     text,
  intent_id    uuid,
  snapshot_id  text,
  stage        text not null,
  code         text not null,
  decision     text not null,
  reason       text not null,
  evidence     jsonb not null default '{}'
);
create index if not exists rapid_journal_account on public.rapid_journal (account_id, at desc);
create index if not exists rapid_journal_code on public.rapid_journal (code, at desc);

-- =================================================================================================
-- Row level security.
-- Members read their own rows. Nothing is member-writable: every write is service-role or a route
-- that has already verified ownership server-side.
-- =================================================================================================
alter table public.rapid_config_versions     enable row level security;
alter table public.rapid_control             enable row level security;
alter table public.rapid_control_events      enable row level security;
alter table public.rapid_broker_connections  enable row level security;
alter table public.rapid_accounts            enable row level security;
alter table public.rapid_zone_versions       enable row level security;
alter table public.rapid_snapshots           enable row level security;
alter table public.rapid_setup_visits        enable row level security;
alter table public.rapid_visit_transitions   enable row level security;
alter table public.rapid_automation_sessions enable row level security;
alter table public.rapid_risk_reservations   enable row level security;
alter table public.rapid_intents             enable row level security;
alter table public.rapid_broker_events       enable row level security;
alter table public.rapid_positions           enable row level security;
alter table public.rapid_position_actions    enable row level security;
alter table public.rapid_partial_operations  enable row level security;
alter table public.rapid_leases              enable row level security;
alter table public.rapid_health_events       enable row level security;
alter table public.rapid_heartbeat           enable row level security;
alter table public.rapid_journal             enable row level security;

-- Owner-scoped reads.
drop policy if exists rapid_accounts_select on public.rapid_accounts;
create policy rapid_accounts_select on public.rapid_accounts for select using (auth.uid() = user_id);

drop policy if exists rapid_intents_select on public.rapid_intents;
create policy rapid_intents_select on public.rapid_intents for select
  using (exists (select 1 from public.rapid_accounts a where a.id = account_id and a.user_id = auth.uid()));

drop policy if exists rapid_positions_select on public.rapid_positions;
create policy rapid_positions_select on public.rapid_positions for select
  using (exists (select 1 from public.rapid_accounts a where a.id = account_id and a.user_id = auth.uid()));

drop policy if exists rapid_position_actions_select on public.rapid_position_actions;
create policy rapid_position_actions_select on public.rapid_position_actions for select
  using (exists (select 1 from public.rapid_positions p join public.rapid_accounts a on a.id = p.account_id
                 where p.id = position_id and a.user_id = auth.uid()));

drop policy if exists rapid_autosess_select on public.rapid_automation_sessions;
create policy rapid_autosess_select on public.rapid_automation_sessions for select
  using (exists (select 1 from public.rapid_accounts a where a.id = account_id and a.user_id = auth.uid()));

drop policy if exists rapid_journal_select on public.rapid_journal;
create policy rapid_journal_select on public.rapid_journal for select
  using (account_id is not null and exists (select 1 from public.rapid_accounts a where a.id = account_id and a.user_id = auth.uid()));

drop policy if exists rapid_broker_events_select on public.rapid_broker_events;
create policy rapid_broker_events_select on public.rapid_broker_events for select
  using (exists (select 1 from public.rapid_accounts a where a.id = account_id and a.user_id = auth.uid()));

-- Public-but-read-only reference data: the level map and the analysis are not user-specific.
drop policy if exists rapid_zones_select on public.rapid_zone_versions;
create policy rapid_zones_select on public.rapid_zone_versions for select using (auth.uid() is not null);

drop policy if exists rapid_snapshots_select on public.rapid_snapshots;
create policy rapid_snapshots_select on public.rapid_snapshots for select using (auth.uid() is not null);

drop policy if exists rapid_setups_select on public.rapid_setup_visits;
create policy rapid_setups_select on public.rapid_setup_visits for select using (auth.uid() is not null);

drop policy if exists rapid_control_select on public.rapid_control;
create policy rapid_control_select on public.rapid_control for select using (auth.uid() is not null);

-- rapid_broker_connections, rapid_leases, rapid_risk_reservations, rapid_partial_operations,
-- rapid_health_events, rapid_heartbeat, rapid_config_versions, rapid_control_events and
-- rapid_visit_transitions deliberately have NO policies: RLS is on and nothing but the service role
-- can reach them. Encrypted credentials are not readable even by the member who created them.

-- Realtime for the two surfaces the UI subscribes to, still under RLS.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.rapid_positions'; exception when duplicate_object then null; end;
    begin execute 'alter publication supabase_realtime add table public.rapid_intents'; exception when duplicate_object then null; end;
  end if;
end $$;

-- =================================================================================================
-- Lease acquisition with fencing tokens.
--
-- Two workers may both be alive and both believe they own an account. The lease makes exactly one of
-- them right, and the fence makes the loser's late writes harmless: every command carries the fence
-- it was issued under, and a command whose fence is behind the current one is refused. A TTL alone
-- cannot do this, because a process that stalls past its TTL and then wakes up still has a token it
-- thinks is valid.
-- =================================================================================================
create or replace function public.rapid_acquire_lease(p_account uuid, p_owner text, p_ttl_ms integer)
returns table (fence bigint, acquired boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fence bigint;
begin
  -- Take it if it is free, expired, or already ours. Bump the fence on a genuine handover.
  insert into public.rapid_leases as l (account_id, owner, fence, acquired_at, expires_at)
  values (p_account, p_owner, 1, now(), now() + make_interval(secs => p_ttl_ms / 1000.0))
  on conflict (account_id) do update
    set owner = excluded.owner,
        fence = case when l.owner = excluded.owner then l.fence else l.fence + 1 end,
        acquired_at = case when l.owner = excluded.owner then l.acquired_at else now() end,
        expires_at = excluded.expires_at
    where l.expires_at < now() or l.owner = excluded.owner
  returning l.fence into v_fence;

  -- RETURN QUERY appends rows and CARRIES ON. Every one of these needs its own RETURN, or the
  -- refusal path falls through into the success path and does the thing it just refused to do.
  if v_fence is null then
    select l2.fence into v_fence from public.rapid_leases l2 where l2.account_id = p_account;
    return query select coalesce(v_fence, 0::bigint), false;
    return;
  end if;
  return query select v_fence, true;
  return;
end;
$$;

-- Extend only while we still own it. FALSE means somebody else does — stop immediately.
create or replace function public.rapid_extend_lease(p_account uuid, p_owner text, p_fence bigint, p_ttl_ms integer)
returns boolean
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.rapid_leases
       set expires_at = now() + make_interval(secs => p_ttl_ms / 1000.0)
     where account_id = p_account and owner = p_owner and fence = p_fence
    returning 1
  )
  select exists (select 1 from upd);
$$;

create or replace function public.rapid_release_lease(p_account uuid, p_owner text, p_fence bigint)
returns boolean
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.rapid_leases set expires_at = now()
     where account_id = p_account and owner = p_owner and fence = p_fence
    returning 1
  )
  select exists (select 1 from upd);
$$;

revoke all on function public.rapid_acquire_lease(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.rapid_extend_lease(uuid, text, bigint, integer) from public, anon, authenticated;
revoke all on function public.rapid_release_lease(uuid, text, bigint) from public, anon, authenticated;

-- =================================================================================================
-- Reserve risk and create the order intent in ONE transaction.
--
-- Reserving after submitting, or submitting after reserving in a separate round trip, both leave a
-- window in which the account's true exposure is unknown. The unique index on intent_key makes a
-- duplicate economic visit impossible; the partial unique index on account_id enforces the
-- one-open-position policy in the database rather than in whichever worker happens to be running.
-- =================================================================================================
create or replace function public.rapid_reserve_intent(
  p_intent_key text, p_account uuid, p_user uuid, p_session uuid, p_visit text, p_setup text,
  p_snapshot text, p_strategy text, p_config text, p_management text, p_family text, p_side text,
  p_entry numeric, p_stop numeric, p_target numeric, p_qty numeric, p_risk_pct numeric,
  p_estimated_risk numeric, p_bid numeric, p_ask numeric, p_quote_age_ms integer, p_spread numeric,
  p_automation_version bigint, p_fence bigint, p_broker_strategy_id text
)
returns table (intent_id uuid, created boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_existing uuid;
begin
  select id into v_existing from public.rapid_intents where intent_key = p_intent_key;
  -- Each guard RETURNS. See the note in rapid_acquire_lease: a bare RETURN QUERY does not exit.
  if v_existing is not null then
    return query select v_existing, false, 'intent already exists for this economic visit'::text;
    return;
  end if;

  -- The lease fence must still be current, or this worker no longer owns the account.
  if not exists (select 1 from public.rapid_leases where account_id = p_account and fence = p_fence and expires_at > now()) then
    return query select null::uuid, false, 'stale lease: this worker no longer owns the account'::text;
    return;
  end if;

  -- The toggle must not have been turned off since the decision was made.
  if not exists (select 1 from public.rapid_accounts
                  where id = p_account and automation_enabled and automation_version = p_automation_version) then
    return query select null::uuid, false, 'automation was switched off or changed after this decision'::text;
    return;
  end if;

  begin
    insert into public.rapid_intents (
      intent_key, account_id, user_id, session_id, visit_id, setup_id, snapshot_id,
      strategy_version, config_version, management_version, family, side, state,
      planned_entry, planned_stop, planned_target, qty, risk_pct, estimated_risk,
      quote_bid, quote_ask, quote_age_ms, spread, automation_version, fence, broker_strategy_id)
    values (
      p_intent_key, p_account, p_user, p_session, p_visit, p_setup, p_snapshot,
      p_strategy, p_config, p_management, p_family, p_side, 'reserved',
      p_entry, p_stop, p_target, p_qty, p_risk_pct, p_estimated_risk,
      p_bid, p_ask, p_quote_age_ms, p_spread, p_automation_version, p_fence, p_broker_strategy_id)
    returning id into v_id;
  exception
    when unique_violation then
      return query select null::uuid, false, 'this account already has a live Rapid intent'::text;
      return;
  end;

  insert into public.rapid_risk_reservations (account_id, visit_id, intent_key, amount)
  values (p_account, p_visit, p_intent_key, coalesce(p_estimated_risk, 0));

  return query select v_id, true, 'reserved'::text;
  return;
end;
$$;

revoke all on function public.rapid_reserve_intent(text, uuid, uuid, uuid, text, text, text, text, text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, integer, numeric, bigint, bigint, text) from public, anon, authenticated;
