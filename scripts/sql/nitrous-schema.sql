-- Reviewed Nitrous schema proposal. Apply only to the verified One Mission project.
-- Isolated from all rapid_* / flow_* tables. No existing account is copied or armed.
-- Control starts off and paused; the deployment owner can release infrastructure separately.

-- =================================================================================================
-- NITROUS (nitrous_v1) — durable state for the XAUUSD Nitrous analysis and execution feature.
--
-- Everything Nitrous owns is prefixed nitrous_. Nothing here alters a FLOW, GENX, Command Center,
-- Matty Pips or AURIC table. Every table has RLS enabled and no client access. Members use server
-- routes that verify account ownership. Every write is service-role worker or authenticated route.
-- Credential storage is deny-all even to its owner.
--
-- The design rule behind the schema: a decision is a ROW, written at the time it is made, carrying
-- the source quote, the level version, the structural references, the costs and the reason. Nothing
-- is recomputed later to explain what happened.
-- =================================================================================================

-- ---- Strategy and configuration versions --------------------------------------------------------
create table if not exists public.nitrous_config_versions (
  config_version  text primary key,
  strategy_version text not null,
  management_version text not null,
  config          jsonb not null,
  notes           text,
  created_at      timestamptz not null default now(),
  created_by      text
);

-- ---- Global control. One row. The kill switch and the feature flag live here. --------------------
create table if not exists public.nitrous_control (
  id                smallint primary key default 1 check (id = 1),
  mode              text not null default 'off' check (mode in ('off','analyze_only','live')),
  strategy_version  text not null default 'nitrous_v1',
  config_version    text not null default 'nitrous_v1.cfg.1',
  -- When true no new entries are submitted anywhere. Protection and management keep running.
  entries_paused    boolean not null default true,
  pause_reason      text,
  note              text,
  updated_by        text,
  updated_at        timestamptz not null default now()
);
insert into public.nitrous_control (id) values (1) on conflict (id) do nothing;

create table if not exists public.nitrous_control_events (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  old_mode      text,
  new_mode      text,
  entries_paused boolean,
  reason        text,
  updated_by    text
);

-- ---- Broker connections and accounts -------------------------------------------------------------
-- Refresh tokens are encrypted with a key held outside the database. Access tokens are service-only.
-- Passwords are never stored by this release; an expired refresh session requires member reconnection.
create table if not exists public.nitrous_broker_connections (
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
create index if not exists nitrous_conn_user on public.nitrous_broker_connections (user_id, updated_at desc);

create table if not exists public.nitrous_accounts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  connection_id      uuid not null references public.nitrous_broker_connections(id) on delete cascade,
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
  profile            text not null default 'slow_drip' check (profile in ('slow_drip','nitrous')),
  consent_version    text,
  consented_at       timestamptz,
  balance_at         timestamptz,
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
  -- Worker-only execution checks persist separately from broker preparation checks.
  execution_block_reason text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (connection_id, broker_account_id)
);
-- One Nitrous owner per physical broker account, across all app users.
create unique index if not exists nitrous_accounts_physical
  on public.nitrous_accounts (environment, server, broker_account_id);
create index if not exists nitrous_accounts_user on public.nitrous_accounts (user_id);
create index if not exists nitrous_accounts_armed on public.nitrous_accounts (automation_enabled) where automation_enabled;

-- ---- Level versions -------------------------------------------------------------------------------
create table if not exists public.nitrous_zone_versions (
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
create index if not exists nitrous_zone_parent on public.nitrous_zone_versions (parent_id, known_at desc);

-- ---- Analysis snapshots ----------------------------------------------------------------------------
create table if not exists public.nitrous_snapshots (
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
create index if not exists nitrous_snap_time on public.nitrous_snapshots (generated_at desc);

-- ---- Setups and visits -------------------------------------------------------------------------------
create table if not exists public.nitrous_setup_visits (
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
create index if not exists nitrous_visit_key on public.nitrous_setup_visits (visit_key, state);
create index if not exists nitrous_visit_open on public.nitrous_setup_visits (state) where state not in ('consumed','invalidated','expired');

create table if not exists public.nitrous_visit_transitions (
  id         bigserial primary key,
  visit_id   text not null references public.nitrous_setup_visits(visit_id) on delete cascade,
  from_state text not null,
  to_state   text not null,
  at         timestamptz not null,
  reason     text not null,
  evidence   jsonb not null default '{}'
);
create index if not exists nitrous_transitions_visit on public.nitrous_visit_transitions (visit_id, at);

-- ---- Automation sessions ---------------------------------------------------------------------------
-- One row per continuous period during which an account was armed. Ending one is how "Automation
-- OFF" becomes auditable rather than just a boolean that changed at some point.
create table if not exists public.nitrous_automation_sessions (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.nitrous_accounts(id) on delete cascade,
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
create index if not exists nitrous_autosess_open on public.nitrous_automation_sessions (account_id) where ended_at is null;

-- A day budget survives pause/rearm and reconnect. The worker only lowers max_loss_pct during a day.
create table if not exists public.nitrous_risk_days (
  account_id uuid not null references public.nitrous_accounts(id) on delete cascade,
  day date not null,
  start_equity numeric not null check (start_equity>0),
  max_loss_pct numeric not null check (max_loss_pct>0 and max_loss_pct<=15),
  created_at timestamptz not null default now(),
  primary key(account_id,day)
);
alter table public.nitrous_risk_days enable row level security;

-- ---- Risk reservations -------------------------------------------------------------------------------
-- Reserved BEFORE an order is sent, released or converted after the outcome is known. This is what
-- makes "how much is this account risking right now" answerable while an order is in flight.
create table if not exists public.nitrous_risk_reservations (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.nitrous_accounts(id) on delete cascade,
  visit_id      text not null,
  intent_key    text not null,
  amount        numeric not null check (amount >= 0),
  currency      text,
  state         text not null default 'held' check (state in ('held','converted','released')),
  created_at    timestamptz not null default now(),
  settled_at    timestamptz,
  unique (intent_key)
);
create index if not exists nitrous_resv_held on public.nitrous_risk_reservations (account_id) where state = 'held';

-- ---- Order intents --------------------------------------------------------------------------------
-- `intent_key` is the durable idempotency key: account + strategy version + economic setup + visit.
-- A unique constraint cannot guarantee exactly-once EXTERNAL execution, so `submission_unknown` is a
-- first-class state and reconciliation, not a retry, is what resolves it.
create table if not exists public.nitrous_intents (
  id                uuid primary key default gen_random_uuid(),
  intent_key        text not null unique,
  account_id        uuid not null references public.nitrous_accounts(id) on delete cascade,
  user_id           uuid not null,
  session_id        uuid references public.nitrous_automation_sessions(id),
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
create index if not exists nitrous_intent_account on public.nitrous_intents (account_id, created_at desc);
create index if not exists nitrous_intent_live on public.nitrous_intents (state)
  where state in ('reserved','submitting','acknowledged','partially_filled','protection_pending','submission_unknown','cancel_requested');
-- One live intent per account at a time. The concurrency policy, enforced by the database.
create unique index if not exists nitrous_intent_one_live_per_account on public.nitrous_intents (account_id)
  where state in ('reserved','submitting','acknowledged','partially_filled','filled','protection_pending','protected','cancel_requested','submission_unknown');

-- ---- Broker order and fill mapping -------------------------------------------------------------------
create table if not exists public.nitrous_broker_events (
  id            bigserial primary key,
  intent_id     uuid references public.nitrous_intents(id) on delete cascade,
  account_id    uuid not null references public.nitrous_accounts(id) on delete cascade,
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
create index if not exists nitrous_bevents_intent on public.nitrous_broker_events (intent_id, at);
create index if not exists nitrous_bevents_account on public.nitrous_broker_events (account_id, at desc);

-- ---- Owned positions ---------------------------------------------------------------------------------
create table if not exists public.nitrous_positions (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references public.nitrous_accounts(id) on delete cascade,
  user_id            uuid not null,
  intent_id          uuid references public.nitrous_intents(id),
  session_id         uuid references public.nitrous_automation_sessions(id),
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
  realised_pnl_source text not null default 'unknown' check (realised_pnl_source in ('broker_net','calculated_gross','unknown')),
  fees_verified       boolean not null default false,
  close_requested_at  timestamptz,
  close_dispatched_at timestamptz,
  close_request_state text check (close_request_state in ('requested','dispatching','acknowledged','uncertain','rejected')),
  close_request_error text,
  result_price_move  numeric,
  updated_at         timestamptz not null default now(),
  unique (account_id, broker_position_id)
);
create index if not exists nitrous_pos_open on public.nitrous_positions (account_id) where status in ('open','closing');
create index if not exists nitrous_pos_user on public.nitrous_positions (user_id, opened_at desc);

create table if not exists public.nitrous_position_actions (
  id           bigserial primary key,
  position_id  uuid not null references public.nitrous_positions(id) on delete cascade,
  at           timestamptz not null default now(),
  action       text not null check (action in ('breakeven','partial','trail','exit','target_hit','stop_hit','manual_close','emergency_close','reconcile')),
  requested    jsonb,
  acknowledged boolean not null default false,
  ack_at       timestamptz,
  reason       text not null,
  error        text
);
create index if not exists nitrous_pos_actions on public.nitrous_position_actions (position_id, at);

-- ---- Durable partial-close guard ------------------------------------------------------------------------
create table if not exists public.nitrous_partial_operations (
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
create table if not exists public.nitrous_leases (
  account_id  uuid primary key references public.nitrous_accounts(id) on delete cascade,
  owner       text not null,
  fence       bigint not null default 1,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- ---- Health, incidents and the decision journal ---------------------------------------------------------
create table if not exists public.nitrous_health_events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  component  text not null,
  state      text not null check (state in ('ok','degraded','blocked')),
  account_id uuid,
  detail     jsonb
);
create index if not exists nitrous_health_recent on public.nitrous_health_events (component, at desc);

create table if not exists public.nitrous_heartbeat (
  component text primary key,
  at        timestamptz not null default now(),
  info      jsonb
);

-- Append-only. No update or delete policy exists for it, by design.
create table if not exists public.nitrous_journal (
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
create index if not exists nitrous_journal_account on public.nitrous_journal (account_id, at desc);
create index if not exists nitrous_journal_code on public.nitrous_journal (code, at desc);

-- =================================================================================================
-- Row level security.
-- No direct client reads or writes. Server routes verify ownership before returning safe fields.
-- =================================================================================================
alter table public.nitrous_config_versions     enable row level security;
alter table public.nitrous_control             enable row level security;
alter table public.nitrous_control_events      enable row level security;
alter table public.nitrous_broker_connections  enable row level security;
alter table public.nitrous_accounts            enable row level security;
alter table public.nitrous_zone_versions       enable row level security;
alter table public.nitrous_snapshots           enable row level security;
alter table public.nitrous_setup_visits        enable row level security;
alter table public.nitrous_visit_transitions   enable row level security;
alter table public.nitrous_automation_sessions enable row level security;
alter table public.nitrous_risk_reservations   enable row level security;
alter table public.nitrous_intents             enable row level security;
alter table public.nitrous_broker_events       enable row level security;
alter table public.nitrous_positions           enable row level security;
alter table public.nitrous_position_actions    enable row level security;
alter table public.nitrous_partial_operations  enable row level security;
alter table public.nitrous_leases              enable row level security;
alter table public.nitrous_health_events       enable row level security;
alter table public.nitrous_heartbeat           enable row level security;
alter table public.nitrous_journal             enable row level security;

-- Every browser request uses an authenticated server endpoint. No direct client access is granted.
-- Credential tables have no policies; account arming cannot bypass the server's consent checks.

-- =================================================================================================
-- Lease acquisition with fencing tokens.
--
-- Two workers may both be alive and both believe they own an account. The lease makes exactly one of
-- them right, and the fence makes the loser's late writes harmless: every command carries the fence
-- it was issued under, and a command whose fence is behind the current one is refused. A TTL alone
-- cannot do this, because a process that stalls past its TTL and then wakes up still has a token it
-- thinks is valid.
-- =================================================================================================
create or replace function public.nitrous_acquire_lease(p_account uuid, p_owner text, p_ttl_ms integer)
returns table (fence bigint, acquired boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fence bigint;
begin
  -- Take it if it is free, expired, or already ours. Bump the fence on a genuine handover.
  insert into public.nitrous_leases as l (account_id, owner, fence, acquired_at, expires_at)
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
    select l2.fence into v_fence from public.nitrous_leases l2 where l2.account_id = p_account;
    return query select coalesce(v_fence, 0::bigint), false;
    return;
  end if;
  return query select v_fence, true;
  return;
end;
$$;

-- Extend only while we still own it. FALSE means somebody else does — stop immediately.
create or replace function public.nitrous_extend_lease(p_account uuid, p_owner text, p_fence bigint, p_ttl_ms integer)
returns boolean
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.nitrous_leases
       set expires_at = now() + make_interval(secs => p_ttl_ms / 1000.0)
     where account_id = p_account and owner = p_owner and fence = p_fence and expires_at > now()
    returning 1
  )
  select exists (select 1 from upd);
$$;

create or replace function public.nitrous_release_lease(p_account uuid, p_owner text, p_fence bigint)
returns boolean
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.nitrous_leases set expires_at = now()
     where account_id = p_account and owner = p_owner and fence = p_fence
    returning 1
  )
  select exists (select 1 from upd);
$$;

revoke all on function public.nitrous_acquire_lease(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.nitrous_extend_lease(uuid, text, bigint, integer) from public, anon, authenticated;
revoke all on function public.nitrous_release_lease(uuid, text, bigint) from public, anon, authenticated;

-- =================================================================================================
-- Reserve risk and create the order intent in ONE transaction.
--
-- Reserving after submitting, or submitting after reserving in a separate round trip, both leave a
-- window in which the account's true exposure is unknown. The unique index on intent_key makes a
-- duplicate economic visit impossible; the partial unique index on account_id enforces the
-- one-open-position policy in the database rather than in whichever worker happens to be running.
-- =================================================================================================
create or replace function public.nitrous_reserve_intent(
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
  v_account public.nitrous_accounts%rowtype;
  v_day public.nitrous_risk_days%rowtype;
  v_losses numeric;
  v_remaining numeric;
begin
  select id into v_existing from public.nitrous_intents where intent_key = p_intent_key;
  -- Each guard RETURNS. See the note in nitrous_acquire_lease: a bare RETURN QUERY does not exit.
  if v_existing is not null then
    return query select v_existing, false, 'intent already exists for this economic visit'::text;
    return;
  end if;

  -- The lease fence must still be current, or this worker no longer owns the account.
  if not exists (select 1 from public.nitrous_leases where account_id = p_account and fence = p_fence and expires_at > now()) then
    return query select null::uuid, false, 'stale lease: this worker no longer owns the account'::text;
    return;
  end if;

  -- A member settings write and a reservation serialize on the account row.
  select * into v_account from public.nitrous_accounts where id=p_account and user_id=p_user for update;
  if not found or not v_account.automation_enabled or v_account.automation_version<>p_automation_version
    or v_account.status<>'linked' or v_account.consent_version is distinct from 'nitrous-consent-v1'
    or v_account.consented_at is null then
    return query select null::uuid, false, 'automation or account permission changed after this decision'::text;
    return;
  end if;
  if not exists (select 1 from public.nitrous_control where id=1 and mode='live' and entries_paused=false) then
    return query select null::uuid, false, 'new entries are paused'::text;
    return;
  end if;
  if v_account.risk_pct is distinct from p_risk_pct
     or not ((v_account.profile='slow_drip' and p_risk_pct in (0.5,1)) or (v_account.profile='nitrous' and p_risk_pct in (3,5))) then
    return query select null::uuid, false, 'risk profile changed or is invalid'::text;
    return;
  end if;
  if v_account.equity is null or v_account.equity<=0 or v_account.equity_at is null
     or v_account.equity_at<now()-interval '120 seconds'
     or p_estimated_risk is null or p_estimated_risk<=0
     or p_estimated_risk>v_account.equity*p_risk_pct/100 then
    return query select null::uuid, false, 'fresh equity and an in-budget risk amount are required'::text;
    return;
  end if;
  if exists(select 1 from public.nitrous_positions where account_id=p_account and status<>'closed') then
    return query select null::uuid, false, 'an open position must settle before another entry'::text;
    return;
  end if;
  if exists(select 1 from public.nitrous_intents where account_id=p_account and state not in ('closed','cancelled','rejected')) then
    return query select null::uuid, false, 'an earlier intent must reconcile before another entry'::text;
    return;
  end if;
  -- The daily budget cannot be reset by toggling automation or changing mode.
  select * into v_day from public.nitrous_risk_days
    where account_id=p_account and day=(now() at time zone 'UTC')::date for update;
  if not found or exists(select 1 from public.nitrous_positions where account_id=p_account and status='closed'
    and (realised_pnl is null or realised_pnl_source='unknown')) then
    return query select null::uuid, false, 'the daily budget or a closed outcome needs reconciliation'::text;
    return;
  end if;
  select coalesce(sum(greatest(-realised_pnl,0)),0) into v_losses from public.nitrous_positions
    where account_id=p_account and status='closed' and closed_at >= (((now() at time zone 'UTC')::date)::timestamp at time zone 'UTC');
  v_remaining := greatest(0,v_day.start_equity*least(v_day.max_loss_pct,
    case when v_account.profile='slow_drip' then 3 else 15 end)/100-greatest(v_losses,v_day.start_equity-v_account.equity));
  if p_estimated_risk>v_remaining then
    return query select null::uuid, false, 'this entry exceeds the remaining daily loss allowance'::text;
    return;
  end if;

  begin
    insert into public.nitrous_intents (
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
      return query select null::uuid, false, 'this account already has a live Nitrous intent'::text;
      return;
  end;

  insert into public.nitrous_risk_reservations (account_id, visit_id, intent_key, amount)
  values (p_account, p_visit, p_intent_key, coalesce(p_estimated_risk, 0));

  return query select v_id, true, 'reserved'::text;
  return;
end;
$$;

revoke all on function public.nitrous_reserve_intent(text, uuid, uuid, uuid, text, text, text, text, text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, integer, numeric, bigint, bigint, text) from public, anon, authenticated;

-- Account results are aggregated in PostgreSQL, avoiding REST row-limit truncation.
create or replace function public.nitrous_account_stats(p_user uuid)
returns table(account_id uuid, wins bigint, losses bigint, flat bigint, closed bigint,
  unresolved bigint, net_pnl numeric, recorded_pnl numeric, gross_pnl numeric,
  winning_pnl numeric, verified_closed bigint, pnl_verified boolean)
language sql stable security invoker set search_path = public
as $$
  select a.id,
    count(p.id) filter (where p.realised_pnl > 0 and p.realised_pnl_source<>'unknown'),
    count(p.id) filter (where p.realised_pnl < 0 and p.realised_pnl_source<>'unknown'),
    count(p.id) filter (where p.realised_pnl = 0 and p.realised_pnl_source<>'unknown'),
    count(p.id),
    count(p.id) filter (where p.realised_pnl is null or p.realised_pnl_source='unknown'),
    case when count(p.id)>0 and count(p.id)=count(p.id) filter(where p.realised_pnl is not null and p.realised_pnl_source='broker_net' and p.fees_verified)
      then sum(p.realised_pnl) else null end,
    sum(p.realised_pnl) filter(where p.realised_pnl_source<>'unknown'),
    sum(p.realised_pnl) filter(where p.realised_pnl_source='calculated_gross'),
    case when count(p.realised_pnl) filter(where p.realised_pnl_source<>'unknown')>0
      then coalesce(sum(p.realised_pnl) filter(where p.realised_pnl>0 and p.realised_pnl_source<>'unknown'),0) else null end,
    count(p.id) filter(where p.realised_pnl is not null and p.realised_pnl_source='broker_net' and p.fees_verified),
    count(p.id)>0 and count(p.id)=count(p.id) filter(where p.realised_pnl is not null and p.realised_pnl_source='broker_net' and p.fees_verified)
  from public.nitrous_accounts a
  left join public.nitrous_positions p on p.account_id=a.id and p.status='closed'
  where a.user_id=p_user
  group by a.id;
$$;

create or replace function public.nitrous_request_close(p_user uuid,p_account uuid,p_position uuid,p_broker_position text,p_strategy text)
returns table(queued boolean)
language plpgsql security invoker set search_path=public
as $$
declare p public.nitrous_positions%rowtype;
begin
  select pos.* into p from public.nitrous_positions pos
  join public.nitrous_accounts a on a.id=pos.account_id
  where pos.id=p_position and pos.account_id=p_account and pos.user_id=p_user and a.user_id=p_user
  for update of pos;
  if not found or p.status not in ('open','closing') or p.broker_position_id is distinct from p_broker_position
     or p.broker_strategy_id is distinct from p_strategy or p_strategy is null
     or length(p_strategy)<=8 or p_strategy not like 'NITROUS:%' then
    return query select false; return;
  end if;
  -- Unknown dispatch outcomes must reconcile, never trigger a blind retry.
  -- Only an explicit later member request can retry a known rejected close.
  if p.close_requested_at is null or p.close_request_state='rejected' then
    update public.nitrous_positions set close_requested_at=now(),close_dispatched_at=null,
      close_request_state='requested',close_request_error=null,updated_at=now() where id=p.id;
    insert into public.nitrous_journal(account_id,user_id,stage,code,decision,reason,evidence)
    values(p_account,p_user,'manual','close_requested','queued','member requested a position close',jsonb_build_object('positionId',p.id));
  end if;
  return query select true;
end;
$$;

-- Atomic optimistic settings update. Only the authenticated server may call this function.
create or replace function public.nitrous_apply_settings(p_user uuid, p_account uuid, p_expected_version bigint, p_patch jsonb)
returns table(applied boolean, automation_enabled boolean, automation_version bigint)
language plpgsql security invoker set search_path=public
as $$
declare
  a public.nitrous_accounts%rowtype;
  v_profile text;
  v_risk numeric;
  v_enabled boolean;
begin
  select * into a from public.nitrous_accounts where id=p_account and user_id=p_user for update;
  if not found or a.automation_version <> p_expected_version then
    return query select false, false, 0::bigint; return;
  end if;
  v_profile := coalesce(p_patch->>'profile',a.profile);
  v_risk := coalesce((p_patch->>'risk_pct')::numeric,a.risk_pct);
  v_enabled := coalesce((p_patch->>'automation_enabled')::boolean,a.automation_enabled);
  if not (coalesce((p_patch->>'automation_enabled')::boolean=false,false) and not (p_patch ? 'profile') and not (p_patch ? 'risk_pct'))
    and ((v_profile='slow_drip' and v_risk not in (0.5,1))
    or (v_profile='nitrous' and v_risk not in (3,5))
    or v_profile not in ('slow_drip','nitrous')) then
    raise exception 'invalid Nitrous risk profile';
  end if;
  if a.automation_enabled and (v_profile<>a.profile or v_risk<>a.risk_pct) then
    raise exception 'pause before changing profile or risk';
  end if;
  if v_enabled and (not a.automation_enabled) and
     (p_patch->>'consent_version' is distinct from 'nitrous-consent-v1' or p_patch->>'consented_at' is null) then
    raise exception 'explicit current consent required';
  end if;
  update public.nitrous_accounts set
    profile=v_profile, risk_pct=v_risk, automation_enabled=v_enabled,
    automation_enabled_at=case when v_enabled then coalesce(automation_enabled_at,now()) else automation_enabled_at end,
    management_enabled=coalesce((p_patch->>'management_enabled')::boolean,management_enabled),
    automation_version=a.automation_version+1,
    consent_version=coalesce(p_patch->>'consent_version',consent_version),
    consented_at=coalesce((p_patch->>'consented_at')::timestamptz,consented_at),
    updated_at=now()
  where id=a.id;
  insert into public.nitrous_journal(account_id,user_id,stage,code,decision,reason,evidence)
  values(a.id,p_user,'member_settings','settings_changed','applied',
    case when v_enabled then 'member enabled or updated auto trading' else 'member paused or updated account settings' end,
    jsonb_build_object('profile',v_profile,'riskPct',v_risk,'automationEnabled',v_enabled,
      'managementEnabled',coalesce((p_patch->>'management_enabled')::boolean,a.management_enabled),
      'consentVersion',p_patch->>'consent_version','version',a.automation_version+1));
  -- Do not reset the day's loss budget when a member pauses and rearms.
  return query select true,v_enabled,a.automation_version+1;
end;
$$;

create or replace function public.nitrous_disconnect(p_user uuid,p_connection uuid)
returns table(disconnected boolean,reason text)
language plpgsql security invoker set search_path=public
as $$
declare v_count bigint;
begin
  perform 1 from public.nitrous_broker_connections where id=p_connection and user_id=p_user for update;
  if not found then return query select false,'Connection not found.'::text; return; end if;
  perform 1 from public.nitrous_accounts where connection_id=p_connection and user_id=p_user for update;
  select count(*) into v_count from public.nitrous_accounts a
  where a.connection_id=p_connection and a.user_id=p_user and a.automation_enabled;
  if v_count>0 then return query select false,'Pause auto trading before disconnecting.'::text; return; end if;
  select count(*) into v_count from public.nitrous_positions p
  join public.nitrous_accounts a on a.id=p.account_id
  where a.connection_id=p_connection and a.user_id=p_user and p.status<>'closed';
  if v_count>0 then return query select false,'Open positions must settle before disconnecting. Broker protection remains in place.'::text; return; end if;
  select count(*) into v_count from public.nitrous_intents i
  join public.nitrous_accounts a on a.id=i.account_id
  where a.connection_id=p_connection and a.user_id=p_user and i.state not in ('closed','cancelled','rejected');
  if v_count>0 then return query select false,'An order still needs reconciliation before disconnecting.'::text; return; end if;
  update public.nitrous_accounts set automation_enabled=false,automation_version=automation_version+1,status='disabled',updated_at=now()
  where connection_id=p_connection and user_id=p_user;
  update public.nitrous_broker_connections set status='revoked',access_token=null,enc_refresh=null,enc_password=null,updated_at=now()
  where id=p_connection and user_id=p_user;
  insert into public.nitrous_journal(user_id,stage,code,decision,reason)
  values(p_user,'member_settings','connection_disconnected','applied','member disconnected a settled account');
  return query select true,'Disconnected.'::text;
end;
$$;

-- All Nitrous access is through owned-account server routes or the isolated worker.
-- In particular, a client can never arm an account by writing directly through the Data API.
do $$
declare obj record;
begin
  for obj in select tablename from pg_tables where schemaname='public' and tablename like 'nitrous\_%' escape '\' loop
    execute format('revoke all on table public.%I from public,anon,authenticated',obj.tablename);
    execute format('grant all on table public.%I to service_role',obj.tablename);
  end loop;
  for obj in select sequencename from pg_sequences where schemaname='public' and sequencename like 'nitrous\_%' escape '\' loop
    execute format('revoke all on sequence public.%I from public,anon,authenticated',obj.sequencename);
    execute format('grant all on sequence public.%I to service_role',obj.sequencename);
  end loop;
  for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'nitrous\_%' escape '\' loop
    execute format('revoke all on function %s from public,anon,authenticated',obj.signature);
    execute format('grant execute on function %s to service_role',obj.signature);
  end loop;
end $$;
