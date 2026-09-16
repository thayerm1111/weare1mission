-- GENX 3.1: additive — widen the setup_type check to the 3.1 playbooks (existing rows unaffected).
alter table public.genx3_setups drop constraint if exists genx3_setups_setup_type_check;
alter table public.genx3_setups add constraint genx3_setups_setup_type_check check (setup_type in (
  'TREND_PULLBACK','SWEEP_RECLAIM','BREAKOUT_RETEST','RANGE_REJECTION',
  'MOMENTUM_CONTINUATION','COMPRESSION_BREAKOUT','FAILED_BREAKOUT','SESSION_BREAK','BOS_PULLBACK'));
