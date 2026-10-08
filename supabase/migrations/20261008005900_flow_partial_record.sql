-- WHERE A PARTIAL WAS BANKED, AND HOW MUCH (10-08). A member can now pick a 25% or 50% partial, banked
-- halfway to the trade's target; the trade manager records the price it banked at and the share of the
-- position it was, so the closed trade is graded on what it actually took (flowManage.classifyOutcome).
-- Null on every position from before — those grade exactly as they always did.
--
-- Its own migration, apart from the account settings, so it never holds one table's lock while waiting
-- for the other's: this table is written on every pass of the trade manager. 5-second lock wait at most.
-- Applied BEFORE 20261008010000_flow_trade_management.sql: no member can pick a partial until that one
-- adds partial_pct, so the columns a partial is recorded in are always there first.
set lock_timeout = '5s';

alter table public.flow_managed_positions
  add column if not exists partial_px numeric,
  add column if not exists partial_frac numeric;
reset lock_timeout;
