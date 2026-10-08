-- Reverses 20261008010000_flow_trade_management.sql.
--
-- FIRST: an account with break-even OFF and only a partial on has manage_trades = true. The code before
-- this change reads manage_trades alone, and would give that account full AI Pips — break-even, trail and
-- snap. So it is switched off before the columns go (and before any rollback of the code: run this
-- update first). The be_enabled backfill itself is not undone: the code before never read be_enabled in
-- the manager, and the value it wrote matches manage_trades.
set lock_timeout = '5s';
update public.flow_broker_accounts set manage_trades = false where be_enabled is false;
drop trigger if exists flow_accounts_derive_manage on public.flow_broker_accounts;
drop function if exists public.flow_accounts_derive_manage();
comment on column public.flow_broker_accounts.manage_trades is null;
alter table public.flow_broker_accounts drop constraint if exists flow_broker_accounts_partial_pct_check;
alter table public.flow_broker_accounts drop constraint if exists flow_broker_accounts_trail_mode_check;
alter table public.flow_broker_accounts
  drop column if exists partial_pct,
  drop column if exists trail_mode;
reset lock_timeout;
