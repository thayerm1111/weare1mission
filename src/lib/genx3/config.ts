/**
 * GENX 3.0 — versioned, typed strategy configuration. Every threshold carries its unit.
 * Changing any value = a new STRATEGY_VERSION (documented in docs/genx3/CHANGELOG.md).
 */
export const STRATEGY = "GENX_3_0" as const;
export const STRATEGY_VERSION = "3.0.0";

export type Genx3Config = {
  version: string;
  data: {
    maxFeedAgeMs: number;          // ms — newest CLOSED 1m bar must end within this of now
    maxGap1mBars: number;          // bars — missing 1m bars tolerated inside the analysis window
    spikeAtrMultiple: number;      // × ATR15 — a 1m bar range above this is treated as corrupt
    minHistory15m: number;         // bars — required closed 15m bars
    minHistory1h: number;          // bars — required closed 1h bars
    feedDisagreeUsd: number;       // USD — max |live tick − last close| before NO_TRADE
  };
  costs: {
    spreadEstimateUsd: number;     // USD — assumed spread (provider has no bid/ask)
    slippageEstimateUsd: number;   // USD — assumed entry slippage
  };
  structure: {
    pivotLeft15m: number; pivotRight15m: number;   // bars
    pivotLeft5m: number; pivotRight5m: number;     // bars
    atrPeriod: number;             // bars
  };
  regime: {
    efficiencyBars: number;        // 15m bars
    trendEfficiencyMin: number;    // ratio 0..1
    rangeEfficiencyMax: number;    // ratio 0..1
    volRatioDisordered: number;    // ATR5/ATR40
    compressionVolRatioMax: number;
    compressionWidthAtrMax: number; // × ATR40, 16-bar box
    rangeBoxBars: number;          // 15m bars
    rangeWidthAtrMin: number; rangeWidthAtrMax: number; // × ATR15
    breakoutBufferAtr: number;     // × ATR15 beyond the box
    breakoutBodyAtr: number;       // × ATR15 body of the breakout bar
    minConfidence: number;         // 0..100
  };
  trade: {
    minStopUsd: number; maxStopUsd: number;        // USD
    stopBufferAtr: number;         // × ATR15 added beyond structural invalidation (plus spread)
    minTargetUsd: number; maxTargetUsd: number;    // USD
    minGrossRR: number;            // reward ÷ risk
    minNetRR: number;              // after spread + slippage
    zoneWidthAtr: number;          // × ATR5 entry zone width behind the trigger close
    setupTtlMin: number;           // minutes an ARMED setup stays valid
    minScore: number;              // 0..100 publication threshold
    newsBeforeMin: number; newsAfterMin: number;   // minutes
    newsFailClosed: boolean;
  };
};

export const CONFIG: Genx3Config = {
  version: STRATEGY_VERSION,
  data: { maxFeedAgeMs: 150_000, maxGap1mBars: 3, spikeAtrMultiple: 4, minHistory15m: 120, minHistory1h: 60, feedDisagreeUsd: 3 },
  costs: { spreadEstimateUsd: 0.3, slippageEstimateUsd: 0.2 },
  structure: { pivotLeft15m: 3, pivotRight15m: 3, pivotLeft5m: 3, pivotRight5m: 2, atrPeriod: 14 },
  regime: {
    efficiencyBars: 16, trendEfficiencyMin: 0.25, rangeEfficiencyMax: 0.2,
    volRatioDisordered: 2.2, compressionVolRatioMax: 0.75, compressionWidthAtrMax: 2.5,
    rangeBoxBars: 32, rangeWidthAtrMin: 3, rangeWidthAtrMax: 10,
    breakoutBufferAtr: 0.25, breakoutBodyAtr: 0.8, minConfidence: 55,
  },
  trade: {
    minStopUsd: 1.5, maxStopUsd: 10, stopBufferAtr: 0.1,
    minTargetUsd: 3, maxTargetUsd: 10, minGrossRR: 1.5, minNetRR: 1.25,
    zoneWidthAtr: 0.25, setupTtlMin: 15, minScore: 65,
    newsBeforeMin: 30, newsAfterMin: 15, newsFailClosed: true,
  },
};

/** Startup validation — throws on an inconsistent config. */
export function validateConfig(c: Genx3Config = CONFIG): void {
  const bad: string[] = [];
  const pos = (k: string, v: number) => { if (!(Number.isFinite(v) && v > 0)) bad.push(`${k} must be > 0`); };
  pos("data.maxFeedAgeMs", c.data.maxFeedAgeMs);
  pos("trade.minStopUsd", c.trade.minStopUsd);
  if (c.trade.maxStopUsd <= c.trade.minStopUsd) bad.push("trade.maxStopUsd must exceed minStopUsd");
  if (c.trade.maxTargetUsd <= c.trade.minTargetUsd) bad.push("trade.maxTargetUsd must exceed minTargetUsd");
  if (c.trade.minGrossRR < 0.75) bad.push("trade.minGrossRR below Flow's 0.75 entry floor");
  if (c.trade.minScore < 0 || c.trade.minScore > 100) bad.push("trade.minScore must be 0..100");
  if (c.regime.trendEfficiencyMin <= c.regime.rangeEfficiencyMax) bad.push("regime efficiency bands overlap");
  if (c.version !== STRATEGY_VERSION) bad.push("config version != STRATEGY_VERSION");
  if (bad.length) throw new Error(`GENX3 config invalid: ${bad.join("; ")}`);
}
