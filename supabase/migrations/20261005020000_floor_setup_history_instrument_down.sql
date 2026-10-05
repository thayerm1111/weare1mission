-- Reverses 20261005020000_floor_setup_history_instrument.sql. Not applied anywhere; kept so the change can be undone by hand.
--
-- IF THE CODE IS ROLLED BACK, RUN THE DELETE BELOW STRAIGHT AWAY, even if the column is being kept:
-- the code from before this column lists every row under "Gold Setup · XAUUSD", so stored EUR/USD and
-- GBP/JPY maps would appear in gold's "Past" list (and print as dollars) until they are gone.
delete from public.floor_setup_history where instrument is not null;
-- Then, only once no deployed code filters on the column (/api/floor/setup does):
drop index if exists public.floor_setup_history_instrument_mode_at;
alter table public.floor_setup_history drop column if exists instrument;
