/**
 * MATTY PIPS — shared types for the deterministic engine.
 *
 * ISOLATION: this module (and everything under src/lib/matty-pips/) is a
 * standalone system. It READS shared infrastructure (market data, instrument
 * specs, auth) and never modifies FLOW, GENX, or any existing engine.
 * Every number in a DecisionObject is computed by deterministic math — no AI
 * ever decides trend, S/R, entry, confirmation, SL, TP, or direction.
 */

export type Candle = { t: number; o: number; h: number; l: number; c: number };

export type Timeframe = "D" | "H4" | "H1" | "M15";

export type MarketState = "UPTREND" | "DOWNTREND" | "LEFT_TO_RIGHT";

export type TfStructure = {
  timeframe: Timeframe;
  marketState: MarketState;
  previousMarketState: MarketState;
  trendStrength: number;          // 0–100
  recentHigh: number;
  recentLow: number;
  structureReason: string;        // literal explanation, e.g. "HH 4512→4518 and HL 4496→4503"
  atr: number;                    // ATR(14) on this timeframe
};

export type ZoneType = "support" | "resistance";

export type Zone = {
  zoneLow: number;
  zoneHigh: number;
  zoneType: ZoneType;
  timeframes: Timeframe[];        // which TFs contributed pivots
  touchCount: number;
  freshness: number;              // 1H bars since last touch
  strengthScore: number;          // 0–100
  lastReactionTime: string | null; // ISO of the last touch
  brokeAndRetested: boolean;      // price closed through then came back (flip zone)
};

export type LocationState =
  | "AT_SUPPORT" | "NEAR_SUPPORT"
  | "MIDDLE_OF_RANGE"
  | "NEAR_RESISTANCE" | "AT_RESISTANCE"
  | "BREAKING_SUPPORT" | "BREAKING_RESISTANCE"
  | "BELOW_SUPPORT" | "ABOVE_RESISTANCE";

export type SetupType = "BUY_SUPPORT" | "SELL_RESISTANCE" | "BREAKOUT_RUNNER";

export type BreakoutPhase =
  | "NONE" | "APPROACHING" | "TESTING" | "FAKE" | "CONFIRMED" | "RETEST" | "CONTINUATION";

export type SetupStatus = "WAIT" | "APPROACHING" | "ARMED" | "TAKE_NOW";

export type Mode = "conservative" | "aggressive";

export type ConfirmationFlag = {
  key: string;      // e.g. "rejection_wick"
  label: string;    // human label
  detail: string;   // the actual numbers behind it
};

export type TradeIdea = {
  direction: "buy" | "sell";
  setupType: SetupType;
  entry: number;                    // actionable price (live)
  entryZone: { low: number; high: number };
  stopLoss: number;
  tp1: number;
  tp2: number | null;
  runnerTarget: number | null;
  riskReward: number;               // to TP1
  invalidationLevel: number;
  stopPips: number;
  tp1Pips: number;
};

export type ScoreBreakdown = {
  structure: number;      // /30
  zone: number;           // /20
  location: number;       // /20
  confirmation: number;   // /15
  riskReward: number;     // /10
  momentum: number;       // /5
  total: number;          // /100
};

export type DecisionObject = {
  ok: true;
  symbol: string;                 // canonical, e.g. XAUUSD
  displayName: string;
  price: number;
  asOf: string;                   // ISO
  mode: Mode;

  structures: TfStructure[];      // D, H4, H1 (M15 used for confirmation, not state)
  daily: TfStructure;             // convenience copy of the Daily read

  zones: Zone[];                  // strongest ≤3 above + ≤3 below
  location: LocationState;
  rangePosition: number;          // 0–100 (% of Daily recentLow→recentHigh)
  nearestSupport: Zone | null;
  nearestResistance: Zone | null;

  confirmations: ConfirmationFlag[];   // 15M predicates currently true for the setup side
  breakoutPhase: BreakoutPhase;
  breakoutDetail: string;

  status: SetupStatus;            // the visible state machine
  trade: TradeIdea | null;        // null → NO TRADE RIGHT NOW
  noTradeReason: string | null;   // why we're waiting (when trade is null)
  monitoring: {                   // what the engine is watching while waiting
    setupType: SetupType | null;
    zone: { low: number; high: number } | null;
    distancePips: number | null;  // live distance to that zone
    watching: string;             // plain-English watch line
  };

  score: ScoreBreakdown;
  whyThisTrade: string[];         // deterministic checklist lines
  engineVersion: string;
};

export type EngineError = { ok: false; error: string; detail?: string };
export type EngineResult = DecisionObject | EngineError;

export const ENGINE_VERSION = "mp-1.0.0";
