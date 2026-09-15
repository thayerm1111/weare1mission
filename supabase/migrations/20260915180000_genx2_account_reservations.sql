-- GENX 2.0 — Rule #1: ONE automated gold entry at a time per broker account.
--
-- Backward-compatible: adds a new table + functions only. Nothing existing is altered,
-- so this is safe to apply ahead of or alongside the code deploy. No code reads these
-- objects until GENX2_RESERVATION is on (default on, fail-open) in the deployed worker/API.
--
-- Model: exactly one reservation row per (account_id, symbol). A reservation "occupies"
-- the account for that symbol while an entry order is in flight (active), has filled
-- (filled → held until the position closes), or resolved to an unknown broker result
-- (unknown → held until a reconciler confirms). Releasing requires reconciliation; a
-- partial close never releases. Concurrency is serialized per account with a
-- transaction advisory lock, and an OPEN managed position is treated as exposure even
-- when no reservation row exists (backstop against a silently-filled order).

create table if not exists public.flow_account_reservations (
  account_id  text        not null,
  symbol      text        not null,
  state       text        not null default 'active',   -- active | filled | unknown | released
  signal_key  text,
  order_id    text,
  position_id text,
  reserved_at timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '60 seconds'),
  updated_at  timestamptz not null default now(),
  primary key (account_id, symbol),
  constraint flow_account_reservations_state_chk
    check (state in ('active','filled','unknown','released'))
);

create index if not exists flow_account_reservations_state_idx
  on public.flow_account_reservations (symbol, state);

-- Reserve the account for a gold entry. Returns { reserved, reason, state }.
-- reserved=false means the account is already exposed (open position or live reservation)
-- and the caller MUST NOT submit an order.
create or replace function public.genx_reserve_gold(
  p_account_id text,
  p_symbol     text,
  p_signal_key text,
  p_ttl_secs   int default 60
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sym      text := upper(coalesce(p_symbol, ''));
  v_existing public.flow_account_reservations%rowtype;
  v_open     int;
begin
  if p_account_id is null or p_account_id = '' or v_sym = '' then
    return jsonb_build_object('reserved', false, 'reason', 'bad_args', 'state', null);
  end if;

  -- Serialize concurrent reserves for the same account+symbol. Transaction-scoped:
  -- auto-released at commit, so two parallel fan-out attempts can't both win.
  perform pg_advisory_xact_lock( hashtext('genx_resv:' || p_account_id || ':' || v_sym)::bigint );

  -- Exposure backstop: an OPEN managed gold position counts as exposure even with no
  -- reservation row (e.g. a prior order filled and the reservation expired/was lost).
  select count(*) into v_open
  from public.flow_managed_positions
  where account_id = p_account_id
    and upper(symbol) = v_sym
    and status = 'open';
  if v_open > 0 then
    return jsonb_build_object('reserved', false, 'reason', 'open_position', 'state', 'filled');
  end if;

  -- Existing reservation that still occupies the account.
  select * into v_existing
  from public.flow_account_reservations
  where account_id = p_account_id and symbol = v_sym
  for update;

  if found then
    -- filled / unknown never auto-expire; active expires by ttl (a dead submit attempt).
    if v_existing.state in ('filled','unknown')
       or (v_existing.state = 'active' and v_existing.expires_at > now()) then
      return jsonb_build_object('reserved', false,
                                'reason', 'reserved:' || v_existing.state,
                                'state', v_existing.state);
    end if;
    -- Reclaim a released/expired-active row.
    update public.flow_account_reservations
      set state = 'active', signal_key = p_signal_key, order_id = null, position_id = null,
          reserved_at = now(), expires_at = now() + make_interval(secs => greatest(p_ttl_secs, 5)),
          updated_at = now()
      where account_id = p_account_id and symbol = v_sym;
    return jsonb_build_object('reserved', true, 'reason', 'reclaimed', 'state', 'active');
  end if;

  insert into public.flow_account_reservations
    (account_id, symbol, state, signal_key, reserved_at, expires_at, updated_at)
  values
    (p_account_id, v_sym, 'active', p_signal_key, now(),
     now() + make_interval(secs => greatest(p_ttl_secs, 5)), now());
  return jsonb_build_object('reserved', true, 'reason', 'new', 'state', 'active');
end;
$$;

-- Transition a held reservation after the broker responds (accepted→active w/ order_id,
-- filled→filled w/ position_id, unknown→unknown). Extends expiry for 'active'.
create or replace function public.genx_reservation_mark(
  p_account_id  text,
  p_symbol      text,
  p_state       text,
  p_order_id    text default null,
  p_position_id text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_sym text := upper(coalesce(p_symbol, ''));
begin
  if p_state not in ('active','filled','unknown','released') then
    return false;
  end if;
  update public.flow_account_reservations
    set state = p_state,
        order_id = coalesce(p_order_id, order_id),
        position_id = coalesce(p_position_id, position_id),
        expires_at = case when p_state = 'active' then now() + interval '60 seconds' else expires_at end,
        updated_at = now()
    where account_id = p_account_id and symbol = v_sym;
  return found;
end;
$$;

-- Release the account (delete the reservation). Caller must have reconciled first:
-- order rejected/canceled with no fill, or the managed position closed. Never call on a
-- partial close.
create or replace function public.genx_release_gold(
  p_account_id text,
  p_symbol     text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_sym text := upper(coalesce(p_symbol, ''));
begin
  delete from public.flow_account_reservations
    where account_id = p_account_id and symbol = v_sym;
  return true;
end;
$$;

-- Housekeeping: drop released rows and expired 'active' rows (a dead submit attempt; the
-- open-position backstop in genx_reserve_gold covers a silently-filled order). Leaves
-- 'filled'/'unknown' for explicit reconciliation. Returns rows removed.
create or replace function public.genx_reconcile_stale_reservations(
  p_max_age_secs int default 900
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare v int;
begin
  with del as (
    delete from public.flow_account_reservations
    where state = 'released'
       or (state = 'active' and expires_at < now())
       or (state in ('filled','unknown') and updated_at < now() - make_interval(secs => greatest(p_max_age_secs, 60))
           and not exists (
             select 1 from public.flow_managed_positions mp
             where mp.account_id = flow_account_reservations.account_id
               and upper(mp.symbol) = flow_account_reservations.symbol
               and mp.status = 'open'))
    returning 1)
  select count(*) into v from del;
  return v;
end;
$$;
