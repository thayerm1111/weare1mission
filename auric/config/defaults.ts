/**
 * AURIC — typed strategy configuration.
 *
 * Every number here is an INITIAL HYPOTHESIS, not a proven optimum. The research harness
 * (auric/research/backtest.ts) reads the same object, so what is evaluated is what runs.
 * Live positions keep the version they were opened under (auric_positions.strategy_version).
 */
export const STRATEGY_VERSION = "auric-1.0.0";
export const MANAGEMENT_VERSION = "auric-mgmt-1.0.0";

export type AuricConfig = {
  version: string;
  /** Instrument decimals for decimal-safe arithmetic (verified against the broker spec at runtime). */
  priceDecimals: number;

  features: {
    pivotLeft: number;            // bars to the left that must be lower/higher
    pivotRight: number;           // CONFIRMATION delay: a pivot exists only after this many closed bars
    atrPeriod: number;            // ATR lookback (Wilder)
    atrPercentileWindow: number;  // bars used to rank current ATR
    efficiencyBars: number;       // 20 closed M5 bars
    maSlopePeriod: number;        // EMA used for normalized slope
    maSlopeLookback: number;      // bars back for the slope
  };

  regime: {
    trendEfficiencyMin: number;   // 0.35 — candidate evidence for a directional regime
    rangeEfficiencyMax: number;   // 0.25 — starting feature only
    slopeMinAtr: number;          // |EMA slope| over lookback, in ATR units, to count as directional
    rangeMinTouches: number;      // separated boundary reactions required per side
    rangeTouchSeparationBars: number;
    rangeMinWidthAtr: number;     // a range narrower than this is chop, not a range
    hysteresisBars: number;       // a new regime must persist this many closed M5 bars before it is adopted
    overlapChopRatio: number;     // mean candle overlap above this → chop
  };

  setups: {
    minRewardRisk: number;        // 1.5 — net of estimated costs
    targetMinUsd: number;         // 5
    targetMaxUsd: number;         // 10
    minRoomToOpposingAtr: number; // required unobstructed room, multiple of target
    pullback: {
      maxPullbackDepthAtr: number;   // deeper than this = structure broken
      minPullbackDepthAtr: number;   // shallower than this = nothing to pull back from
      maxMoveAlreadyDoneRatio: number; // reject if price has already run this fraction of the target from the trigger
    };
    breakout: {
      compressionBars: number;        // 12 closed M1 bars
      compressionPercentileMax: number; // width percentile vs comparable windows
      compressionWindows: number;     // how many comparable windows to rank against
      bufferAtrMult: number;          // breakout close must exceed boundary by this × M5 ATR
      minBodyRatio: number;           // 0.60
      closeOuterQuarter: boolean;
      retestBars: number;             // bars allowed for the retest
      candidateExpiryBars: number;    // 3 closed M1 bars
      noRetestVariant: boolean;       // separately versioned, default off
    };
    range: {
      maxFailedBreaks: number;        // stop fading after this many consecutive boundary failures
      excursionMaxAtr: number;        // how far below support a "brief" probe may go
      middleExclusionPct: number;     // no entries in the middle X% of the range
    };
  };

  sizing: {
    riskFractionDefault: number;  // 0.005
    riskFractionMin: number;      // 0.0025
    riskFractionMax: number;      // 0.01
    slippageAllowanceTicks: number; // documented slippage allowance, in ticks
    commissionPerLotRoundTrip: number; // account currency; 0 unless the broker reports one
  };

  protection: {
    bufferSpreadMult: number;     // 2 spreads
    bufferAtrMult: number;        // 0.1 × M5 ATR
    breakevenAtR: number;         // 1.0R — consider cost-adjusted breakeven
    breakevenEnabled: boolean;
    trailEnabled: boolean;        // trail behind confirmed structure only
    timeStopMinutes: number;      // 90
    partialsEnabled: boolean;     // off — small accounts cannot split
    closeBeforeSessionEndMin: number; // flatten this many minutes before daily maintenance / weekly close
    noNewEntriesBeforeCloseMin: number;
  };

  breakers: {
    dailyLossPct: number;         // 2
    weeklyLossPct: number;        // 5
    drawdownPct: number;          // 8 — needs deliberate review to reset
    consecutiveLosses: number;    // 3
    cooldownMinutes: number;      // 30
    maxSpreadToStopRatio: number; // spread / stop distance
    maxSpreadToTargetRatio: number;
    maxQuoteAgeMs: number;
    maxFeedDivergenceUsd: number; // broker mid vs reference
    maxSlippageTicks: number;
    rejectionBurst: number;       // broker rejections within window → pause
    rejectionWindowMin: number;
    minEntrySpacingMin: number;   // rapid re-entry guard
    resetTimeUtc: string;         // daily baseline
  };

  calendar: {
    beforeMin: number;            // 10
    afterMin: number;             // 15
    unstableAfterMin: number;     // stricter for events flagged unstable
    impacts: string[];            // which impact labels count as high
  };

  feed: {
    brokerQuotePollMs: number;    // obeys /trade/config rate limits, never faster
    referencePollMs: number;
    m1RefreshMs: number;
  };
};

export const DEFAULT_CONFIG: AuricConfig = {
  version: STRATEGY_VERSION,
  priceDecimals: 2,
  features: {
    pivotLeft: 3, pivotRight: 3, atrPeriod: 14, atrPercentileWindow: 288, efficiencyBars: 20,
    maSlopePeriod: 20, maSlopeLookback: 5,
  },
  regime: {
    trendEfficiencyMin: 0.35, rangeEfficiencyMax: 0.25, slopeMinAtr: 0.15,
    rangeMinTouches: 2, rangeTouchSeparationBars: 4, rangeMinWidthAtr: 1.5,
    hysteresisBars: 2, overlapChopRatio: 0.72,
  },
  setups: {
    minRewardRisk: 1.5, targetMinUsd: 5, targetMaxUsd: 10, minRoomToOpposingAtr: 1.0,
    pullback: { maxPullbackDepthAtr: 1.8, minPullbackDepthAtr: 0.3, maxMoveAlreadyDoneRatio: 0.35 },
    breakout: {
      compressionBars: 12, compressionPercentileMax: 0.30, compressionWindows: 20, bufferAtrMult: 0.15,
      minBodyRatio: 0.60, closeOuterQuarter: true, retestBars: 3, candidateExpiryBars: 3, noRetestVariant: false,
    },
    range: { maxFailedBreaks: 2, excursionMaxAtr: 0.6, middleExclusionPct: 0.40 },
  },
  sizing: {
    riskFractionDefault: 0.005, riskFractionMin: 0.0025, riskFractionMax: 0.01,
    slippageAllowanceTicks: 15, commissionPerLotRoundTrip: 0,
  },
  protection: {
    bufferSpreadMult: 2, bufferAtrMult: 0.1, breakevenAtR: 1.0, breakevenEnabled: true, trailEnabled: true,
    timeStopMinutes: 90, partialsEnabled: false, closeBeforeSessionEndMin: 20, noNewEntriesBeforeCloseMin: 60,
  },
  breakers: {
    dailyLossPct: 2, weeklyLossPct: 5, drawdownPct: 8, consecutiveLosses: 3, cooldownMinutes: 30,
    maxSpreadToStopRatio: 0.25, maxSpreadToTargetRatio: 0.12, maxQuoteAgeMs: 4000, maxFeedDivergenceUsd: 2.5,
    maxSlippageTicks: 30, rejectionBurst: 3, rejectionWindowMin: 10, minEntrySpacingMin: 5, resetTimeUtc: "22:00",
  },
  calendar: { beforeMin: 10, afterMin: 15, unstableAfterMin: 30, impacts: ["high"] },
  feed: { brokerQuotePollMs: 1000, referencePollMs: 15000, m1RefreshMs: 5000 },
};

/** Freeze deeply so nothing at runtime can mutate the live configuration. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") { Object.freeze(o); for (const v of Object.values(o as object)) deepFreeze(v); }
  return o;
}
deepFreeze(DEFAULT_CONFIG);
