-- Reverses 20261008005900_flow_partial_record.sql.
set lock_timeout = '5s';
alter table public.flow_managed_positions
  drop column if exists partial_frac,
  drop column if exists partial_px;
reset lock_timeout;
