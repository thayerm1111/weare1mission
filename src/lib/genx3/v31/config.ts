/**
 * GENX 3.1.0 configuration — chosen 09-16 from an 18-month XAUUSD 1m study (see docs/genx3/GENX-3.1-research.md).
 * Enabled: SESSION_BREAK (London open breaks the Asian range / NY open breaks the London range) and
 * BOS_PULLBACK (first pullback after a 5m structure break). Both require 2 of 3 higher-timeframe
 * agreements (1H bias, 4H bias, 20-day momentum), a stop of at least 0.5×ATR15 and at most $10
 * (Flow's 100-pip cap), and target 4R. Every other playbook stays DISABLED: each lost money in at
 * least one of the development / validation / holdout periods after costs.
 * Changing any value = new STRATEGY_VERSION_31 and a new replay.
 */
import type { Stage2Config } from "./stage2";
export const CONFIG31: Stage2Config & { early: boolean } = {
  version: "3.1.0", costUsd: 0.5, minRiskUsd: 1, maxRiskUsd: 10, minNetR: 0.5, minRiskAtr15: 0.5, align: "2of3", early: false,
  rules: {
    TREND_PULLBACK: { enabled: false, minScore: 0, exitR: 4, vol: ["LOW", "NORMAL", "HIGH"], weights: { regimeFit: 1, conf: 1, htf: 1, h4: 1, session: 1 } },
    MOMENTUM_CONTINUATION: { enabled: false, minScore: 0, exitR: 4, vol: ["LOW", "NORMAL", "HIGH"], weights: { regimeFit: 1, conf: 1, htf: 1, h4: 1, session: 1 } },
    SWEEP_RECLAIM: { enabled: false, minScore: 0, exitR: 4, vol: ["LOW", "NORMAL", "HIGH"], weights: { regimeFit: 1, conf: 1, htf: 1, h4: 1, session: 1 } },
    RANGE_REJECTION: { enabled: false, minScore: 0, exitR: 4, vol: ["LOW", "NORMAL", "HIGH"], weights: { regimeFit: 1, conf: 1, htf: 1, h4: 1, session: 1 } },
    COMPRESSION_BREAKOUT: { enabled: false, minScore: 0, exitR: 4, vol: ["LOW", "NORMAL", "HIGH"], weights: { regimeFit: 1, conf: 1, htf: 1, h4: 1, session: 1 } },
    BREAKOUT_RETEST: { enabled: false, minScore: 0, exitR: 4, vol: ["LOW", "NORMAL", "HIGH"], weights: { regimeFit: 1, conf: 1, htf: 1, h4: 1, session: 1 } },
    FAILED_BREAKOUT: { enabled: false, minScore: 0, exitR: 4, vol: ["LOW", "NORMAL", "HIGH"], weights: { regimeFit: 1, conf: 1, htf: 1, h4: 1, session: 1 } },
    SESSION_BREAK: { enabled: true, minScore: 0, exitR: 4, vol: ["LOW", "NORMAL", "HIGH"], weights: { regimeFit: 1, conf: 1, htf: 1, h4: 1, session: 1 } },
    BOS_PULLBACK: { enabled: true, minScore: 0, exitR: 4, vol: ["LOW", "NORMAL", "HIGH"], weights: { regimeFit: 1, conf: 1, htf: 1, h4: 1, session: 1 } },
  },
};
