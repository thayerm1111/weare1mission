-- Reverses 20261003020000_genfx_order_labels.sql. Not applied anywhere; kept so the change can be undone by hand.
drop index if exists public.flow_managed_positions_genfx_position_uidx;
drop index if exists public.genfx_fills_one_unsettled;
drop index if exists public.genfx_fills_due_idx;
alter table public.genfx_fills
  drop column if exists protect_tries,
  drop column if exists next_check_at,
  drop column if exists cancelled_at,
  drop column if exists clean,
  drop column if exists tag;
