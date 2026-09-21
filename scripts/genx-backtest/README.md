# GENX 1.0 replay

1. Export 5-minute XAU/USD bars from `genx_candle_archive` as `[[epoch, o, h, l, c], ...]` (bars5_2y.json).
2. `npx tsx scripts/genx-backtest/signals.ts bars5_2y.json <from> <to> sig_N.jsonl` — runs the live
   engine (runEngine + buildGenx, quick mode, GENX2 flags off) on every closed 5-minute bar.
3. `python3 grid.py` — replays each call's lifecycle (touch/confirm entry, invalidation, same-setup
   dedupe, stop/TP1 grading) and compares filters with a first-year / second-year split.

Paths in the Python files point at /tmp/claude-0/bt; edit them for your machine.
09-21 result: all calls ≈ −0.02R/trade; 1h EMA 20/50/200 stacked + core ≈ +0.14R (year 1),
+0.05R (year 2) before costs, 8/9 quarters positive. See src/lib/genx/trendGate.ts.

## Range fade (sideways-market strategy, 09-21)

`range_fade.py <bars5.json>` replays `src/lib/genx/rangeFade.ts` on 5m bars. Live settings:
`dict(BASE, lookback=288, band=0.10)`, then skip New York hours (UTC 12–22) and stops outside $3–$15.
The TypeScript detector was checked against this script bar-for-bar (3,214 of 3,214 signals identical
with the regime filter off). Replay, 0.35 spread charged: year 1 49 trades +0.35R/trade, year 2 59 trades
+0.36R/trade, 7/9 quarters positive. Without the regime filter: −0.19R/trade year 1. Not proven.
