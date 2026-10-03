-- GEN FX: an order that was seen to execute is never written off.
--
-- Applied to production 2026-10-03 as migration `genfx_fills_executed_at`.
--
-- The books pass (src/lib/genfx/settle.ts) reads the broker afresh on every look. What the broker shows
-- can lag or be unreadable from one look to the next: a part fill seen at one look, its position stopped
-- out before the next, and an order history running behind, left a row with "no trace" that the age rule
-- wrote off — a trade that happened and was never booked. The first look that sees a call's order execute
-- now says so on the row, and from then on the row is settled as a fill or held; never voided.
-- Null: no look has seen it execute.
set local lock_timeout = '5s';
alter table public.genfx_fills add column if not exists executed_at timestamptz;
comment on column public.genfx_fills.executed_at is 'When the books pass first saw this call''s order execute at the broker. Once set the row is never written off as "nothing came of it". Null: not seen to execute.';
