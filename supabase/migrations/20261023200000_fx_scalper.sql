-- ONE MISSION FX SCALPER (owner 10-23): live M1 scalping on one TradeLocker account (Genesis FX Markets)
-- for EURUSD, USDJPY, AUDUSD, USDCAD, GBPUSD, GBPJPY and EURJPY. Its own tables only; no other tool's
-- table is touched. Server-side only: row level security is on and there are no policies, so only the
-- service role reads or writes. The web routes check that the caller is the site owner before using it;
-- the worker (a separate Railway service) uses it directly.

-- Broker sign-ins. Everything secret is AES-256-GCM encrypted with a key held outside the database
-- (FX_SCALPER_ENC_KEY, falling back to FLOW_ENC_KEY). A database dump alone gives no trading access.
create table if not exists public.fx_scalper_connections (
  id                uuid primary key default gen_random_uuid(),
  created_by        uuid,
  environment       text not null default 'live' check (environment in ('live')),
  server            text not null,
  email_masked      text not null,
  enc_email         text,          -- kept only with "stay connected", for unattended re-sign-in
  enc_password      text,          -- kept only with "stay connected"
  enc_refresh       text not null,
  enc_access        text,
  access_expires_at timestamptz,
  accounts          jsonb not null default '[]'::jsonb,   -- the login's accounts as listed at sign-in (no secrets)
  status            text not null default 'connected' check (status in ('connected', 'reconnect_required', 'revoked')),
  last_error        text,
  last_auth_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- What the bot may do. One row. Orders are possible only while mode = 'live' and entries are not paused,
-- and only from the worker that holds the lease below. A new install starts STOPPED.
create table if not exists public.fx_scalper_control (
  id                     int primary key default 1 check (id = 1),
  mode                   text not null default 'stopped' check (mode in ('stopped', 'live')),
  entries_paused         boolean not null default false,
  pause_reason           text,
  pause_until            timestamptz,
  version                bigint not null default 1,
  connection_id          uuid references public.fx_scalper_connections (id),
  account_id             text,
  acc_num                text,
  account_label          text,
  account_currency       text,
  started_at             timestamptz,
  started_by             uuid,
  start_settings_version bigint,
  stopped_at             timestamptz,
  stop_reason            text,
  -- Set while the worker is closing every bot position (owner close-all, emergency stop, daily loss
  -- limit); cleared when none is left. Kept here so a restart carries on closing.
  close_all_reason       text,
  close_all_at           timestamptz,
  updated_at             timestamptz not null default now(),
  updated_by             uuid
);
insert into public.fx_scalper_control (id) values (1) on conflict (id) do nothing;

-- Strategy, cost and risk settings (validated in code; an empty object means the defaults).
create table if not exists public.fx_scalper_settings (
  id         int primary key default 1 check (id = 1),
  config     jsonb not null default '{}'::jsonb,
  version    bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.fx_scalper_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.fx_scalper_settings_history (
  id         bigint generated always as identity primary key,
  version    bigint not null,
  config     jsonb not null,
  changed_at timestamptz not null default now(),
  changed_by uuid
);

-- One worker commands the account. The fence makes a stalled worker's late writes harmless.
create table if not exists public.fx_scalper_lease (
  id          int primary key default 1 check (id = 1),
  owner       text,
  fence       bigint not null default 0,
  acquired_at timestamptz,
  expires_at  timestamptz not null default '1970-01-01T00:00:00Z'
);
insert into public.fx_scalper_lease (id) values (1) on conflict (id) do nothing;

-- The seven pairs as THIS account names and specifies them (written by the worker after discovery).
create table if not exists public.fx_scalper_instruments (
  pair                   text primary key,
  account_id             text not null,
  acc_num                text not null,
  status                 text not null check (status in ('ready', 'blocked')),
  problem                text,
  broker_symbol          text,
  candidates             text[],
  tradable_instrument_id text,
  trade_route_id         text,
  info_route_id          text,
  lot_size               numeric,
  lot_step               numeric,
  min_lot                numeric,
  max_lot                numeric,
  tick_size              numeric,
  pip_size               numeric,
  price_decimals         int,
  bar_source             text,
  quoting_currency       text,
  base_currency          text,
  leverage               numeric,
  symbol_status          text,
  trade_session_id       text,
  session_status_id      text,
  raw                    jsonb,
  resolved_at            timestamptz not null default now()
);

-- Every entry intent and the trade it became, start to finish. Written BEFORE the order is sent.
--   reserved → sending → acknowledged → open → closing → closed
--   with the side exits rejected / not_filled / not_placed, and uncertain while the broker is asked.
create table if not exists public.fx_scalper_trades (
  id                     uuid primary key default gen_random_uuid(),
  signal_key             text not null unique,      -- one entry intent per signal candle, ever
  tag                    text not null unique,      -- the broker strategyId: identification, not idempotency
  fence                  bigint not null,
  control_version        bigint not null,
  settings_version       bigint not null,
  account_id             text not null,
  acc_num                text not null,
  pair                   text not null,
  broker_symbol          text,
  tradable_instrument_id text not null,
  side                   text not null check (side in ('buy', 'sell')),
  state                  text not null check (state in ('reserved', 'sending', 'acknowledged', 'uncertain', 'rejected', 'not_filled', 'not_placed', 'open', 'closing', 'closed')),
  candle_t               timestamptz not null,
  signal                 jsonb not null default '{}'::jsonb,
  plan                   jsonb not null default '{}'::jsonb,
  qty                    numeric not null,
  planned_entry          numeric not null,
  planned_stop           numeric not null,
  planned_target         numeric not null,
  stop_pips              numeric not null,
  reserved_risk          numeric not null,
  order_id               text,
  position_id            text,
  sent_at                timestamptz,
  ack_at                 timestamptz,
  ack_latency_ms         int,
  filled_qty             numeric,
  fill_price             numeric,
  filled_at              timestamptz,
  stop_price             numeric,
  target_price           numeric,
  protection             text not null default 'pending' check (protection in ('pending', 'verified', 'failed', 'n/a')),
  protection_verified_at timestamptz,
  time_exit_due_at       timestamptz,
  close_requested_at     timestamptz,
  close_reason           text,
  exit_price             numeric,
  closed_at              timestamptz,
  gross_pnl              numeric,
  commission             numeric,
  other_charges          numeric,
  net_pnl                numeric,
  pnl_final              boolean not null default false,
  conversion             jsonb,
  closed_lots            numeric,
  eligible_lots          numeric,
  error                  text,
  notes                  jsonb not null default '[]'::jsonb,
  broker                 jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
-- Re-entry on a pair only after its previous trade is confirmed closed.
create unique index if not exists fx_scalper_trades_one_live_per_pair
  on public.fx_scalper_trades (pair) where state in ('reserved', 'sending', 'acknowledged', 'uncertain', 'open', 'closing');
create index if not exists fx_scalper_trades_state_idx on public.fx_scalper_trades (state);
create index if not exists fx_scalper_trades_created_idx on public.fx_scalper_trades (created_at desc);
create index if not exists fx_scalper_trades_closed_idx on public.fx_scalper_trades (closed_at desc);

-- The FX trading day (17:00 New York to 17:00 New York): the equity the daily loss limit is measured from.
create table if not exists public.fx_scalper_days (
  day                   date primary key,
  starts_at             timestamptz not null,
  start_equity          numeric,
  start_eligible_equity numeric,
  limit_amount          numeric,
  limit_hit_at          timestamptz,
  updated_at            timestamptz not null default now()
);

-- What the worker sees, every couple of seconds, for the dashboard. One row.
create table if not exists public.fx_scalper_status (
  id       int primary key default 1 check (id = 1),
  at       timestamptz,
  worker   text,
  snapshot jsonb not null default '{}'::jsonb
);
insert into public.fx_scalper_status (id) values (1) on conflict (id) do nothing;

-- Append-only journal: signals, skips and why, orders, fills, exits, reconciliation, errors. No secrets.
create table if not exists public.fx_scalper_events (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  level    text not null default 'info' check (level in ('info', 'warn', 'error')),
  kind     text not null,
  pair     text,
  trade_id uuid,
  message  text not null,
  data     jsonb not null default '{}'::jsonb
);
create index if not exists fx_scalper_events_at_idx on public.fx_scalper_events (at desc);

-- Owner commands the worker carries out (close bot positions, emergency stop, close the whole account).
create table if not exists public.fx_scalper_commands (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('close_bot', 'emergency', 'close_account_all')),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  status      text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  -- The lease fence of the worker running it: a command left 'running' by a worker that lost its lease
  -- (crashed, redeployed) is taken over by the next lease holder.
  claimed_fence bigint,
  claimed_at  timestamptz,
  result      jsonb,
  finished_at timestamptz
);
create index if not exists fx_scalper_commands_pending_idx on public.fx_scalper_commands (created_at) where status in ('pending', 'running');

-- Compensation actually reported or paid under the Genesis agreement (statement imports or manual
-- entries). Estimates are computed from the agreement terms in settings, never stored as fact.
create table if not exists public.fx_scalper_compensation (
  id                uuid primary key default gen_random_uuid(),
  period_start      date,
  period_end        date,
  kind              text not null check (kind in ('confirmed', 'paid', 'reversal')),
  amount            numeric not null,
  currency          text not null default 'USD',
  lots              numeric,
  paid_into_account boolean not null default false,
  source            text not null check (source in ('statement_import', 'manual')),
  reference         text,
  note              text,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  created_by        uuid
);

alter table public.fx_scalper_connections      enable row level security;
alter table public.fx_scalper_control          enable row level security;
alter table public.fx_scalper_settings         enable row level security;
alter table public.fx_scalper_settings_history enable row level security;
alter table public.fx_scalper_lease            enable row level security;
alter table public.fx_scalper_instruments      enable row level security;
alter table public.fx_scalper_trades           enable row level security;
alter table public.fx_scalper_days             enable row level security;
alter table public.fx_scalper_status           enable row level security;
alter table public.fx_scalper_events           enable row level security;
alter table public.fx_scalper_commands         enable row level security;
alter table public.fx_scalper_compensation     enable row level security;

revoke all on public.fx_scalper_connections, public.fx_scalper_control, public.fx_scalper_settings,
  public.fx_scalper_settings_history, public.fx_scalper_lease, public.fx_scalper_instruments,
  public.fx_scalper_trades, public.fx_scalper_days, public.fx_scalper_status, public.fx_scalper_events,
  public.fx_scalper_commands, public.fx_scalper_compensation from anon, authenticated;

-- =================================================================================================
-- The lease. Take it if it is free, expired or already ours; bump the fence on a genuine handover.
-- Every guard RETURNS: in plpgsql a bare RETURN QUERY appends a row and keeps going.
-- =================================================================================================
create or replace function public.fx_scalper_acquire_lease(p_owner text, p_ttl_ms integer)
returns table (fence bigint, acquired boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fence bigint;
begin
  update public.fx_scalper_lease l
     set owner       = p_owner,
         fence       = case when l.owner = p_owner then l.fence else l.fence + 1 end,
         acquired_at = case when l.owner = p_owner then l.acquired_at else now() end,
         expires_at  = now() + make_interval(secs => p_ttl_ms / 1000.0)
   where l.id = 1 and (l.expires_at < now() or l.owner = p_owner or l.owner is null)
  returning l.fence into v_fence;
  if v_fence is null then
    select l2.fence into v_fence from public.fx_scalper_lease l2 where l2.id = 1;
    return query select coalesce(v_fence, 0::bigint), false;
    return;
  end if;
  return query select v_fence, true;
  return;
end;
$$;

create or replace function public.fx_scalper_extend_lease(p_owner text, p_fence bigint, p_ttl_ms integer)
returns boolean
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.fx_scalper_lease
       set expires_at = now() + make_interval(secs => p_ttl_ms / 1000.0)
     where id = 1 and owner = p_owner and fence = p_fence and expires_at > now()
    returning 1
  )
  select exists (select 1 from upd);
$$;

create or replace function public.fx_scalper_release_lease(p_owner text, p_fence bigint)
returns boolean
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.fx_scalper_lease set expires_at = now()
     where id = 1 and owner = p_owner and fence = p_fence
    returning 1
  )
  select exists (select 1 from upd);
$$;

-- =================================================================================================
-- Reserve risk and write the entry intent in ONE transaction, before any order exists.
--   · the caller must hold the current lease;
--   · the bot must still be live, entries not paused, no close-all in progress, and the control row
--     unchanged since the decision;
--   · fewer than p_max_live trades in flight or open;
--   · the risk already reserved plus this one within p_max_risk (account currency);
--   · the signal candle has never had an intent (unique signal_key), and the pair has no live trade.
-- =================================================================================================
create or replace function public.fx_scalper_reserve(
  p_owner text, p_fence bigint, p_control_version bigint, p_max_live integer, p_max_risk numeric, p_row jsonb
)
returns table (trade_id uuid, created boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_live integer;
  v_risk numeric;
begin
  perform 1 from public.fx_scalper_lease where id = 1 and owner = p_owner and fence = p_fence and expires_at > now() for share;
  if not found then
    return query select null::uuid, false, 'stale lease: this worker no longer commands the account'::text;
    return;
  end if;
  if not exists (select 1 from public.fx_scalper_control
                  where id = 1 and mode = 'live' and not entries_paused and close_all_reason is null
                    and version = p_control_version) then
    return query select null::uuid, false, 'the bot was stopped, paused, closing all or changed after this decision'::text;
    return;
  end if;
  if exists (select 1 from public.fx_scalper_trades where signal_key = p_row->>'signal_key') then
    return query select null::uuid, false, 'this signal candle already has an entry intent'::text;
    return;
  end if;
  -- Serialise reservations: two concurrent calls cannot both see room for one more.
  perform pg_advisory_xact_lock(hashtext('fx_scalper_reserve'));
  select count(*), coalesce(sum(reserved_risk), 0) into v_live, v_risk
    from public.fx_scalper_trades
   where state in ('reserved', 'sending', 'acknowledged', 'uncertain', 'open', 'closing');
  if v_live >= p_max_live then
    return query select null::uuid, false, format('already %s bot trades in flight or open (max %s)', v_live, p_max_live);
    return;
  end if;
  if v_risk + (p_row->>'reserved_risk')::numeric > p_max_risk then
    return query select null::uuid, false, format('open risk %s + this %s would pass the %s cap', round(v_risk, 2), round((p_row->>'reserved_risk')::numeric, 2), round(p_max_risk, 2));
    return;
  end if;
  begin
    insert into public.fx_scalper_trades (
      signal_key, tag, fence, control_version, settings_version, account_id, acc_num, pair, broker_symbol,
      tradable_instrument_id, side, state, candle_t, signal, plan, qty, planned_entry, planned_stop,
      planned_target, stop_pips, reserved_risk, stop_price, target_price)
    values (
      p_row->>'signal_key', p_row->>'tag', p_fence, p_control_version, (p_row->>'settings_version')::bigint,
      p_row->>'account_id', p_row->>'acc_num', p_row->>'pair', p_row->>'broker_symbol',
      p_row->>'tradable_instrument_id', p_row->>'side', 'reserved', (p_row->>'candle_t')::timestamptz,
      coalesce(p_row->'signal', '{}'::jsonb), coalesce(p_row->'plan', '{}'::jsonb), (p_row->>'qty')::numeric,
      (p_row->>'planned_entry')::numeric, (p_row->>'planned_stop')::numeric, (p_row->>'planned_target')::numeric,
      (p_row->>'stop_pips')::numeric, (p_row->>'reserved_risk')::numeric,
      (p_row->>'planned_stop')::numeric, (p_row->>'planned_target')::numeric)
    returning id into v_id;
  exception
    when unique_violation then
      return query select null::uuid, false, 'this pair already has a bot trade in flight or open'::text;
      return;
  end;
  return query select v_id, true, 'reserved'::text;
  return;
end;
$$;

-- =================================================================================================
-- Move a trade on, only from the states named and only while holding the lease. A worker that lost
-- the lease (stalled, redeployed) can write nothing more about any trade. The row is locked and read
-- in the same transaction before the patch is applied, so two concurrent updates cannot undo each
-- other's columns; a lease handover waits for this to finish (FOR SHARE on the lease row).
-- =================================================================================================
create or replace function public.fx_scalper_update_trade(p_owner text, p_fence bigint, p_id uuid, p_from text[], p_patch jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.fx_scalper_trades%rowtype;
  v_new public.fx_scalper_trades%rowtype;
begin
  perform 1 from public.fx_scalper_lease where id = 1 and owner = p_owner and fence = p_fence and expires_at > now() for share;
  if not found then
    return false;
  end if;
  select * into v_row from public.fx_scalper_trades where id = p_id for update;
  if not found then
    return false;
  end if;
  if p_from is not null and not (v_row.state = any (p_from)) then
    return false;
  end if;
  v_new := jsonb_populate_record(v_row, p_patch);
  update public.fx_scalper_trades
     set state                  = v_new.state,
         order_id               = v_new.order_id,
         position_id            = v_new.position_id,
         sent_at                = v_new.sent_at,
         ack_at                 = v_new.ack_at,
         ack_latency_ms         = v_new.ack_latency_ms,
         filled_qty             = v_new.filled_qty,
         fill_price             = v_new.fill_price,
         filled_at              = v_new.filled_at,
         stop_price             = v_new.stop_price,
         target_price           = v_new.target_price,
         reserved_risk          = v_new.reserved_risk,
         protection             = v_new.protection,
         protection_verified_at = v_new.protection_verified_at,
         time_exit_due_at       = v_new.time_exit_due_at,
         close_requested_at     = v_new.close_requested_at,
         close_reason           = v_new.close_reason,
         exit_price             = v_new.exit_price,
         closed_at              = v_new.closed_at,
         gross_pnl              = v_new.gross_pnl,
         commission             = v_new.commission,
         other_charges          = v_new.other_charges,
         net_pnl                = v_new.net_pnl,
         pnl_final              = v_new.pnl_final,
         conversion             = v_new.conversion,
         closed_lots            = v_new.closed_lots,
         eligible_lots          = v_new.eligible_lots,
         error                  = v_new.error,
         notes                  = v_new.notes,
         broker                 = v_new.broker,
         updated_at             = now()
   where id = p_id;
  return true;
end;
$$;

-- =================================================================================================
-- Change the control row. Every change bumps `version`, which voids any decision made before it (the
-- reserve function checks the version it was decided under). `p_expect` makes a change conditional on
-- the row being exactly what the caller saw (START LIVE from a dashboard that was looking at it).
-- =================================================================================================
create or replace function public.fx_scalper_control_update(p_patch jsonb, p_by uuid, p_expect bigint)
returns table (ok boolean, new_version bigint, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.fx_scalper_control%rowtype;
  v_new public.fx_scalper_control%rowtype;
begin
  select * into v_row from public.fx_scalper_control where id = 1 for update;
  if not found then
    return query select false, null::bigint, 'the control row is missing'::text;
    return;
  end if;
  if p_expect is not null and p_expect <> v_row.version then
    return query select false, v_row.version, 'the bot changed since this page loaded — reload and try again'::text;
    return;
  end if;
  v_new := jsonb_populate_record(v_row, p_patch);
  update public.fx_scalper_control
     set mode                   = v_new.mode,
         entries_paused         = v_new.entries_paused,
         pause_reason           = v_new.pause_reason,
         pause_until            = v_new.pause_until,
         connection_id          = v_new.connection_id,
         account_id             = v_new.account_id,
         acc_num                = v_new.acc_num,
         account_label          = v_new.account_label,
         account_currency       = v_new.account_currency,
         started_at             = v_new.started_at,
         started_by             = v_new.started_by,
         start_settings_version = v_new.start_settings_version,
         stopped_at             = v_new.stopped_at,
         stop_reason            = v_new.stop_reason,
         close_all_reason       = v_new.close_all_reason,
         close_all_at           = v_new.close_all_at,
         version                = v_row.version + 1,
         updated_at             = now(),
         updated_by             = p_by
   where id = 1;
  return query select true, v_row.version + 1, 'updated'::text;
  return;
end;
$$;

revoke all on function public.fx_scalper_control_update(jsonb, uuid, bigint) from public, anon, authenticated;
revoke all on function public.fx_scalper_acquire_lease(text, integer) from public, anon, authenticated;
revoke all on function public.fx_scalper_extend_lease(text, bigint, integer) from public, anon, authenticated;
revoke all on function public.fx_scalper_release_lease(text, bigint) from public, anon, authenticated;
revoke all on function public.fx_scalper_reserve(text, bigint, bigint, integer, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.fx_scalper_update_trade(text, bigint, uuid, text[], jsonb) from public, anon, authenticated;
