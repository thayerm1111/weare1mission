# POSITION MANAGER — THE LIVE POSITION BRAIN

> A stop loss is the last line of defence. It is not the only reason to exit.

Analysis does not stop at entry. Every open position is re-evaluated against fresh market intelligence, and
the question is always the same: **is the original reason for this trade still true?**

## The trade thesis

Every position stores a thesis at entry, and the thesis is what management is measured against:

```json
{
  "direction": "buy",
  "strategy": "breakout_retest",
  "mode": "intraday",
  "reason": "Previous-day-high breakout with a held retest, 1H bullish, 5M momentum expanding",
  "expected": "Holds above the PDH and continues toward the session high",
  "invalidation": "Sustained 5M acceptance back beneath the reclaimed level with bearish pressure expanding",
  "followThroughWindow": "45m",
  "entryContext": { "regime": "...", "structure": "...", "pressure": 0.0, "volatility": 0.0 }
}
```

## Position health

A continuous 0–100 score, recomputed each pass, with attributable reasons. It summarises; it does not fire
orders by itself. Inputs: structure intact, momentum vs entry, pressure vs entry, level held, follow-through
vs expectation, time in trade vs window, volatility regime change, news proximity, MFE given back.

Every change is recorded with its cause:

```
POSITION HEALTH 76 → 51
5M bullish momentum weakened · price failed twice at the session high ·
bullish pressure 71 → 52 · no structural invalidation yet
```

## Change of Character — horizon-relative

The single most important rule in this document: **CHoCH is evaluated on the trade's own timeframe.**
A 5-minute bearish candle is noise to a swing long and information to a scalp.

| Mode | Structure evaluated on | Reacts to |
| --- | --- | --- |
| Scalp | 1M / 5M | Momentum failure, level loss, stalling |
| Intraday | 5M / 15M / 1H | Structure break, retest failure, pressure flip |
| Swing | 1H / 4H / Daily | Daily structure break, regime change |

Evaluated: structure change · momentum deterioration · velocity reversal · pressure flip · failed
continuation · failed breakout · level loss · retest failure · opposite structural break · rejection ·
acceptance against the trade · correlation shift · news shock · time-based failure · regime change.

## Management ladder

Risk state moves one way only: FULL RISK → REDUCED → BREAK-EVEN → PROTECTED PROFIT → TRAILING.

- **Break-even** lands +5 pips in profit, never at the raw entry — a scratched trade must not cost the
  spread and commission. It requires price genuinely past that level first.
- **Partials** bank a fraction at a measured objective; one lifetime partial per position, reserved durably.
- **Runner** is managed independently once a partial is taken, on structure rather than on ticks.
- **Profit Guard** snaps the stop in behind the market when the structure flips against a real winner
  (≥1R and ≥50 pips). Opt-in per account.

## Time-based failure

Some trades fail by doing nothing. Each strategy declares an expected follow-through window; a scalp that
has not moved 35 minutes after a "momentum breakout" has already failed its own description. Time decay
feeds position health — it does not close trades on its own.

## What the manager must never do

Move a stop because price merely became profitable · close a healthy trade on one red candle ·
hold a thesis-dead trade to the original stop because the stop exists · manage a swing on 1-minute noise ·
reopen a trade the member closed · act on data it knows is stale.

## Every action explains itself

```
Moved stop to break-even (+5 pips).
WHY: price reached +0.82R · the breakout level retested and held ·
a new 5M higher low formed · position health 82/100.
Risk reduced without disturbing the continuation thesis.
```
