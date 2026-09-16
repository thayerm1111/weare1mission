# GENX 3.0 — XAUUSD scalping engine

Strategy `GENX_3_0`, version `3.0.0`. Code: `src/lib/genx3/`. Worker loop: `worker/index.ts` (`genx3Loop`, lock `flow_manage_lock` id 3). Tables: `genx3_*` (migrations `20260916050000`, `20260916050100`).

GENX 2.0 is retired: with `GENX_ENGINE` unset or `genx3`, the 5-min scan, fast watch, owner levels and every placement without `origin: "genx3"` are refused.

## How it decides (plain English)

Once per closed 5-minute candle (within 90 s of the close):

1. **Data check.** Use only closed 1-minute bars from Twelve Data (UTC). Build 5m/15m/1h/4h bars from them. If the newest bar is older than 150 s, there are gaps, spikes, or the live tick disagrees by more than $3 → **no trade**.
2. **Market type.** Classify 15m/1h as trend up, trend down, orderly range, compression, breakout expansion, disordered or transition. Disordered, transition, or confidence < 55 → **no trade**.
3. **Setups.** Four playbooks, all on confirmed (non-repainting) structure:
   - A: trend pullback (38–75% retrace, 5m break back in trend direction)
   - B: sweep and reclaim of prior-day / Asia / range high or low
   - C: compression breakout, retest of the box edge
   - D: rejection at an orderly range edge
4. **Trade plan.** Stop beyond the invalidation + 0.1×ATR + spread ($1.50–$10). Target at the next significant opposing level ($3–$10). Gross R:R ≥ 1.5, net of costs ≥ 1.25.
5. **Score 0–100** from 11 visible components minus contradictions. Must be ≥ 65.
6. **News.** USD high-impact within 30 min before / 15 min after → no trade. If the calendar cannot be read → no trade.
7. **Publish** one immutable signal (limit zone, stop, target, 15-min expiry, idempotency key). Every decision, including "no trade" and its reasons, is stored in `genx3_decisions`.

Never: averaging down, martingale, grid, widening a stop, trading on forming candles, LLM order authority.

## Flow contract

GENX 3.0 decides *what*; Flow decides *who and how much*. `deliver()` calls the existing `placeGenxGold` then `placeGenxFollower` with `origin: "genx3"`, `onlyUserIds` (scope) and `tag: genx3:<id>`. Every Flow rule stays in force: kill switches, per-account risk %, sizing caps, one gold position per account, reservations, loss-streak pauses, chase and stop caps, news holds, management (BE, partials, trail). GENX 3.0 skips only the GENX 2.0 quality gate. Results per account land in `genx3_deliveries`.

## Modes (`genx3_control.mode`)

| Mode | Behaviour |
|---|---|
| OFF | Engine idle |
| MONITOR | Decides and records signals (`NOT_DELIVERED_MONITOR`); no orders |
| LIVE | Publishes, Telegram, delivers through Flow to the scope |
| EMERGENCY_DISABLED | Set automatically on a safety fault; needs a human to clear |

REPLAY / BACKTEST: `npx tsx scripts/genx3-replay.ts bars.json [from] [to]` — same `analyze()`.

Scope (`live_scope`): `designated` = only `designated_user_ids` (empty list blocks delivery); `authorized` = accounts already opted in to GENX in Flow.

## Runbook

```sql
-- Watch it think
select decision_candle_close, regime, signal_id, no_trade_reasons from genx3_decisions order by decision_candle_close desc limit 20;
select * from genx3_signals order by created_at desc limit 5;
select * from genx3_deliveries order by created_at desc limit 20;
select * from genx3_incidents order by created_at desc limit 20;
select * from flow_heartbeat where component = 'genx3';

-- Go live on the designated account
update genx3_control set designated_user_ids = array['<user uuid>']::uuid[], live_scope = 'designated', mode = 'LIVE' where id = 1;
update flow_switches set genx_enabled = true;   -- Flow's global GENX switch

-- Widen to all opted-in accounts
update genx3_control set live_scope = 'authorized' where id = 1;

-- KILL SWITCH (either stops new orders immediately)
update genx3_control set mode = 'OFF' where id = 1;
update flow_switches set genx_enabled = false;
```

Open positions keep being managed by Flow after a kill.

**Automatic emergency disable** (mode → `EMERGENCY_DISABLED`, incident row, admin Telegram): two placements on one account for one signal; a placement outside scope; strategy version mismatch between DB and worker.

**Fail-closed without disabling:** stale/invalid data, insufficient history, news unknown, invalid signal schema, a signal older than 120 s, a delivery already claimed (`genx3_claim_delivery`).

**Rollback to GENX 2.0:** set `GENX_ENGINE=genx2` on Railway and Vercel and redeploy. Or revert the GENX 3.0 commit. The `genx3_*` tables are additive and can stay.

## Environment variables

| Name | Where | Default | Purpose |
|---|---|---|---|
| `GENX_ENGINE` | Railway + Vercel | `genx3` | `genx2` = rollback |
| `TWELVEDATA_API_KEY` | both | — | Market data |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | both (server only) | — | DB |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID` | both | — | Signal / incident messages |
| `FLOW_ENC_KEY` | both | — | Broker credentials (Flow) |

Strategy parameters live in `src/lib/genx3/config.ts` (versioned, validated at start); they are not env-tunable on purpose.

## Database safety (tested)

Setups move forward only; publish only from TRIGGERED; terminal states frozen; one signal per setup; idempotency key unique; stop/target immutable and on the correct side; delivery claimed once; one delivery row per signal+account; every transition logged.

## Honest risk statement

Replay on ~5 weeks of 1-minute data (Aug 8 – Sep 16 2026) produced very few trades (7–15 per period) and **no evidence of an edge** (profit factor 0.47–0.77). Samples are far too small to conclude anything either way. GENX 3.0 is not proven and not guaranteed to be profitable. Its value today is discipline: it trades rarely, fails closed, never duplicates, and records why. Parameters should only change as a new version after a meaningful sample, reviewed in `genx3_trade_reviews` / `genx3_recommendations`.

Known limits: no bid/ask from the data provider (spread is an estimate); ForexFactory feed only covers the current week; Vercel env cannot be edited from this tooling.
