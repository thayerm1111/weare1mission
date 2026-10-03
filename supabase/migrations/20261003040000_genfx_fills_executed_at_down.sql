-- Reverses 20261003040000_genfx_fills_executed_at.sql. Not applied anywhere; kept so the change can be undone by hand.
-- Roll the code back first: the books pass writes this column.
alter table public.genfx_fills drop column if exists executed_at;
