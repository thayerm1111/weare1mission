-- Undo GEN FX's schema. Run only with GEN FX's code no longer deployed.
-- The trade ledger is not touched: positions GEN FX opened stay in flow_managed_positions as history.
drop index if exists public.flow_managed_positions_genfx_idx;
drop index if exists public.flow_broker_accounts_genfx_idx;
alter table public.flow_broker_accounts drop column if exists genfx_eurusd, drop column if exists genfx_gbpjpy;
delete from public.flow_manage_lock where id = 6;
drop table if exists public.genfx_fills;
drop table if exists public.genfx_tracked;
drop table if exists public.genfx_signals;
drop table if exists public.genfx_alerts;
drop table if exists public.genfx_control;
