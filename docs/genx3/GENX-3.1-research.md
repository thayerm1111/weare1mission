# GENX 3.1 — research log (09-16)

## Data
- XAU/USD 1-minute bars, Twelve Data, 2025-02 → 2026-09-16 (726,856 bars). The archive was backfilled for this study; it previously held only 35 days.
- Weekend and daily-break quotes were removed (570,294 tradable bars). The earlier 5-week GENX 3.0 test included those non-tradable bars.
- Fixed partitions:
  - **Development:** 2025-03 → 2025-12
  - **Validation:** 2026-01 → 2026-04
  - **Holdout:** 2026-05 → 2026-09-16
- The periods cover a strong bull trend, a −11% month (2026-03), a −12% month (2026-06), and 15-minute ranges from $2 to $18.
- Caveats: the 2026-08/09 stretch had been seen earlier in the 5-week test. The holdout was used once for the first 3.1 candidate, then again in walk-forward.

## Simulation
The same engine code runs in production and in replay (`src/lib/genx3/v31`).

- **Decisions:** only on closed bars.
- **Entry:** next-minute limit at the signal zone ±$1, which is Flow's chase cap.
- **Resting orders:** cancelled after 3 minutes, as Flow does.
- **Latency:** 1 minute.
- **Costs:** $0.50 per trade (spread and slippage).
- **Stops:**
  - Capped at $10, Flow's 100-pip cap.
  - A stop hit on a gap fills at the bar open.
  - A bar that touches both stop and target counts as a loss.
- **Position limits:** one position at a time.
- **Flow rules modelled:**
  - Two strike-outs on a side pause that side 2 hours.
  - After a win: 15-minute pause, then 90 minutes premium-only.
  - No entries during the reopen blackout (16:45–19:00 New York).
  - No entries in the last hour before the Friday close or the first hour after the Sunday open.
- **Exits:** stop or target, with a 24-hour cap ("play out").
- **Results unit:** R, the planned signal risk.
- **Not modelled:** news blackouts, Flow break-even/partials/trail, the CHoCH gate, conservative-account gates.

## GENX 3.0 rejection funnel (development period, same analyze())
63,578 analysis cycles.
- **Candidates:** 43,649
  - By playbook: sweep 37,982 · trend pullback 3,942 · range 1,358 · breakout retest 367.
  - By stage: WATCHING 33,343 · APPROACHING 2,363 · ARMED 4,497 · TRIGGERED 3,446.
- **Published:** 418 (448 passed every gate).
- **Blocked before playbooks:** regime (TRANSITION, low confidence or disordered) on 32,746 cycles; data invalid on 7,821.
- **Triggered setups, by gate:** each was simulated as if taken, in R after costs.

| Gate | Rejected | Share of triggered | Hypothetical exp (R) | Verdict |
|---|---|---|---|---|
| gross R:R < 1.5 | 860 | 25% | −0.06 | not hiding winners |
| opposing structure blocks target | 805 | 23% | −0.17 | correct to reject |
| stop > $10 | 745 | 22% | −0.10 | correct to reject |
| score < 65 | 358 | 10% | −0.05 | neutral |
| target < min | 112 | 3% | −0.03 to −0.28 | correct |
| stop < min | 27 | 1% | −1.17 | correct |
| **passed → published** | 446 | 13% | **−0.11** | **the entries themselves had no edge** |

**Diagnosis**
- **Too few trades:** the 15-minute regime gate blocked 52% of cycles, and 3 of 4 playbooks could only fire inside a matching regime.
- **Losing money:** every trigger family was about break-even before costs. The $0.50 cost is 0.1–0.2R.
- **Filters:** loosening them would have added losing trades, not winners.

## Candidate census (GENX 3.1 Stage 1, development period, 8,195 unique setups, 1.5R, after costs)
Every playbook was negative or flat unconditionally:
- trend pullback −0.07
- momentum −0.23
- sweep −0.15
- range −0.15
- compression −0.03
- retest −0.20
- failed breakout −0.15
- BOS pullback −0.25
- session break +0.04

Pre-cost expectancy was about zero everywhere, with no hour-of-day effect. Sells lost in every bucket in development, which was a strong bull market. Opening-range breakouts and fades at London/NY/COMEX opens were also tested; none was consistent.

## Experiment table (portfolio replay with Flow rules)
| Version | Change | DEV n · /wk · exp · PF · maxDD | VAL | HOLDOUT | Decision |
|---|---|---|---|---|---|
| 3.0.0 | as deployed | 259 · 5.9 · −0.08R · 0.90 · 41R | 42 · 2.5 · +0.28R · 1.45 · 8R | 101 · 5.2 · −0.21R · 0.73 · 24R | replaced |
| 3.1-open | all 9 playbooks, no filters, 1.5R | ~54/wk · −0.09R | — | — | rejected (costs dominate) |
| 3.1-C | trend families + HTF, 4R | 576 · 13.3 · +0.12R | 138 · 8.0 · −0.32R | — | rejected (fails validation) |
| 3.1-rc1 | momentum + session + compression + retest, 1H-aligned, 4R, stop ≥0.5 ATR15 | 312 · 7.2 · +0.34R · 1.39 · 32R | 67 · 3.9 · +0.28R · 1.33 · 15R | 172 · 8.7 · **−0.16R · 0.82** · 39R | **rejected — negative on holdout** (compression −0.41R, momentum −0.27R) |
| walk-forward | re-select among 108 configs monthly on the prior 6–9 months | OOS (Aug-25→Sep-26): n 108–191 · −0.06 to +0.07R · PF 0.93–1.09 | | | selection procedure shows no reliable edge |
| **3.1.0** | **session break + BOS first pullback, 2 of 3 HTF agree, 4R, stop 0.5 ATR15–$10** | 127 · 2.9 · +0.13R · 1.15 · 19R | 32 · 1.9 · +0.22R · 1.30 · 12R | 50 · 2.5 · +0.31R · 1.43 · 8R | **deployed to the owner's account only** |

**3.1.0 across all 18.5 months**
- **Headline:** 209 trades, 2.6 per week, 25% win rate. Average win +3.9R, average loss −1.08R.
- **Expectancy:** +0.18R (t≈1.2), profit factor 1.23, max drawdown 21.8R, longest losing streak 15.
- **Cost stress:**
  - $0.80 cost: +0.11R.
  - $1.00 cost: +0.07R.
  - 3-minute latency: +0.15R.
- **Concentration:**
  - September 2025 contributed +28R of the +38R net.
  - Only 9 of 19 months were positive.

**Honest status:** 3.1.0 is the only combination that stayed positive in all three periods. It was chosen after seeing them, among 108 configurations. Its edge is not statistically established, and it depends heavily on one month. Treat live results as the real test.

## What would change the conclusion
- About 300 live or forward trades at 2–3 per week, which is roughly 2+ years. A faster read needs more instruments or a genuinely new information source (order flow, bid/ask, news timing).
- Real broker spread data. The provider has no bid/ask, so the $0.50 cost is an estimate and the edge disappears near $1.00.
