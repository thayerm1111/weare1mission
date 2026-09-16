-- Fix (audit 09-16): genx_reservation_mark('active') gives a resting order a 60s expiry, and
-- genx_reconcile_stale_reservations deleted expired 'active' rows BEFORE the cancel sweep
-- (reconcileStaleGoldEntries, >180s) could see them. A resting GTC entry was then never
-- cancelled, the account was un-reserved, and a later fill could open an unmanaged,
-- stackable position. Now only 'active' rows with NO order id expire on the 60s clock; a
-- row with an order id stays until the cancel sweep resolves it (or it is stale for
-- p_max_age_secs with no open position).
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
       or (state = 'active' and order_id is null and expires_at < now())
       or (state = 'active' and order_id is not null and updated_at < now() - make_interval(secs => greatest(p_max_age_secs, 60))
           and not exists (
             select 1 from public.flow_managed_positions mp
             where mp.account_id = flow_account_reservations.account_id
               and upper(mp.symbol) = flow_account_reservations.symbol
               and mp.status = 'open'))
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
