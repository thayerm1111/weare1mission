-- Reverses 20261005070000_genx_alerts_fee_key.sql. Not applied anywhere; kept so the change can be undone by hand.
-- Roll the code back first: the scanner writes this column. (The scanner records a setup without it if the
-- column is missing, so the order only decides whether a fee key is kept, never whether a setup is.)
alter table public.genx_alerts drop column if exists fee_key;
