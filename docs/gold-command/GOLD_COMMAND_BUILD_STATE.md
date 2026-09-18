# COMMAND CENTER XAUUSD — BUILD STATE

**Audited:** 2026-09-18 · **Repo HEAD:** d702d6c · **Auditor:** Claude (Opus 5)

This document is the honest scoreboard. It is updated on every build session. Nothing is marked DONE
because it was written — only because it runs in production and has been observed working.

## What already exists (reusable)

The desk is not a blank page. 525 TypeScript files, a live worker, 200+ connected broker accounts and two
years of gold candles already run today under the GENX / FLOW names.

| Spec component | Exists today as | State |
| --- | --- | --- |
| Market data ingestion | `src/lib/marketData.ts` (Twelve Data), `worker/priceStream.ts` (WS ticks), `genx_candle_archive` (869,148 1-min bars, Sep 2024→) | **REUSE** |
| Candle engine | `src/lib/genx3/candles.ts`, `candleFeatures.ts` | REUSE |
| Structure engine | `src/lib/genx3/structure.ts` (pivots, swing state, boxes, sweep/reclaim) | REUSE |
| Regime engine | `src/lib/genx3/regime.ts` | REUSE, needs the spec's fuller regime set |
| Levels | `src/lib/genx3/levels.ts`, `flow/ownerLevels.ts` (manual trader levels already supported) | REUSE |
| News engine | `src/lib/news/calendar.ts`, `genx3/news.ts` | REUSE, needs reaction measurement |
| Change of character | `src/lib/genx/choch.ts` (5-min structure flip, shared by entry gate + profit guard) | PARTIAL — horizon-aware version missing |
| Strategy library | `genx3/playbooks.ts`, `genx/styles/detectors.ts` (Rapid / Structure / Swing) | PARTIAL — 3 of ~25 strategies |
| Quant layer | `src/lib/genx/quant/` (11 features, path labels, logistic model, expectancy gate) | NEW, not yet wired to entries |
| Risk engine | `src/lib/flow/sizing.ts`, `validation.ts`, `decision.ts`, `autoExec.ts` gates | PARTIAL — see gaps |
| Execution engine | `src/lib/flow/executor.ts`, `tradelocker.ts` (scheduler, priority, relays) | REUSE |
| Idempotency | `flow_place_claims`, `flow_partial_operations`, `genx_follower_fills` unique keys | REUSE |
| Position manager | `src/lib/flow/flowManage.ts` (BE, partials, trail, TP self-heal, reconciliation) | REUSE |
| Profit guard | `src/lib/flow/profitGuard.ts` (reversal → stop snap, opt-in per account) | REUSE |
| Member controls | `src/lib/flow/memberManage.ts` (close / partial / BE+5 from the card) | REUSE |
| Reconciliation | `flowManage` gone-detection + `flow/recover.ts` orphan adoption | REUSE |
| Audit trail | `flow_trade_log` (48,496 rows), `flow_auto_events` (18,437), `flow_incidents` | PARTIAL — no model/strategy version columns |
| Multi-user | Supabase auth, `flow_broker_connections` (263), `flow_broker_accounts` (433), RLS on every table | REUSE |
| Credentials | `src/lib/flow/crypto.ts` — encrypted refresh tokens, server-side only | REUSE |
| Kill switch | `flow_switches` (global), per-account `autotrade_enabled` | PARTIAL — no per-account one-click kill |
| Infrastructure | Vercel (Next.js app), Railway (`weare1mission` worker + `relay-eu` + `relay-b`), Supabase, GitHub | REUSE |

## Gaps against this specification

Ranked by what blocks the most downstream work.

1. **Execution state machine is implicit.** States live across `genx_alerts.state`,
   `flow_managed_positions.status` and log rows. The spec's 16-state machine (ANALYZING → … →
   RECONCILIATION REQUIRED) needs one persisted table and one transition function.
2. **No trade thesis object.** Trades carry levels, not a stored thesis with expected behaviour and
   invalidation. Without it, "is the original reason still true?" cannot be answered mechanically.
3. **No position health score.** Profit guard acts on one signal (structure flip). The spec wants a
   continuous score with attributable reasons.
4. **Risk engine is per-trade, not per-account-per-day.** Missing: max total open risk, daily loss,
   daily drawdown, weekly loss, max trades per session, prop-firm constraint objects.
5. **Trading modes are not separately tuned.** Scalp/intraday/swing differ in target size, not in
   management behaviour. Time-based failure does not exist.
6. **No per-account granular permissions.** One `autotrade_enabled` flag covers entry, closing,
   partials, stop moves. The spec wants ~11 independent permissions.
7. **No feed divergence guard.** TradeLocker and Twelve Data prices are never compared; the 09-18
   incident (entry recorded 80 pips from the signal zone) would have been caught by one.
8. **Learning is manual.** Outcomes are stored; nothing evaluates entry quality, BE timing, partial
   value or exit quality, and no candidate/shadow model promotion path exists.
9. **No replay.** `genx3/replay.ts` is a stub.
10. **No voice, no War Room, no Teach Mode.**

## Known live defects (open)

- **Entry slippage vs signal zone.** 09-18 15:05 sell: zone 4360.62–4362.30, recorded entry 4352.75
  (−223 pips). Root cause not yet confirmed; suspect the chase guard is evaluated against a stale quote.
- **TradeLocker IP rate limiting.** Mitigated by 3-exit relay pool; the developer API key is still not set
  (`TL_DEVELOPER_API_KEY` absent on Railway).
- **Duplicate ledger rows** from repeated orphan adoption — fixed 09-18, watch for recurrence.

## Phase status

| Phase | State |
| --- | --- |
| 1 Audit | **DONE** (this document) |
| 2 Documents | **DONE** — 9 documents in `docs/gold-command/` |
| 3 User + account system | PARTIAL — auth, connections, accounts exist; permissions + kill switch missing |
| 4 Market data | PARTIAL — ingestion + archive exist; divergence + health policy missing |
| 5 Intelligence | PARTIAL — structure/regime/levels/news exist; pressure + scenario engines missing |
| 6 The BRAIN | PARTIAL — conversational layer exists (`/api/genx`); no structured MarketSnapshot contract |
| 7 Strategies | PARTIAL — 3 styles in shadow |
| 8 Risk engine | PARTIAL |
| 9 Execution engine | MOSTLY DONE |
| 10 Position manager | PARTIAL |
| 11 User control | PARTIAL — member controls shipped 09-17 |
| 12 Trading modes | NOT STARTED (as separately tuned behaviour) |
| 13 Teach mode | NOT STARTED |
| 14 UI | PARTIAL — Floor, live trade card, FLOW panel |
| 15 Voice | NOT STARTED |
| 16 Learning | NOT STARTED |
| 17 Replay | NOT STARTED |
| 18 Testing | PARTIAL — 188 unit tests, no execution integration suite |
