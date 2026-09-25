# Replay evidence — `matty_rapid_v1`

Run: `npm run rapid-replay` · 25 September 2026 · config `matty_rapid_v1.cfg.1`.

**Verdict: INCONCLUSIVE, with a negative point estimate.** Across 315 trades the system returns
−3.22R, expectancy −0.010R/trade, 95% CI −0.176 to +0.156. The interval spans zero and the centre
of it sits just below zero. This is not a profitability claim in either direction, and it is
emphatically not a reason to switch the feature on.

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
resolved **adversely** and counted (5 of 315 trades). Queue position, rejects and requotes are a
slippage allowance, not a simulation.

**Two bugs this harness caught in itself.**

1. *Look-ahead.* The first run filled on the same bar whose close produced the signal, letting the
   engine buy a low it could not yet know was a low. One window showed a 45% win rate and a 5.7
   profit factor. After the fix — earliest fill is the *next* bar, and a bar that opens beyond the
   band is a gap, not an entry — that window reads 31% and 1.98.
2. *Corrupt window timestamps.* Three of the five window files carried `t0` as a slot index rather
   than an epoch, which dated those bars to 1970 and misaligned the session calendar against them.
   Fixing the files moved the headline from **+18.44R / +0.064R** to **−3.22R / −0.010R**. The
   loader now refuses any window whose first timestamp is not a plausible epoch.

Every number below is post-fix for both.

## Results, management ON

| Window | Phase | Trades | Net R | Expectancy | 95% CI | Win | PF | Max DD |
|---|---|---|---|---|---|---|---|---|
| w1 2024-10 | dev | 34 | −8.82 | −0.260 | −0.68 to +0.16 | 8.8% | 0.50 | −14.2R |
| w2 2025-01 | dev | 74 | +8.69 | +0.118 | −0.30 to +0.54 | 14.9% | 1.26 | −15.6R |
| w3 2025-05 | validation | 68 | −14.92 | −0.219 | −0.47 to +0.03 | 14.7% | 0.57 | −17.5R |
| w4 2026-04 | holdout | 87 | +0.74 | +0.009 | −0.27 to +0.28 | 23.0% | 1.02 | −11.1R |
| w5 2026-08 | holdout | 52 | +11.09 | +0.213 | −0.29 to +0.72 | 32.7% | 1.41 | −8.7R |
| **All** | | **315** | **−3.22** | **−0.010** | **−0.176 to +0.156** | | | |

By phase:

| Phase | Trades | Net R | Expectancy | 95% CI |
|---|---|---|---|---|
| dev | 108 | −0.13 | −0.001 | −0.32 to +0.32 |
| validation | 68 | −14.92 | **−0.219** | −0.47 to +0.03 |
| holdout | 139 | +11.83 | +0.085 | −0.17 to +0.34 |

Validation remains the worst of the three phases, and the holdout's edge is carried almost entirely
by one two-week window (w5). Under the corrected timestamps the other holdout window (w4, four
weeks, 87 trades) is flat: +0.74R on 87 trades is noise. A system whose only convincing period is
its shortest one has not demonstrated anything.

## Management ON versus OFF

| Window | ON net R | OFF net R | ON win | OFF win |
|---|---|---|---|---|
| w1 2024-10 | −8.82 | −2.37 | 8.8% | 25.0% |
| w2 2025-01 | +8.69 | −2.39 | 14.9% | 26.3% |
| w3 2025-05 | −14.92 | −18.93 | 14.7% | 21.5% |
| w4 2026-04 | +0.74 | −5.75 | 23.0% | 31.2% |
| w5 2026-08 | +11.09 | +9.29 | 32.7% | 37.3% |

Management helps on net in four of five windows — but look at what it does to the win rate. It is
buying a lower drawdown with a lot of scratches: **99 of 315 trades exit at breakeven**, and the win
rate drops by 8–16 points everywhere it is on.

## Sensitivity

| Variation | Trades | Net R | Expectancy |
|---|---|---|---|
| spread 0.35 (base) | 173 | +11.19 | +0.065 |
| spread 0.80 (the ceiling) | 128 | +3.72 | +0.029 |
| **breakeven off, everything else on** | **153** | **+17.88** | **+0.117** |
| stop cap 6 instead of 10 | 150 | +5.07 | +0.034 |

*(sampled every 4th bar, so trade counts are lower than the main run — read these against each
other, not against the table above.)*

**The breakeven trigger is the single biggest drag in the system.** Turning it off — while keeping
the trail and the structural exit — takes expectancy from +0.065R to +0.117R on the same sample,
and it is the only variation that improves on the base. The mechanism is visible in the numbers:
the trigger is `max($3, 0.5 × stop, 0.35 × ATR)`, which for a typical $3–4 structural stop fires at
**$3**, while the median favourable excursion across windows is **$2.80–$4.13**. The stop is being
pulled to entry at roughly the point where half these trades make their high, and then price comes
back through it. This is the same failure the previous system had, arrived at independently.

A wider spread costs real expectancy here (0.065 → 0.029) even though the cost filter refuses more
trades. Tightening the stop cap to $6 makes things worse, not better.

## The rejection funnel

Aggregated across all five management-ON windows (287,671 refusals):

| Code | Share | What it means |
|---|---|---|
| `target_room_short` | 50.9% | The dominant filter by a wide margin. There is very often less than $5 of clear room to the next opposing level. |
| `stop_too_wide` | 15.8% | The structurally correct stop exceeded the $10 cap, so the setup was skipped rather than compressed. |
| `no_zone` | 12.0% | No eligible level on the relevant side. |
| `expired` | 6.0% | An armed retest timed out. |
| `regime_conflict` | 5.6% | Local structure was sideways, so no trend pullback. |
| `opposite_break` | 3.3% | The armed retest was cancelled by a break the other way. |
| `band_not_touched` | 2.2% | The candidate never came back into its band on the next bar. |
| `arbitration_lost` | 2.1% | A better-ranked setup on the same side won. |
| `session_closed` / `reward_risk_short` / `warmup` | 2.3% | Remainder. |

`target_room_short` dominating is worth thinking about: the $5 minimum target, combined with a level
map dense enough to keep finding opposing structure, rejects half of everything. That is either
correct discipline or a definition of "meaningful obstacle" that is too generous. The replay cannot
tell which.

## By family

| Family | Trades | Net R |
|---|---|---|
| `break_retest` | 267 | +11.28 |
| `trend_pullback` | 47 | −14.51 |
| `range_reaction` | **1** | 0.00 |

`break_retest` is the system; it produced 85% of the trades and all of the positive P&L.
`trend_pullback` lost money over the full sample (−14.51R on 47 trades) and was positive in only
one window. **`range_reaction` fired once in 92 trading days** — the range validator is so strict
that the family Matthew described first is effectively not running. That is a finding about the
implementation, not about the method.

## What would make this conclusive

1. Run the **full 879k-bar archive**, not a 26k sample. The extraction SQL is in
   `rapid/research/loader.ts`; each window is checksum-verified on ingest.
2. Get **bid/ask tick data**, or accept that intrabar sequencing stays unverifiable.
3. Measure the **real spread** on the account that would trade it.
4. Investigate the three clearest defects — the breakeven trigger, the range validator, and
   `trend_pullback`'s negative expectancy — and change them in a **new config version**, evaluated
   on periods that were not used to find them.
