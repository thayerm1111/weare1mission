-- Undo of 20261021120000_cashtrap: removes the Cashtrap module's own tables (and their data). No other table is touched.
drop table if exists public.cashtrap_replay_runs;
drop table if exists public.cashtrap_notification_prefs;
drop table if exists public.cashtrap_alert_deliveries;
drop table if exists public.cashtrap_alerts;
drop table if exists public.cashtrap_dmi_events;
drop table if exists public.cashtrap_zones;
drop table if exists public.cashtrap_signals;
drop table if exists public.cashtrap_setups;
drop table if exists public.cashtrap_decisions;
drop table if exists public.cashtrap_snapshots;
drop table if exists public.cashtrap_state;
drop table if exists public.cashtrap_data_corrections;
drop table if exists public.cashtrap_candles;
drop table if exists public.cashtrap_lock;
drop table if exists public.cashtrap_settings_log;
drop table if exists public.cashtrap_settings;
