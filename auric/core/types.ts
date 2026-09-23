/** AURIC core types. Prices are numbers on the wire but every comparison and arithmetic goes through core/decimal.ts. */

export type Bar = { t: number; o: number; h: number; l: number; c: number; v?: number | null };
export type Timeframe = "M1" | "M5" | "M15" | "H1";

/** A quote labelled by source. Never blend sources into one series. */
export type Quote = {
  source: "broker" | "reference";
  bid: number;
  ask: number;
  /** Provider timestamp in ms if it gave one; null when the provider gives none (TradeLocker /quotes does not). */
  providerTs: number | null;
  /** Precision of providerTs: "ms" | "s" | "none". */
  providerTsPrecision: "ms" | "s" | "none";
  /** Local monotonic-ish receipt time (Date.now()). */
  receivedAt: number;
};

export type Regime = "UPTREND" | "DOWNTREND" | "ORDERLY_RANGE" | "EXPANSION_TRANSITION" | "CHOP_OR_UNCERTAIN";
export type Side = "buy" | "sell";
export type SetupFamily = "TREND_PULLBACK" | "COMPRESSION_BREAKOUT" | "RANGE_REJECTION";

export type Pivot = { kind: "high" | "low"; price: number; barIndex: number; t: number; confirmedAtIndex: number; confirmedAt: number };

export type Features = {
  asOf: number;               // close time of the last closed M5 bar used
  m1AsOf: number;
  atrM5: number;
  atrM1: number;
  atrPercentile: number;      // 0..1, rank of atrM5 in the window
  efficiency: number;         // 0..1 (0 when denominator is zero — flagged)
  efficiencyDefined: boolean;
  emaSlopeAtr: number;        // EMA(now) - EMA(lookback) in ATR units
  bodyRatioMean: number;      // mean body/range of last N M5 bars
  overlapMean: number;        // mean overlap ratio of consecutive M5 bars
  pivotsHigh: Pivot[];        // confirmed only
  pivotsLow: Pivot[];
  structure: "HH_HL" | "LH_LL" | "MIXED" | "INSUFFICIENT";
  range: RangeCandidate | null;
  spread: number | null;
  quoteAgeMs: number | null;
  h1Bias: "up" | "down" | "flat" | "unknown";
  m15Structure: "HH_HL" | "LH_LL" | "MIXED" | "INSUFFICIENT";
};

export type RangeCandidate = {
  id: string;
  support: number;    // FROZEN at creation
  resistance: number; // FROZEN at creation
  createdAtIndex: number;
  createdAt: number;
  touchesHigh: number[];
  touchesLow: number[];
  failedBreaks: number;
  invalidated: boolean;
  invalidReason?: string;
};

export type RegimeState = { regime: Regime; since: number; pending: Regime | null; pendingBars: number; reasons: string[] };

export type Candidate = {
  setupId: string;
  family: SetupFamily;
  variant: string;             // e.g. "retest" | "no-retest"
  strategyVersion: string;
  side: Side;
  regime: Regime;
  createdAt: number;           // decision time
  sourceTimestamps: { m1Close: number; m5Close: number; quoteReceivedAt: number | null };
  trigger: string;             // exact trigger description
  entryCondition: string;
  expiresAt: number;
  invalidation: number;        // structural invalidation price
  plannedStop: number;
  plannedTarget: number;
  targetUsd: number;           // intended price movement in USD
  estCostUsdPerUnit: number;   // spread + slippage + commission per unit of price (in price units)
  rewardRiskNet: number;
  reasons: string[];
  frozen: Record<string, number>; // frozen boundaries/levels for display
};

export type Rejection = { at: number; stage: string; code: string; detail: string; family?: SetupFamily };

export type Decision =
  | { kind: "none"; rejections: Rejection[] }
  | { kind: "candidate"; candidate: Candidate; rejections: Rejection[] };

export type InstrumentSpec = {
  tradableInstrumentId: string;
  tradeRouteId: string;
  infoRouteId: string;
  name: string;
  contractSize: number | null;     // units per lot
  lotStep: number | null;
  minLot: number | null;
  maxLot: number | null;
  tickSize: number | null;
  tickValue: number | null;        // per lot per tick, account currency (may be absent)
  priceDecimals: number | null;
  currency: string | null;         // quote/profit currency
  minStopDistance: number | null;  // price units, if reported
  raw: unknown;                    // the broker's payload, kept for audit
};

export type ProcessState =
  | "OBSERVING" | "SETUP_FORMING" | "TRIGGER_VALIDATED" | "RISK_CHECK" | "ORDER_SUBMITTED"
  | "POSITION_PROTECTED" | "POSITION_MANAGED" | "TRADE_CLOSED" | "PAUSED";
