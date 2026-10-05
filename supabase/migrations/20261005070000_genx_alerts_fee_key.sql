-- GENX: one idea, one setup fee (src/lib/genx/setupFee.ts).
--
-- To be applied to production BEFORE the code that writes it is deployed. Additive: one nullable column,
-- no default, no backfill, no index — nothing existing reads it.
--
-- A member pays 1 credit when a setup they are armed for starts forming, once per setup key. The key is
-- the zone rounded to the dollar, and the zone drifts a dollar every scan, so one idea was billed again
-- and again while it was still on the desk (5,006 of the 10,995 setup credits charged from 09-18 to
-- 10-05). A re-reading of a setup that is still on the desk is now billed under the key of that setup's
-- first reading. `fee_key` is the key a row's setup fee was charged under: its own dedupe_key for the
-- first reading of an idea, the first reading's key for a re-reading. Null on rows written before this
-- column; every one of those was billed under its own key.
--   what a member paid for:  flow_billing_events.event_key = 'setup:' || genx_alerts.fee_key
set local lock_timeout = '5s';
alter table public.genx_alerts add column if not exists fee_key text;
comment on column public.genx_alerts.fee_key is 'The key this setup''s forming fee was billed under: its own dedupe_key for the first reading of an idea, or the dedupe_key of the first reading it is a re-reading of (src/lib/genx/setupFee.ts). Null on rows from before 2026-10-05, which were all billed under their own key.';
