# GENX 1.1 — GENX 1.0 with a trend/chop router

**Owner request (09-16):** "trade the trend but switch to support and resistance during chop … GENX 1.0 is the best to go with." Deploy to accounts 803349 and 772642 first.

**Pre-registered at 2026-09-16T16:39:27Z, before any replay of the router.** These parameters are set from market-structure reasoning, not fitted.

## Market state
Read on 15-minute bars, which GENX 1.0's quick mode calls its "1H" frame. Inputs:
- ADX(14)
- Choppiness Index CI(14) = 100 × log10(ΣTR14 / (max high − min low)) / log10(14)
- Efficiency ER(16)
- SMA20/50 stack

| State | Rule |
|---|---|
| TREND up | ADX ≥ 22, CI < 50, price > SMA20 > SMA50 (mirror for down) |
| CHOP | CI ≥ 58, ADX < 22, ER < 0.30 |
| UNCLEAR | Anything else: no new trades |

**Hysteresis:** the active state changes only when two consecutive 5-minute reads agree.

## Trading by state
**TREND:** GENX 1.0 engine-v1, unchanged (entries, stops, TP1, scoring, READY / DEVELOPING logic). Only its trend strategies in the router's direction are accepted.

**CHOP:** support/resistance engine.
- **Levels (last 3 days of 15m bars):**
  - Swing pivots (k = 2) clustered within 0.35 × ATR15; a level needs ≥ 2 touches at least 2 hours apart.
  - Prior-day high/low.
  - Asian-session high/low once complete.
- **Buy at support (mirror for sell at resistance):**
  - The last closed 5m bar's low is within [level − 0.30 × ATR15, level + 0.25 × ATR15].
  - The bar closes above the level with close location ≥ 0.6 and lower wick ≥ 40% of its range.
  - No 15m close below the level in the last 4 bars.
- **Stop:** below the bar low or the level, whichever is lower, minus 0.25 × ATR15.
- **Target:** the nearest opposing level; skip if it is less than 1.5R away (GENX 1.0's floor).
- **Repeats:** one trade per level per 4 hours.

## Unchanged
- **Execution and safety:** everything from GENX 3.2 — Flow, the account whitelist, one position per account, 2-strike and post-win pauses, entry blackouts, kill switch, version dispatch, decision/candidate/execution logging.
- **Stops:** strategy-based, as in 3.2.1 — no 100-pip cap on these accounts. Corrupt-data bound 0; volatility bound 3.5 × ATR15.
