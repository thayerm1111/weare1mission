-- FLOW CREDITS — EVENT BILLING (owner 09-18: "let's do 5 credits per trade and 1 when the trade is forming").
-- Replaces the 30-minute watching window: a member pays 1 credit when a setup they are armed for starts
-- forming, and 5 credits when GENX actually puts an order on one of their accounts. Quiet days cost nothing.
-- Idempotency is per member per event key (the alert's dedupe key), so a fan-out that retries, a second
-- account, or two workers can never double-charge the same member for the same setup or the same fire.
create table if not exists public.flow_billing_events (
  user_id uuid not null,
  event_key text not null,          -- e.g. 'setup:quick:buy:4348:4349' or 'trade:quick:buy:4348:4349'
  kind text not null check (kind in ('setup', 'trade')),
  cost int not null,
  at timestamptz not null default now(),
  primary key (user_id, event_key)
);
alter table public.flow_billing_events enable row level security;
revoke all on public.flow_billing_events from public, anon, authenticated;
create index if not exists flow_billing_events_at on public.flow_billing_events (at desc);

-- Charge a member ONCE for one event. Returns {result, ok}:
--   charged    — credits taken
--   already    — this member already paid for this event key (ok: true, nothing taken)
--   paused     — out of credits; the member's accounts are paused until they top up
--   error      — system fault; fails OPEN for a member who was not already paused
create or replace function public.flow_bill_event(p_user uuid, p_key text, p_kind text, p_cost int, p_allowance int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_paused boolean; r jsonb;
begin
  if p_user is null or p_key is null then return jsonb_build_object('result', 'error', 'ok', true); end if;
  perform pg_advisory_xact_lock(hashtext('flow_bill_ev:' || p_user::text || ':' || p_key));
  if exists (select 1 from public.flow_billing_events where user_id = p_user and event_key = p_key) then
    return jsonb_build_object('result', 'already', 'ok', true);
  end if;
  select bool_or(flow_credit_paused) into v_paused
    from public.flow_broker_accounts where user_id = p_user and (autotrade_enabled or genx_follower);
  r := public.spend_credits_for(p_user, p_cost, p_allowance, 'flow_autorun');
  if coalesce((r->>'ok')::boolean, false) then
    insert into public.flow_billing_events (user_id, event_key, kind, cost) values (p_user, p_key, p_kind, p_cost)
      on conflict do nothing;
    update public.flow_broker_accounts set flow_last_credit_at = now(), flow_credit_paused = false where user_id = p_user;
    return jsonb_build_object('result', 'charged', 'ok', true);
  end if;
  update public.flow_broker_accounts set flow_credit_paused = true where user_id = p_user and (autotrade_enabled or genx_follower);
  return jsonb_build_object('result', 'paused', 'ok', false);
end $$;
revoke all on function public.flow_bill_event(uuid, text, text, int, int) from public, anon, authenticated;
grant execute on function public.flow_bill_event(uuid, text, text, int, int) to service_role;
