-- Reverses 20261003010000_genfx_settle.sql. Not applied anywhere; kept so the change can be undone.
-- Removing the guard lifts the commissioning hold, so run this only on a database where GEN FX's
-- order path is already released (or is being removed altogether).
drop trigger if exists genfx_control_guard on public.genfx_control;
drop function if exists public.genfx_control_guard();
drop index if exists public.genfx_fills_unsettled_idx;
alter table public.genfx_fills drop column if exists checks, drop column if exists note;
