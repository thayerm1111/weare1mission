# GENX 1.0 replay

1. Export 5-minute XAU/USD bars from `genx_candle_archive` as `[[epoch, o, h, l, c], ...]` (bars5_2y.json).
2. `npx tsx scripts/genx-backtest/signals.ts bars5_2y.json <from> <to> sig_N.jsonl` — runs the live
   engine (runEngine + buildGenx, quick mode, GENX2 flags off) on every closed 5-minute bar.
3. `python3 grid.py` — replays each call's lifecycle (touch/confirm entry, invalidation, same-setup
   dedupe, stop/TP1 grading) and compares filters with a first-year / second-year split.

Paths in the Python files point at /tmp/claude-0/bt; edit them for your machine.
09-21 result: all calls ≈ −0.02R/trade; 1h EMA 20/50/200 stacked + core ≈ +0.14R (year 1),
+0.05R (year 2) before costs, 8/9 quarters positive. See src/lib/genx/trendGate.ts.
