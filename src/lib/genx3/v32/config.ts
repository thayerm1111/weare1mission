/**
 * GENX 3.2.0 configuration. Parameters were set from market-structure rationale BEFORE any replay
 * (the 18.5-month history is contaminated for selection — see docs/genx3/GENX-3.2.md). They are NOT
 * tuned on history. Changing a value = new version.
 */
import type { MarketState } from "./state";
import type { Setup32 } from "./engines";

export type SetupRule = {
  mode: "LIVE" | "SHADOW";                // SHADOW = evaluated + logged + outcome-tracked, never sent to Flow
  states: MarketState[] | "ANY";         // market-state routing
  threshold: number;                     // setup-specific score threshold (0..100)
  weights: Record<string, number>;       // setup-specific score model over the engine's features
  minRiskAtr15: number; minRoomR: number;
};
export const STRATEGY_VERSION_32 = "3.2.1";
export const CONFIG32 = {
  version: STRATEGY_VERSION_32, costUsd: 0.5, minRiskUsd: 1.5, minNetRR: 1.2,
  // 3.2.1 (owner 09-16: "remove the stop cap of 100, make the stop based on strategy"): no fixed $10 cap.
  // The stop is the setup's structural invalidation. It is rejected only when it is not a sane
  // structure for current volatility (> maxRiskAtr15 × ATR15) or is corrupt data (> maxRiskUsd).
  maxRiskAtr15: 3.5, maxRiskUsd: 60,
  conflictMargin: 5,                      // opposite-side qualified setups within this score margin → no trade
  priority: ["SESSION_BREAK", "BOS_PULLBACK", "BREAKOUT_RETEST_V2", "COMPRESSION_EXPANSION", "TREND_REENTRY", "MICRO_CONTINUATION", "SWEEP_RECLAIM_DISPLACEMENT", "MOMENTUM_EXPANSION"] as Setup32[],
  rules: {
    // 3.1 baseline — unchanged thresholds (evaluated by the 3.1 Stage 2 exactly as in 3.1.0)
    SESSION_BREAK: { mode: "LIVE", states: "ANY", threshold: 0, weights: {}, minRiskAtr15: 0.5, minRoomR: 0 },
    BOS_PULLBACK: { mode: "LIVE", states: "ANY", threshold: 0, weights: {}, minRiskAtr15: 0.5, minRoomR: 0 },
    MICRO_CONTINUATION: { mode: "SHADOW", states: ["TRENDING", "POST_BREAK_RETRACE"], threshold: 60, minRiskAtr15: 0.35, minRoomR: 2,
      weights: { impulse: 15, depth: 10, control: 15, turn: 10, er: 10, htf1: 15, htf4: 5, room: 10, session: 10 } },
    BREAKOUT_RETEST_V2: { mode: "LIVE", states: ["POST_BREAK_RETRACE", "TRENDING", "EXPANSION", "TRANSITION"], threshold: 60, minRiskAtr15: 0.35, minRoomR: 2,
      weights: { level: 15, acceptance: 15, reject: 15, fresh: 10, htf1: 15, htf4: 5, room: 15, session: 10 } },
    COMPRESSION_EXPANSION: { mode: "LIVE", states: ["COMPRESSION", "EXPANSION", "TRANSITION"], threshold: 60, minRiskAtr15: 0.35, minRoomR: 2,
      weights: { tight: 10, contraction: 15, displacement: 20, tests: 10, expansion: 10, htf1: 10, htf4: 5, room: 15, session: 5 } },
    SWEEP_RECLAIM_DISPLACEMENT: { mode: "LIVE", states: ["RANGING", "TRANSITION", "COMPRESSION", "TRENDING"], threshold: 65, minRiskAtr15: 0.35, minRoomR: 2.5,
      weights: { level: 20, displacement: 20, speed: 10, depth: 10, htf1: 10, htf4: 5, room: 15, session: 10 } },
    TREND_REENTRY: { mode: "LIVE", states: ["TRENDING", "POST_BREAK_RETRACE", "TRANSITION"], threshold: 60, minRiskAtr15: 0.4, minRoomR: 2,
      weights: { er1h: 20, value: 15, turn: 15, h4agree: 10, htf1: 10, room: 20, session: 10 } },
    MOMENTUM_EXPANSION: { mode: "SHADOW", states: ["EXPANSION"], threshold: 65, minRiskAtr15: 0.35, minRoomR: 1.5,
      weights: { expansion: 20, body: 10, velocity: 20, young: 20, htf1: 10, room: 15, session: 5 } },
  } as Record<Setup32, SetupRule>,
};
