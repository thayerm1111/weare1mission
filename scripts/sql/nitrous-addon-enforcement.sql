-- Apply after the Nitrous add-on billing tables/functions. No account is granted access or armed.
-- Final database gates also protect against an older API or worker during a rolling release.

create or replace function public.nitrous_reserve_intent(
  p_intent_key text, p_account uuid, p_user uuid, p_session uuid, p_visit text, p_setup text,
  p_snapshot text, p_strategy text, p_config text, p_management text, p_family text, p_side text,
  p_entry numeric, p_stop numeric, p_target numeric, p_qty numeric, p_risk_pct numeric,
  p_estimated_risk numeric, p_bid numeric, p_ask numeric, p_quote_age_ms integer, p_spread numeric,
  p_automation_version bigint, p_fence bigint, p_broker_strategy_id text
)
returns table (intent_id uuid, created boolean, reason text)
language plpgsql
security invoker
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
  if not public.nitrous_has_addon_access(p_user) then
    return query select null::uuid, false, 'Nitrous add-on access is required for new entries'::text;
    return;
  end if;
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
  if (coalesce((p_patch->>'automation_enabled')::boolean,false) or v_profile is distinct from a.profile or v_risk is distinct from a.risk_pct)
    and not public.nitrous_has_addon_access(p_user) then
    return query select false, a.automation_enabled, a.automation_version; return;
  end if;
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

create or replace function public.nitrous_pause_without_addon(p_user uuid, p_account uuid, p_expected_version bigint)
returns boolean
language plpgsql security invoker set search_path=public
as $$
declare a public.nitrous_accounts%rowtype;
begin
  select * into a from public.nitrous_accounts where id=p_account and user_id=p_user for update;
  if not found or a.automation_version<>p_expected_version or not a.automation_enabled
    or public.nitrous_has_addon_access(p_user) then return false; end if;
  update public.nitrous_accounts set automation_enabled=false, automation_version=a.automation_version+1,
    execution_block_reason='Nitrous add-on access ended. Reactivate after access is restored.', updated_at=now()
    where id=a.id;
  insert into public.nitrous_journal(account_id,user_id,stage,code,decision,reason,evidence)
    values(a.id,p_user,'member_settings','addon_access_ended','paused',
      'Nitrous add-on access ended; new entries paused and existing positions keep protection.',
      jsonb_build_object('version',a.automation_version+1));
  return true;
end;
$$;

revoke all on function public.nitrous_pause_without_addon(uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.nitrous_pause_without_addon(uuid,uuid,bigint) to service_role;
revoke all on function public.nitrous_apply_settings(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.nitrous_apply_settings(uuid,uuid,bigint,jsonb) to service_role;
grant execute on function public.nitrous_reserve_intent(text,uuid,uuid,uuid,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,bigint,bigint,text) to service_role;
