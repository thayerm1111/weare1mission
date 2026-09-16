# GENX 3.2.0 — design and deployment record

## Pre-registered rules (written 2026-09-16T06:55:09Z, BEFORE the one diagnostic replay of the new engines)

1. **Parameters were set from rationale, not fitted.** The new engines' parameters, thresholds and weights in `src/lib/genx3/v32/config.ts` come from market-structure reasoning. They are not tuned on history.
2. **History is contaminated.** The 18.5-month history was already used to select 3.1.0, so it is used ONCE for 3.2, as a regression and diagnostic check.
3. **SHADOW gate.** A new engine starts in SHADOW (logged and outcome-tracked, never sent to Flow) only if that one replay shows it clearly negative:
   - expectancy ≤ −0.10R per trade after $0.50 costs, AND
   - t-statistic ≤ −2, AND
   - n ≥ 30.

   Every other engine goes LIVE. No parameter is changed after the replay to rescue an engine.
4. **Baseline untouched.** The 3.1.0 baseline (SESSION_BREAK, BOS_PULLBACK) keeps its code and thresholds unchanged.

## Architecture
The live path, run at every closed minute while XAUUSD is open:

**market data → market state → setup engines → candidates → hard invalidation → setup score → arbitration → signal → Flow → broker**

1. **Market data.** Archive plus Twelve Data REST.
   - When the REST bar is late, the worker builds the just-closed 1m bar from its own streamed ticks (≥4 ticks, first and last within 15s of the minute edges).
   - The decision row records which source was used (`bar_source`).
   - Replay uses provider bars only. This is the one documented live/backtest difference.
2. **Market state** (`v32/state.ts`), from closed bars only. Six states:
   - EXPANSION
   - POST_BREAK_RETRACE
   - COMPRESSION: contracting 12×15m box, falling ATR, realized vol below its 20-day median, and boundary tests on both sides.
   - TRENDING: efficiency plus EMA alignment on 15m or 1H.
   - RANGING
   - TRANSITION

   Inputs: ATR percentile, realized-vol ratio, 15m/1H efficiency, displacement breaks of the 3-hour box and of session, prior-day and 1H swing levels.
3. **Setup engines** (`v32/engines.ts`). Each engine emits CANDIDATES and WAITS with reasons.
   - The 3.1.0 baseline (SESSION_BREAK, BOS_PULLBACK) runs the untouched 3.1 generator and 3.1 Stage 2 at 5m closes. The router does not gate it.
4. **Hard invalidation.** Any one of these blocks a candidate:
   - volatility EXTREME
   - stop above $10 (Flow cap) or below max($1.50, setup-minimum × ATR15)
   - net reward:risk below 1.2 after $0.50 costs
   - structural room below the setup minimum, or below 0.8 × the target
   - engine-specific vetoes: 4H trending against a trend re-entry; momentum already extended
5. **Setup-specific scores and thresholds** (`v32/config.ts`). Components are recorded per candidate.
6. **Arbitration** (deterministic), LIVE engines only:
   1. 3.1 baseline first
   2. then larger margin over the setup's threshold
   3. then setup priority order
   4. then more structural room
   5. then anchor string

   If opposite-side new-engine setups are within 5 points of each other, there is no trade. Every loser is logged as LOST_ARBITRATION.
7. **Flow** (unchanged). Per-account risk, one position per account, reservation, chase cap, stop cap, win/loss pauses, reopen and weekend blackouts, resting-order cancel.
   - A 3.x signal carries `onlyAccountIds`, so Flow drops every other account.
   - A legacy (GENX 1.0) signal skips any account on the 3.x whitelist.

## One-shot diagnostic replay (2025-03 → 2026-09-16, contaminated history — NOT proof)
Same `step32` as production, with Flow execution rules and $0.50 cost.

**Before the gate, all engines LIVE:** 675 trades, 8.4/week, −0.10R per trade, PF 0.87.

| Setup (portfolio) | n | exp R | t | Gate outcome |
|---|---|---|---|---|
| SESSION_BREAK (3.1) | 119 | +0.25 | +1.2 | LIVE (baseline) |
| BOS_PULLBACK (3.1) | 77 | +0.15 | +0.6 | LIVE (baseline) |
| MOMENTUM_EXPANSION | 292 | −0.18 | −2.2 | **SHADOW** (meets gate) |
| MICRO_CONTINUATION | 89 | −0.40 | −2.7 | **SHADOW** (meets gate) |
| BREAKOUT_RETEST_V2 | 39 | −0.28 | −1.0 | LIVE (gate not met: t > −2) |
| COMPRESSION_EXPANSION | 39 | +0.01 | 0.0 | LIVE |
| TREND_REENTRY | 18 | −0.43 | −1.2 | LIVE (n < 30) |
| SWEEP_RECLAIM_DISPLACEMENT | 2 | — | — | LIVE (n < 30) |

**After the gate (as deployed):** 302 trades, 3.8/week, 26% win rate, +0.08R per trade (t 0.7), PF 1.10, max drawdown 28R, longest losing streak 14.

| Period | Result |
|---|---|
| Development | +0.15R |
| Validation | −0.02R |
| Holdout | −0.01R |

For comparison, the 3.1.0 replay showed 2.6/week at +0.18R.

**Honest reading:**
- 3.2 sees more of the market: about +1.2 trades/week from new families.
- None of the new live families shows positive expectancy in this history.
- Breakout-retest and trend re-entry are live only because the pre-registered gate did not have enough evidence to shadow them.
- Live telemetry — real spread, slippage and shadow outcomes — is now the evidence base.

## Rollback
- **Instant, no deploy:** `update genx3_control set strategy_version='3.1.0' where id=1;` The worker dispatches to the unchanged 3.1.0 brain.
- **Code:** git tag `genx-3.1.0` (e29d3e2).
- **Kill switch:** `update genx3_control set mode='OFF' where id=1;`

## New and changed tables
| Table | What it holds |
|---|---|
| `genx3_candidates` | Every candidate and wait: status, reasons, score, threshold, components, market state, higher-timeframe context, entry/stop/target, room, signal id, and the shadow outcome (fill, exit, R, MFE/MAE). |
| `genx3_executions` | Per live order attempt: bid, ask, spread, quote/submit/ack timestamps, limit, qty, risk %, equity, SL/TP, order and position ids, fill price and time, slippage. |
| `genx3_control` | New column `designated_account_ids`. |
| `genx3_decisions` | One row per closed minute for 3.2; `regime_detail` carries state evidence, latency, bar source and what was waiting. |
