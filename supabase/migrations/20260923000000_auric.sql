-- AURIC — independent XAUUSD automation. Every object is auric_* and touches nothing owned by GENX / FLOW / ATLAS.
-- Reversible: see supabase/migrations/20260923000000_auric_down.sql.

create table if not exists public.auric_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.auric_settings (key, value) values
  ('daily_price_credits', 'null'::jsonb),        -- admin sets; activation refuses while null
  ('engine_enabled', 'false'::jsonb),           -- global flag for the worker loop
  ('live_orders_enabled', 'false'::jsonb),      -- global flag: orders may be sent to LIVE accounts
  ('session_hours', '24'::jsonb)
on conflict (key) do nothing;

create table if not exists public.auric_broker_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  env text not null check (env in ('demo','live')),
  server text not null,
  email_masked text not null,
  enc_credentials text not null,          -- sealed JSON {email,password,server} (AURIC key)
  enc_access_token text,
  enc_refresh_token text,
  token_exp timestamptz,
  status text not null default 'new',
  last_error text,
  imported_from text,                     -- 'flow_broker_connections:<id>' when imported with consent
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists auric_broker_connections_user on public.auric_broker_connections(user_id);

create table if not exists public.auric_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.auric_broker_connections(id) on delete cascade,
  broker_account_id text not null,
  acc_num text not null,
  name text,
  currency text,
  balance double precision,
  equity double precision,
  state_at timestamptz,
  instrument_spec jsonb,
  spec_missing text[] not null default '{}',
  session_source text,
  risk_fraction numeric not null default 0.005 check (risk_fraction >= 0.0025 and risk_fraction <= 0.01),
  allow_shared_account boolean not null default false,
  consent_at timestamptz,
  consent_version text,
  consent_terms jsonb,
  live_authorized_at timestamptz,
  live_authorized_by uuid,
  status text not null default 'linked' check (status in ('linked','blocked','disabled')),
  block_reason text,
  ownership_check jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, broker_account_id)
);
create index if not exists auric_accounts_user on public.auric_accounts(user_id);

create table if not exists public.auric_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.auric_accounts(id) on delete cascade,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  credits_charged int not null,
  credit_tx_key text not null unique,
  auto_renew boolean not null default false,
  auto_renew_price int,
  status text not null default 'active' check (status in ('active','expired','cancelled','failed')),
  paused_entries boolean not null default false,
  pause_reason text,
  refunded_at timestamptz,
  activation_checks jsonb,
  created_at timestamptz not null default now()
);
create index if not exists auric_sessions_account on public.auric_sessions(account_id, status);

create table if not exists public.auric_risk_state (
  account_id uuid primary key references public.auric_accounts(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.auric_engine_state (
  account_id uuid primary key references public.auric_accounts(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.auric_intents (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.auric_accounts(id) on delete cascade,
  session_id uuid references public.auric_sessions(id) on delete set null,
  setup_id text not null,
  strategy_version text not null,
  side text not null check (side in ('buy','sell')),
  qty numeric not null,
  entry_ref numeric not null,
  stop numeric not null,
  target numeric not null,
  strategy_tag text not null unique,
  status text not null default 'planned' check (status in ('planned','submitting','submitted','filled','rejected','unknown','cancelled','expired')),
  broker_order_id text,
  broker_position_id text,
  submitted_at timestamptz,
  ack_at timestamptz,
  ack_latency_ms int,
  fill_price numeric,
  error text,
  candidate jsonb not null,
  sizing jsonb not null,
  fence bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, setup_id)
);

create table if not exists public.auric_positions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.auric_accounts(id) on delete cascade,
  session_id uuid references public.auric_sessions(id) on delete set null,
  intent_id uuid references public.auric_intents(id) on delete set null,
  broker_position_id text not null,
  strategy_tag text not null,
  side text not null check (side in ('buy','sell')),
  qty numeric not null,
  entry numeric not null,
  stop numeric not null,
  target numeric not null,
  initial_risk numeric not null,
  invalidation numeric not null,
  setup_family text not null,
  protected boolean not null default false,
  protection_attempts int not null default 0,
  sl_id text, tp_id text,
  opened_at timestamptz not null,
  status text not null default 'open' check (status in ('open','closing','closed','orphan_review')),
  closed_at timestamptz,
  close_reason text,
  realized_pnl numeric,
  management_version text not null,
  mgmt jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, broker_position_id)
);
create index if not exists auric_positions_open on public.auric_positions(account_id) where status in ('open','closing');

create table if not exists public.auric_events (
  id bigserial primary key,
  account_id uuid not null references public.auric_accounts(id) on delete cascade,
  session_id uuid,
  at timestamptz not null default now(),
  kind text not null,
  state text,
  message text not null,
  payload jsonb
);
create index if not exists auric_events_account_at on public.auric_events(account_id, at desc);

create table if not exists public.auric_snapshots (
  account_id uuid primary key references public.auric_accounts(id) on delete cascade,
  at timestamptz not null default now(),
  payload jsonb not null
);

create table if not exists public.auric_leases (
  account_id uuid primary key references public.auric_accounts(id) on delete cascade,
  owner text not null,
  fence bigint not null default 0,
  expires_at timestamptz not null
);

create table if not exists public.auric_telemetry (
  id bigserial primary key,
  account_id uuid,
  at timestamptz not null default now(),
  kind text not null,
  payload jsonb not null
);
create index if not exists auric_telemetry_at on public.auric_telemetry(at desc);

-- User controls that the worker must execute (close AURIC positions). Written by server routes only.
create table if not exists public.auric_commands (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.auric_accounts(id) on delete cascade,
  command text not null check (command in ('close_auric')),
  requested_by text not null,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists auric_commands_pending on public.auric_commands(account_id) where done_at is null;

create table if not exists public.auric_worker_heartbeat (
  worker text primary key,
  at timestamptz not null default now(),
  info jsonb
);

-- ---------------------------------------------------------------- RLS
alter table public.auric_settings enable row level security;
alter table public.auric_broker_connections enable row level security;
alter table public.auric_accounts enable row level security;
alter table public.auric_sessions enable row level security;
alter table public.auric_risk_state enable row level security;
alter table public.auric_engine_state enable row level security;
alter table public.auric_intents enable row level security;
alter table public.auric_positions enable row level security;
alter table public.auric_events enable row level security;
alter table public.auric_snapshots enable row level security;
alter table public.auric_leases enable row level security;
alter table public.auric_telemetry enable row level security;
alter table public.auric_worker_heartbeat enable row level security;
alter table public.auric_commands enable row level security;

-- Members may READ their own rows on the display tables. All writes go through server routes (service role).
-- Connections, leases, engine state, telemetry and settings have NO member policies: service role only.
drop policy if exists auric_accounts_select on public.auric_accounts;
create policy auric_accounts_select on public.auric_accounts for select using (auth.uid() = user_id);
drop policy if exists auric_sessions_select on public.auric_sessions;
create policy auric_sessions_select on public.auric_sessions for select using (auth.uid() = user_id);
drop policy if exists auric_positions_select on public.auric_positions;
create policy auric_positions_select on public.auric_positions for select using (exists (select 1 from public.auric_accounts a where a.id = account_id and a.user_id = auth.uid()));
drop policy if exists auric_intents_select on public.auric_intents;
create policy auric_intents_select on public.auric_intents for select using (exists (select 1 from public.auric_accounts a where a.id = account_id and a.user_id = auth.uid()));
drop policy if exists auric_events_select on public.auric_events;
create policy auric_events_select on public.auric_events for select using (exists (select 1 from public.auric_accounts a where a.id = account_id and a.user_id = auth.uid()));
drop policy if exists auric_snapshots_select on public.auric_snapshots;
create policy auric_snapshots_select on public.auric_snapshots for select using (exists (select 1 from public.auric_accounts a where a.id = account_id and a.user_id = auth.uid()));
drop policy if exists auric_risk_state_select on public.auric_risk_state;
create policy auric_risk_state_select on public.auric_risk_state for select using (exists (select 1 from public.auric_accounts a where a.id = account_id and a.user_id = auth.uid()));

-- Realtime: members may subscribe to their own events/snapshots (RLS applies to realtime).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.auric_events; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.auric_snapshots; exception when duplicate_object then null; end;
  end if;
end $$;

-- ---------------------------------------------------------------- RPCs (service role only)
-- Atomic activation: lock per account, verify ownership/consent/price, debit via the EXISTING wallet function,
-- create the entitlement. Idempotent on p_key (double clicks, retries, multiple tabs return the same session).
create or replace function public.auric_activate_session(p_user uuid, p_account uuid, p_key text, p_allowance int, p_checks jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_price int; v_hours int; v_existing public.auric_sessions; v_acct public.auric_accounts; v_spend jsonb; v_id uuid; v_exp timestamptz;
begin
  if p_user is null or p_account is null or p_key is null then return jsonb_build_object('ok', false, 'error', 'bad_args'); end if;
  perform pg_advisory_xact_lock(hashtext('auric_activate:' || p_account::text));
  select * into v_existing from public.auric_sessions where credit_tx_key = p_key;
  if found then return jsonb_build_object('ok', true, 'session_id', v_existing.id, 'expires_at', v_existing.expires_at, 'charged', v_existing.credits_charged, 'idempotent', true); end if;
  select * into v_acct from public.auric_accounts where id = p_account and user_id = p_user;
  if not found then return jsonb_build_object('ok', false, 'error', 'account_not_owned'); end if;
  if v_acct.status <> 'linked' then return jsonb_build_object('ok', false, 'error', 'account_' || v_acct.status, 'detail', v_acct.block_reason); end if;
  if v_acct.consent_at is null then return jsonb_build_object('ok', false, 'error', 'consent_required'); end if;
  if exists (select 1 from public.auric_sessions where account_id = p_account and status = 'active' and expires_at > now()) then
    return jsonb_build_object('ok', false, 'error', 'session_active');
  end if;
  select (value #>> '{}')::int into v_price from public.auric_settings where key = 'daily_price_credits' and value <> 'null'::jsonb;
  if v_price is null then return jsonb_build_object('ok', false, 'error', 'price_not_configured'); end if;
  select coalesce((value #>> '{}')::int, 24) into v_hours from public.auric_settings where key = 'session_hours';
  v_spend := public.spend_credits_for(p_user, v_price, p_allowance, 'auric');
  if coalesce((v_spend ->> 'ok')::boolean, false) = false then
    return jsonb_build_object('ok', false, 'error', coalesce(v_spend ->> 'error', 'insufficient'), 'balance', v_spend, 'price', v_price);
  end if;
  v_exp := now() + make_interval(hours => coalesce(v_hours, 24));
  insert into public.auric_sessions (user_id, account_id, expires_at, credits_charged, credit_tx_key, activation_checks)
    values (p_user, p_account, v_exp, v_price, p_key, p_checks) returning id into v_id;
  return jsonb_build_object('ok', true, 'session_id', v_id, 'expires_at', v_exp, 'charged', v_price, 'balance', v_spend);
end $$;
revoke all on function public.auric_activate_session(uuid, uuid, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.auric_activate_session(uuid, uuid, text, int, jsonb) to service_role;

-- Idempotent refund when activation fails technically after the debit.
create or replace function public.auric_refund_session(p_session uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.auric_sessions;
begin
  perform pg_advisory_xact_lock(hashtext('auric_refund:' || p_session::text));
  select * into s from public.auric_sessions where id = p_session for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if s.refunded_at is not null then return jsonb_build_object('ok', true, 'idempotent', true); end if;
  perform public.add_purchased_credits(s.user_id, s.credits_charged, 'auric_refund');
  update public.auric_sessions set refunded_at = now(), status = 'failed', pause_reason = p_reason where id = p_session;
  return jsonb_build_object('ok', true, 'refunded', s.credits_charged);
end $$;
revoke all on function public.auric_refund_session(uuid, text) from public, anon, authenticated;
grant execute on function public.auric_refund_session(uuid, text) to service_role;

-- Auto-renew (explicit opt-in only): same debit path, new session, no overlap.
create or replace function public.auric_renew_session(p_session uuid, p_allowance int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.auric_sessions; v_price int; v_hours int; v_spend jsonb; v_id uuid; v_exp timestamptz; v_key text;
begin
  perform pg_advisory_xact_lock(hashtext('auric_renew:' || p_session::text));
  select * into s from public.auric_sessions where id = p_session for update;
  if not found or not s.auto_renew or s.status <> 'active' then return jsonb_build_object('ok', false, 'error', 'not_renewable'); end if;
  if s.expires_at > now() then return jsonb_build_object('ok', false, 'error', 'not_expired'); end if;
  select (value #>> '{}')::int into v_price from public.auric_settings where key = 'daily_price_credits' and value <> 'null'::jsonb;
  if v_price is null or s.auto_renew_price is null or v_price > s.auto_renew_price then
    update public.auric_sessions set status = 'expired', pause_reason = 'auto-renew stopped: price changed or unset' where id = p_session;
    return jsonb_build_object('ok', false, 'error', 'price_changed');
  end if;
  v_key := 'renew:' || p_session::text;
  if exists (select 1 from public.auric_sessions where credit_tx_key = v_key) then return jsonb_build_object('ok', true, 'idempotent', true); end if;
  select coalesce((value #>> '{}')::int, 24) into v_hours from public.auric_settings where key = 'session_hours';
  v_spend := public.spend_credits_for(s.user_id, v_price, p_allowance, 'auric');
  update public.auric_sessions set status = 'expired' where id = p_session;
  if coalesce((v_spend ->> 'ok')::boolean, false) = false then return jsonb_build_object('ok', false, 'error', 'insufficient'); end if;
  v_exp := now() + make_interval(hours => coalesce(v_hours, 24));
  insert into public.auric_sessions (user_id, account_id, expires_at, credits_charged, credit_tx_key, auto_renew, auto_renew_price)
    values (s.user_id, s.account_id, v_exp, v_price, v_key, true, s.auto_renew_price) returning id into v_id;
  return jsonb_build_object('ok', true, 'session_id', v_id, 'expires_at', v_exp, 'charged', v_price);
end $$;
revoke all on function public.auric_renew_session(uuid, int) from public, anon, authenticated;
grant execute on function public.auric_renew_session(uuid, int) to service_role;

-- Worker ownership lease with a monotonically increasing fence.
create or replace function public.auric_acquire_lease(p_account uuid, p_owner text, p_ttl_sec int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.auric_leases;
begin
  perform pg_advisory_xact_lock(hashtext('auric_lease:' || p_account::text));
  select * into l from public.auric_leases where account_id = p_account for update;
  if not found then
    insert into public.auric_leases (account_id, owner, fence, expires_at) values (p_account, p_owner, 1, now() + make_interval(secs => p_ttl_sec)) returning * into l;
    return jsonb_build_object('ok', true, 'fence', l.fence);
  end if;
  if l.owner = p_owner or l.expires_at < now() then
    update public.auric_leases set owner = p_owner, fence = case when l.owner = p_owner then l.fence else l.fence + 1 end, expires_at = now() + make_interval(secs => p_ttl_sec)
      where account_id = p_account returning * into l;
    return jsonb_build_object('ok', true, 'fence', l.fence);
  end if;
  return jsonb_build_object('ok', false, 'owner', l.owner, 'expires_at', l.expires_at);
end $$;
revoke all on function public.auric_acquire_lease(uuid, text, int) from public, anon, authenticated;
grant execute on function public.auric_acquire_lease(uuid, text, int) to service_role;

-- Fenced write guard: an intent may only move state if the caller still holds the lease fence.
create or replace function public.auric_fenced_intent_update(p_intent uuid, p_fence bigint, p_patch jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_acct uuid; v_fence bigint;
begin
  select account_id into v_acct from public.auric_intents where id = p_intent;
  if v_acct is null then return false; end if;
  select fence into v_fence from public.auric_leases where account_id = v_acct;
  if v_fence is null or v_fence <> p_fence then return false; end if;
  update public.auric_intents set
    status = coalesce(p_patch ->> 'status', status),
    broker_order_id = coalesce(p_patch ->> 'broker_order_id', broker_order_id),
    broker_position_id = coalesce(p_patch ->> 'broker_position_id', broker_position_id),
    submitted_at = coalesce((p_patch ->> 'submitted_at')::timestamptz, submitted_at),
    ack_at = coalesce((p_patch ->> 'ack_at')::timestamptz, ack_at),
    ack_latency_ms = coalesce((p_patch ->> 'ack_latency_ms')::int, ack_latency_ms),
    fill_price = coalesce((p_patch ->> 'fill_price')::numeric, fill_price),
    error = coalesce(p_patch ->> 'error', error),
    updated_at = now()
  where id = p_intent;
  return true;
end $$;
revoke all on function public.auric_fenced_intent_update(uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.auric_fenced_intent_update(uuid, bigint, jsonb) to service_role;
