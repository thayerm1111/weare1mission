# GENX 3.2.2 — PDH_PDL_BREAK_RETEST_CONTINUATION

Pre-registered on 2026-09-16 BEFORE any replay of the module. Thresholds are in `src/lib/genx3/v32/pdhpdl.ts` (`PD`)
and `CONFIG32.rules.PDH_PDL_BREAK_RETEST_CONTINUATION`. They were set from market-structure rationale and are not tuned on history.

## What changed
- 3.2.2 = 3.2.1 + one additional, stateful setup module. All 3.2.1 setups, thresholds, arbitration, safety and
  Flow rules are unchanged. Deployment scope unchanged: only accounts 803349 and 772642 (genx3_control whitelist).
- Sequence: IDLE → APPROACHING → LEVEL_BROKEN → WAITING_FOR_ACCEPTANCE → BREAKOUT_ACCEPTED → WAITING_FOR_RETEST →
  RETEST_IN_PROGRESS → RETEST_DEFENDED → ENTRY_ARMED → ENTRY, with FAILED (SWEEP / WEAK_BREAKOUT / BREAKOUT_FAILED /
  RETEST_FAILED / EXTENDED) and EXPIRED exits. PDL is the exact mirror.
- Levels: broker trading day (NY 17:00 → 17:00) previous-day high/low. Room/targets use the existing context levels
  (1H swings, Asia/London highs/lows); ATR5/ATR15, series, finish(), hard checks and arbitration are reused.
- State: pure function of today's closed 1m bars; advanced incrementally; rebuilt identically after a restart.
  Every machine (transitions, evidence, rejection reason) is persisted to `genx3_pd_setups`.
- Duplicates: one ENTRY per level per trading day (max 3 break cycles), stable anchor
  `PD32:<level>:<side>:<day>:c<cycle>` deduplicated through `seen` (reloaded from DB) + signal idempotency key.

## Pre-registered go-live rule (decided before the replay is run)
The module goes LIVE on the two whitelisted accounts only if, in the one-shot 18.5-month diagnostic replay:
1. its own (shadow) trades have positive expectancy after costs, n ≥ 40; and
2. the combined 3.2.2 portfolio replay (with it LIVE, through arbitration and Flow gates) is not worse than
   3.2.1 in expectancy per trade and total R.
Otherwise it deploys in SHADOW: evaluated and fully logged every minute, outcome-tracked, never sent to Flow.
The history has been used for earlier selection, so a pass is weak evidence; it does not prove the setup.
