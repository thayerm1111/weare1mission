/**
 * RAPID — typed strategy configuration for `matty_rapid_v1`.
 *
 * EVERY NUMBER HERE IS A PROPOSED STARTING PARAMETER, NOT A PROVEN OPTIMUM.
 * None of it has been demonstrated profitable. The replay harness
 * (rapid/research/backtest.ts) reads this same frozen object, so what is
 * evaluated is exactly what runs.
 *
 * A live setup freezes the config version it was created under; a live position
 * freezes the management version it was filled under. Changing a number here
 * never retroactively changes a decision that has already been made.
 */

export const STRATEGY_VERSION = "matty_rapid_v1";
export const CONFIG_VERSION = "matty_rapid_v1.cfg.1";
export const MANAGEMENT_VERSION = "matty_rapid_mgmt_v1";

export type RapidConfig = {
  version: string;
  configVersion: string;
  managementVersion: string;

  /** Instrument identity. Resolved against the account at runtime; this is only the canonical label. */
  symbol: string;

  structure: {
    /** Completed candles either side of a pivot. The pivot is knowable only when the LAST right-hand candle closes. */
    pivotLeft: number;
    pivotRight: number;
    atrPeriod: number;
    /** Regime comparison tolerance: max(this many ticks, noiseAtrMult x ATR of that timeframe). */
    noiseTicks: number;
    noiseAtrMult: number;
    /** Confirmed swings needed per side before a regime is anything other than Unknown. */
    minSwingsPerSide: number;
  };

  zones: {
    /** A zone narrower than this many ticks is widened to it. */
    minWidthTicks: number;
    /** Same-role zones within this x ATR(14) of their source timeframe are merged. */
    mergeAtrMult: number;
    /** Execution zones expire after this many bars of their source timeframe with no new completed reaction. */
    executionExpiryBars: number;
    /** Higher-timeframe zones live longer. */
    primaryExpiryBars: number;
  };

  range: {
    /** Completed reaction visits required at EACH boundary. */
    minTouchesPerSide: number;
    /** Reactions are counted within this many closed execution bars. */
    lookbackBars: number;
    /** A visit only counts once price has moved away by max(this usd, separationAtrMult x ATR). */
    separationUsd: number;
    separationAtrMult: number;
    /** After this many stop-outs at one zone version in a session, suspend the zone. */
    maxFailedStopsPerZone: number;
  };

  entry: {
    /** touch_tolerance = min(touchMaxUsd, max(touchMinUsd, touchAtrMult x ATR_entry, 2 ticks)) */
    touchMinUsd: number;
    touchMaxUsd: number;
    touchAtrMult: number;
    /** break_buffer = max(breakMinUsd, breakAtrMult x ATR_entry, 2 ticks) */
    breakMinUsd: number;
    breakAtrMult: number;
    /** rearm_distance = max(rearmMinUsd, rearmAtrMult x ATR_entry) */
    rearmMinUsd: number;
    rearmAtrMult: number;
    /** A breakout candle needs this body/range ratio and a close in the directional outer fraction. */
    minBodyRatio: number;
    closeOuterFraction: number;
    /** An armed retest expires after this many execution-timeframe bars. */
    retestExpiryBars: number;
    /** Structural swing anchors are looked for within this many execution bars. */
    anchorLookbackBars: number;
    /** Minimum seconds between a close and a new entry on the same account. */
    reentryCooldownSec: number;
    /** Family D: closed-break momentum. OFF in the initial release. */
    momentumEnabled: boolean;
    /** Momentum entry is only allowed within min(momentumMaxUsd, momentumAtrMult x ATR_entry) of the boundary. */
    momentumMaxUsd: number;
    momentumAtrMult: number;
  };

  protection: {
    /** stop_buffer = max(stopMinUsd, stopSpreadMult x spread, stopAtrMult x ATR_entry, 2 ticks) */
    stopMinUsd: number;
    stopSpreadMult: number;
    stopAtrMult: number;
    /** Rapid stop cap in gold price. A structurally correct stop wider than this SKIPS the setup. */
    stopCapUsd: number;
    /** Hard operational ceiling. Raising stopCapUsd above this requires a new reviewed strategy version. */
    stopCeilingUsd: number;
  };

  target: {
    minUsd: number;
    maxUsd: number;
    /** target_buffer = max(bufferMinUsd, spread, 2 ticks) */
    bufferMinUsd: number;
    /** Progress markers shown when they fit inside the actual target. */
    markersUsd: number[];
    /** Estimated net final reward / estimated stop risk, after costs. */
    minNetRewardRisk: number;
  };

  risk: {
    presetsPct: number[];
    defaultPct: number;
    /** Operator ceiling. A user value above this is clamped server-side. */
    maxPct: number;
    /** Session loss ceiling as a percentage of session-start equity. */
    sessionLossCeilingPct: number;
    /** One Rapid-owned open or pending position per connected account. */
    maxConcurrentPerAccount: number;
    /** Adverse allowance added to the entry and to the stop before sizing, in ticks. */
    entrySlippageTicks: number;
    exitSlippageTicks: number;
    commissionPerLotRoundTrip: number;
    /** Reject when modelled costs consume more than this fraction of the target distance. */
    maxCostToTargetRatio: number;
    /** Both must pass. */
    maxSpreadUsd: number;
    maxSpreadToTargetRatio: number;
    /** Recomputed exposure above the reservation by more than this fraction is reduced or closed. */
    exposureTolerance: number;
  };

  management: {
    /** breakeven trigger = max(beMinUsd, beStopFraction x D_stop, beAtrMult x ATR_entry_at_fill) */
    beMinUsd: number;
    beStopFraction: number;
    beAtrMult: number;
    /** Partial at this favourable move, only when the final target is strictly beyond it. */
    partialAtUsd: number;
    partialFraction: number;
    /** Change-of-character: a completed candle closing beyond the protected swing by break_buffer. */
    cocMinBodyRatio: number;
  };

  feed: {
    /** Execution is blocked when the account feed is older than this. */
    maxQuoteAgeMs: number;
    /** An approved intent older than this is not submitted. */
    maxSignalToSubmitMs: number;
    /** Watchdog cadence. NOT a claim that quotes arrive this often. */
    watchdogMs: number;
    /** Broker quote poll floor; the config-derived rate limit always wins if it is slower. */
    brokerQuotePollMs: number;
    /** Bars needed before a timeframe's setups may arm. */
    warmupBars: number;
    /** Late events beyond this reorder window cannot change an issued signal. */
    reorderWindowMs: number;
    /** Basis between the reference feed and the broker feed above this blocks execution. */
    maxBasisUsd: number;
    maxBasisStdUsd: number;
  };

  calendar: {
    /** Optional research setting. Requires a verified calendar source; without one this stays off. */
    enabled: boolean;
    beforeMin: number;
    afterMin: number;
    impacts: string[];
  };

  /** Product feature flag. Nothing executes for anybody while this is false. */
  liveEnabled: boolean;
};

export const DEFAULT_CONFIG: RapidConfig = {
  version: STRATEGY_VERSION,
  configVersion: CONFIG_VERSION,
  managementVersion: MANAGEMENT_VERSION,
  symbol: "XAUUSD",

  structure: {
    pivotLeft: 2,
    pivotRight: 2,
    atrPeriod: 14,
    noiseTicks: 2,
    noiseAtrMult: 0.1,
    minSwingsPerSide: 2,
  },

  zones: {
    minWidthTicks: 2,
    mergeAtrMult: 0.15,
    executionExpiryBars: 96,
    primaryExpiryBars: 240,
  },

  range: {
    minTouchesPerSide: 2,
    lookbackBars: 48,
    separationUsd: 2,
    separationAtrMult: 0.5,
    maxFailedStopsPerZone: 2,
  },

  entry: {
    touchMinUsd: 0.25,
    touchMaxUsd: 1.0,
    touchAtrMult: 0.1,
    breakMinUsd: 0.15,
    breakAtrMult: 0.1,
    rearmMinUsd: 2.0,
    rearmAtrMult: 0.5,
    minBodyRatio: 0.55,
    closeOuterFraction: 0.3,
    retestExpiryBars: 6,
    anchorLookbackBars: 12,
    reentryCooldownSec: 15,
    momentumEnabled: false,
    momentumMaxUsd: 1.0,
    momentumAtrMult: 0.2,
  },

  protection: {
    stopMinUsd: 0.2,
    stopSpreadMult: 1.5,
    stopAtrMult: 0.1,
    stopCapUsd: 10,
    stopCeilingUsd: 15,
  },

  target: {
    minUsd: 5,
    maxUsd: 15,
    bufferMinUsd: 0.2,
    markersUsd: [5, 10],
    minNetRewardRisk: 1.0,
  },

  risk: {
    presetsPct: [0.25, 0.5, 1, 2],
    defaultPct: 0.5,
    maxPct: 2,
    sessionLossCeilingPct: 3,
    maxConcurrentPerAccount: 1,
    entrySlippageTicks: 10,
    exitSlippageTicks: 10,
    commissionPerLotRoundTrip: 0,
    maxCostToTargetRatio: 0.15,
    maxSpreadUsd: 0.8,
    maxSpreadToTargetRatio: 0.15,
    exposureTolerance: 0.05,
  },

  management: {
    beMinUsd: 3,
    beStopFraction: 0.5,
    beAtrMult: 0.35,
    partialAtUsd: 10,
    partialFraction: 0.5,
    cocMinBodyRatio: 0.55,
  },

  feed: {
    maxQuoteAgeMs: 2000,
    maxSignalToSubmitMs: 2000,
    watchdogMs: 1000,
    brokerQuotePollMs: 1000,
    warmupBars: 60,
    reorderWindowMs: 5000,
    maxBasisUsd: 3,
    maxBasisStdUsd: 1.5,
  },

  calendar: {
    enabled: false,
    beforeMin: 2,
    afterMin: 5,
    impacts: ["high"],
  },

  liveEnabled: false,
};

/** Deep-freeze so nothing at runtime can mutate the live configuration. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}
deepFreeze(DEFAULT_CONFIG);

/** The only sanctioned way to vary config: a named, versioned override used by research. */
export function withOverrides(base: RapidConfig, label: string, patch: DeepPartial<RapidConfig>): RapidConfig {
  const merged = mergeDeep(base, patch) as RapidConfig;
  merged.configVersion = `${base.configVersion}+${label}`;
  return deepFreeze(merged);
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function mergeDeep(a: unknown, b: unknown): unknown {
  if (Array.isArray(b)) return [...b];
  if (b && typeof b === "object" && a && typeof a === "object") {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = mergeDeep((a as Record<string, unknown>)[k], v);
    return out;
  }
  return b === undefined ? a : b;
}
