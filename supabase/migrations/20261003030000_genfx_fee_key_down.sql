-- Reverses 20261003030000_genfx_fee_key.sql. Not applied anywhere; kept so the change can be undone by hand.
-- Roll the code back first: the scanner writes this column.
alter table public.genfx_alerts drop column if exists fee_key;
