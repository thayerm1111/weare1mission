-- FLOW credits: ONE credit per member per 30-minute watching window, no matter how many accounts
-- (owner 09-17: "change the credit system back to only charging one credit, no matter how many accounts").
-- Same system as before (billed while watching, pause on 0 credits, resume on top-up) — just per member.
create or replace function public.flow_bill_member(p_user uuid, p_cost int, p_allowance int, p_window_secs int default 1800)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_last timestamptz; v_paused boolean; r jsonb;
begin
  if p_user is null then return jsonb_build_object('result', 'error', 'ok', true); end if;
  perform pg_advisory_xact_lock(hashtext('flow_bill:' || p_user::text));   -- one charge per member per window, even with concurrent callers
  select max(flow_last_credit_at) filter (where not flow_credit_paused), bool_or(flow_credit_paused)
    into v_last, v_paused
    from public.flow_broker_accounts where user_id = p_user and (autotrade_enabled or genx_follower);
  if v_last is not null and v_last > now() - make_interval(secs => p_window_secs) and not coalesce(v_paused, false) then
    return jsonb_build_object('result', 'inside_window', 'ok', true);
  end if;
  r := public.spend_credits_for(p_user, p_cost, p_allowance, 'flow_autorun');
  if coalesce((r->>'ok')::boolean, false) then
    update public.flow_broker_accounts set flow_last_credit_at = now(), flow_credit_paused = false where user_id = p_user;
    return jsonb_build_object('result', 'charged', 'ok', true);
  end if;
  update public.flow_broker_accounts set flow_credit_paused = true where user_id = p_user and (autotrade_enabled or genx_follower);
  return jsonb_build_object('result', 'paused', 'ok', false);
end $$;
revoke all on function public.flow_bill_member(uuid, int, int, int) from public, anon, authenticated;
grant execute on function public.flow_bill_member(uuid, int, int, int) to service_role;
