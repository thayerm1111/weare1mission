-- The Floor's setup card can show EUR/USD and GBP/JPY as well as gold (owner 10-04: "page through
-- here to GBPJPY, and EURUSD as well … just like the GENX").
--
-- Applied to production 2026-10-05 as migration `floor_setup_history_instrument`, before the code that
-- reads it was deployed.
--
-- The card's "Past" button replays the map as it looked earlier, from one stored snapshot per horizon
-- every ten minutes. Those rows never said which market they were of, because there was only gold.
-- `instrument` says so for a currency pair ('EURUSD', 'GBPJPY'). Null is gold: every row written
-- before this column existed, and every gold row written after it. Each market lists only its own.
set local lock_timeout = '5s';
alter table public.floor_setup_history add column if not exists instrument text;
comment on column public.floor_setup_history.instrument is 'Which market this snapshot is of: ''EURUSD'' or ''GBPJPY'' (the GEN FX read). Null is gold (the GENX read).';
create index if not exists floor_setup_history_instrument_mode_at on public.floor_setup_history (instrument, mode, at desc);
