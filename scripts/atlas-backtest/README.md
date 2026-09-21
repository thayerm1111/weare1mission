# ATLAS setup replay (09-21)

`npx tsx --tsconfig tsconfig.json scripts/atlas-backtest/replay.ts bars5_2y.json <from> <to> out.jsonl`
steps the live pipeline (buildSnapshot → perceive → findSetup, owner profile Quick+Normal, min
confidence 55) over every closed 5m bar and writes each trade-ready setup. `agrade*.py` grade them
(one position at a time, per-style cooldown, stop vs first objective, 0.35 spread cost).

09-21 result (Sep 2024 - Sep 2026): about break-even before costs, -0.06 to -0.16R/trade after;
setups that needed the 0.8:1 relaxation were worse (-0.46R yr1, -0.07R yr2). No management
variant (break-even, partials) or trend/session filter made it positive in both years.
Year-1 sample is small (thresholds are in pips, tuned to current gold prices).
