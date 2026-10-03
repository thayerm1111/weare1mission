-- GEN FX: a setup that comes straight back is not billed as a new heads-up.
--
-- Applied to production 2026-10-03 as migration `genfx_fee_key`.
--
-- A scanner setup that is let go (its five minutes ran out, a candle closed through it) is often read
-- again a scan or two later, a pip away. It is recorded and traded like any other — but it is the same
-- idea the members were told about minutes ago. Its row carries the FIRST setup's fee key, so the
-- heads-up fee (when credits are on) is taken once per idea, not once per re-reading of it
-- (src/lib/genfx/scan.ts, findRecall). Null on rows written before this; they bill under their own key.
set local lock_timeout = '5s';
alter table public.genfx_alerts add column if not exists fee_key text;
comment on column public.genfx_alerts.fee_key is 'The key this setup''s heads-up fee is billed under: its own dedupe_key, or the key of the setup it is a return of (let go less than half an hour earlier). Null on rows written before 2026-10-03.';
