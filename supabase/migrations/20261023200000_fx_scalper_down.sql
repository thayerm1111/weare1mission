-- Undo of 20261023200000_fx_scalper: removes the FX Scalper's own functions and tables (and their data).
-- No other table is touched. Close or hand over any open bot position at the broker BEFORE running this.
drop function if exists public.fx_scalper_control_update(jsonb, uuid, bigint);
drop function if exists public.fx_scalper_update_trade(text, bigint, uuid, text[], jsonb);
drop function if exists public.fx_scalper_reserve(text, bigint, bigint, integer, numeric, jsonb);
drop function if exists public.fx_scalper_release_lease(text, bigint);
drop function if exists public.fx_scalper_extend_lease(text, bigint, integer);
drop function if exists public.fx_scalper_acquire_lease(text, integer);
drop table if exists public.fx_scalper_compensation;
drop table if exists public.fx_scalper_commands;
drop table if exists public.fx_scalper_events;
drop table if exists public.fx_scalper_status;
drop table if exists public.fx_scalper_days;
drop table if exists public.fx_scalper_trades;
drop table if exists public.fx_scalper_instruments;
drop table if exists public.fx_scalper_lease;
drop table if exists public.fx_scalper_settings_history;
drop table if exists public.fx_scalper_settings;
drop table if exists public.fx_scalper_control;
drop table if exists public.fx_scalper_connections;
