# Replay evidence — `matty_rapid_v1`

Run: `npm run rapid-replay` · 25 September 2026 · config `matty_rapid_v1.cfg.1`.

**Verdict: INCONCLUSIVE.** Positive point estimate, confidence interval spanning zero, and a
validation period that lost money while the held-out periods made it. This is not a profitability
claim in either direction, and it is not a reason to switch the feature on.

## Coverage, stated honestly

| | |
|---|---|
| Instrument | XAUUSD |
| Source | `genx_candle_archive`, 1-minute OHLC, aggregated to 5-minute |
| Sampled | **26,605 closed M5 bars ≈ 92 trading days ≈ 4.5 months of market time** |
| Available but not used | the full archive is **879,168** 1-minute bars, 2024-09-10 → 2026-09-25 |
| Windows | 5, spanning Oct 2024 → Aug 2026 |
| Integrity | every window's payload md5 verified against the database checksum before use |
| Split | chronological — dev (Oct 2024, Jan 2025), validation (May 2025), holdout (Apr 2026, Aug 2026) |
| Parameters | frozen in `config/defaults.ts` before the run; not touched afterwards |

**What this data cannot answer.** The archive has no bid/ask, so the spread is an assumption
($0.35 base, $0.80 tested) rather than a measurement, and there is no way to know whether a bar's
high or low came first. A bar touching both the entry and the stop is **ambiguous**; every one is
resolved **adversely** and counted (5 of 290 trades). Queue position, rejects and requotes are a
slippage allowance, not a simulation.

**One bug this harness caught in itself.** The first run filled on the same bar whose close produced
the signal — look-ahead, which let the engine buy a low it could not yet know was a low. One window
showed a 45% win rate and a 5.7 profit factor. After the fix (earliest fill is the *next* bar, and a
bar that opens beyond the band is a gap, not an entry) that window reads 31% and 1.98. Every number
below is post-fix.

## Results, management ON

| Window | Phase | Trades | Net R | Expectancy | 95% CI | Win | PF | Max DD |
|---|---|---|---|---|---|---|---|---|
| w1 2024-10 | dev | 34 | −8.82 | −0.260 | −0.68 to 0.16 | 8.8% | 0.50 | −14.2R |
| w2 2025-01 | dev | 72 | +4.23 | +0.059 | −0.31 to 0.43 | 13.9% | 1.15 | −13.8R |
| w3 2025-05 | validation | 68 | −15.54 | −0.229 | −0.50 to 0.04 | 14.7% | 0.57 | −18.2R |
| w4 2026-04 | holdout | 64 | **+27.48** | +0.429 | −0.06 to 0.92 | 31.3% | 1.98 | −5.0R |
| w5 2026-08 | holdout | 52 | +11.09 | +0.213 | −0.29 to 0.72 | 32.7% | 1.41 | −8.7R |
| **All** | | **290** | **+18.44** | **+0.064** | **−0.125 to 0.252** | | | |

By phase: dev −0.043R, validation **−0.229R**, holdout +0.333R. A strategy whose validation period
is the worst of the three and whose holdout is the best has not demonstrated anything except
variance. 290 trades is not enough for that interval to mean much.

## Management ON versus OFF

| Window | ON net R | OFF net R | ON win | OFF win |
|---|---|---|---|---|
| w1 2024-10 | −8.82 | −2.37 | 8.8% | 25.0% |
| w2 2025-01 | +4.23 | −7.88 | 13.9% | 25.5% |
| w3 2025-05 | −15.54 | −23.09 | 14.7% | 18.8% |
| w4 2026-04 | +27.48 | +23.55 | 31.3% | 38.7% |
| w5 2026-08 | +11.09 | +9.29 | 32.7% | 37.3% |

Management helps on net in four of five windows — but look at what it does to the win rate. It is
buying a lower drawdown with a lot of scratches: **94 of 290 trades exit at breakeven**, and the win
rate roughly halves everywhere it is on.

## Sensitivity

| Variation | Trades | Net R | Expectancy |
|---|---|---|---|
| spread 0.35 (base) | 159 | +15.28 | +0.096 |
| spread 0.80 (the ceiling) | 123 | +14.25 | +0.116 |
| **breakeven off, everything else on** | **138** | **+24.88** | **+0.180** |
| stop cap 6 instead of 10 | 140 | +12.78 | +0.091 |

*(sampled every 4th bar, so trade counts are lower than the main run.)*

**The breakeven trigger is the single biggest drag in the system.** Turning it off — while keeping
the trail and the structural exit — nearly doubles expectancy. The mechanism is visible in the
numbers: the trigger is `max($3, 0.5 × stop, 0.35 × ATR)`, which for a typical $3–4 structural stop
fires at **$3**, while the median favourable excursion is **$2.80–$5.01**. The stop is being pulled
to entry at roughly the point where half these trades make their high, and then price comes back
through it. This is the same failure the previous system had, arrived at independently.

A wider spread barely hurts, because the cost filter simply refuses more trades — the engine gets
more selective rather than worse. Tightening the stop cap to $6 makes things worse, not better.

## The rejection funnel

Aggregated across all windows, the reasons a candidate did not become a trade:

| Code | Share | What it means |
|---|---|---|
| `target_room_short` | ~55% | The dominant filter by a wide margin. There is very often less than $5 of clear room to the next opposing level. |
| `stop_too_wide` | ~15% | The structurally correct stop exceeded the $10 cap, so the setup was skipped rather than compressed. |
| `no_zone` | ~12% | No eligible level on the relevant side. |
| `regime_conflict` | ~6% | Local structure was sideways, so no trend pullback. |
| `expired` / `opposite_break` | ~8% | An armed retest timed out or was cancelled. |
| `band_not_touched` | ~3% | The candidate never came back into its band on the next bar. |

`target_room_short` dominating is worth thinking about: the $5 minimum target, combined with a level
map dense enough to keep finding opposing structure, rejects the majority of candidates. That is
either correct discipline or a definition of "meaningful obstacle" that is too generous. The replay
cannot tell which.

## By family

`break_retest` produced 239 of 290 trades and almost all of the P&L. `trend_pullback` produced 47
and was negative in the dev and validation periods, positive in the holdout. **`range_reaction`
produced 4 trades in 92 days** — the range validator is so strict that the family Matthew described
first is effectively not running. That is a finding about the implementation, not about the method.

## What would make this conclusive

1. Run the **full 879k-bar archive**, not a 26k sample. The extraction SQL is in
   `rapid/research/loader.ts`; each window is checksum-verified on ingest.
2. Get **bid/ask tick data**, or accept that intrabar sequencing stays unverifiable.
3. Measure the **real spread** on the account that would trade it.
4. Investigate the breakeven trigger and the range validator as the two clearest defects — and
   change them in a **new config version**, evaluated on periods that were not used to find them.
