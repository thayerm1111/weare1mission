/**
 * MATTY PIPS — shared types for the deterministic engine.
 *
 * PHILOSOPHY (owner-corrected): LEVEL-FIRST · LOCATION-FIRST · REACTION-FIRST.
 * Higher timeframes are CONTEXT that raises or lowers confidence — never a
 * gate. Direction comes from what price DOES at a level, on CLOSED 15M candles.
 *
 * ISOLATION: everything under src/lib/matty-pips/ is standalone. It READS
 * shared infrastructure (market data, instrument specs, auth, econ calendar)
 * and never modifies FLOW, GENX, or any existing engine. No AI ever decides
 * trend, levels, entry, confirmation, SL, TP, or direction.
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
  structureReason: string;
  atr: number;
};

// ── RAW ZONES (built by zones.ts, consumed by the level map) ────────────────
export type ZoneType = "support" | "resistance";

export type Zone = {
  zoneLow: number;
  zoneHigh: number;
  zoneType: ZoneType;
  timeframes: Timeframe[];
  touchCount: number;
  freshness: number;
  strengthScore: number;
  lastReactionTime: string | null;
  brokeAndRetested: boolean;
};

// ── LEVELS ──────────────────────────────────────────────────────────────────
export type LevelSource =
  | "WEEK_HIGH" | "WEEK_LOW"
  | "PREV_DAY_HIGH" | "PREV_DAY_LOW"
  | "DAY_HIGH" | "DAY_LOW"
  | "STRUCT_HIGH" | "STRUCT_LOW"
  | "ZONE_D" | "ZONE_H4" | "ZONE_H1";

export type RankedLevel = {
  low: number; high: number;              // always a band, never a line
  kind: "support" | "resistance";
  sources: LevelSource[];                 // WHY this level matters
  rank: number;                           // 0–100 priority
  touches: number;
  freshness: number;                      // 1H bars since last touch
  brokeAndRetested: boolean;
  complexId: number | null;               // set when part of a complex
};

/** Several meaningful levels close together (relative to volatility) form a
 *  RESISTANCE COMPLEX / SUPPORT COMPLEX — treated as one broader structure. */
export type LevelComplex = {
  id: number;
  low: number; high: number;
  kind: "support" | "resistance";
  members: number;
  sources: LevelSource[];
  rank: number;
};

// ── REACTION ENGINE (the heart) ─────────────────────────────────────────────
export type ReactionState =
  | "NONE" | "APPROACHING" | "TESTING" | "RESPECTING" | "REJECTING"
  | "FAILED_BREAK" | "ACCEPTED_BREAK" | "BREAK_RETEST"
  | "MOMENTUM_CONTINUATION" | "EXPANSION_BREAKOUT";

export type ReactionRead = {
  state: ReactionState;
  detail: string;                 // the actual numbers behind the call
  brokeDirection: "up" | "down" | null; // for break states
  confirmedByClose: boolean;      // a CLOSED 15M candle confirmed the direction
};

/** At a decision node BOTH scenarios stay open until price picks one. */
export type ScenarioView = { direction: "buy" | "sell"; label: string; needs: string };

// ── SUPPORTING EVIDENCE (never independent signals) ─────────────────────────
export type SarRead = { dir: "up" | "down"; value: number; distanceAtr: number; flippedRecently: boolean };
export type FractalRead = { lastHigh: number | null; lastLow: number | null; higherLows: boolean; lowerHighs: boolean };
export type MomentumVerdict = "WAIT_FOR_PULLBACK" | "CONTINUATION_ENTRY_AVAILABLE" | "TOO_EXTENDED_DO_NOT_CHASE";
export type ExpansionOutcome = "CONTINUATION" | "EXHAUSTION_REVERSAL" | "STAND_ASIDE";
export type DxyVerdict = "DXY_SUPPORTS" | "DXY_NEUTRAL" | "DXY_CONFLICTS" | "DXY_UNAVAILABLE";
export type EventAction = "NORMAL_SETUP" | "REDUCED_CONFIDENCE" | "WAIT_FOR_EVENT" | "PROTECT_EXISTING_POSITION";

export type NewsRead = {
  action: EventAction;
  note: string;
  nextEvent: string;
  minutesTo: number | null;
  postEventWindow: boolean;       // just after a release → reactions may be news-driven
  screened: boolean;
};

// ── ADVANCED MARKET-STRUCTURE INTELLIGENCE ─────────────────────────────────
export type StructureContext = {
  externalTrend: MarketState;         // major swing structure
  internalTrend: MarketState;         // minor/internal swings
  lastMajorSwingHigh: number | null;
  lastMajorSwingLow: number | null;
  lastInternalSwingHigh: number | null;
  lastInternalSwingLow: number | null;
  lastStructureBreak: "internal" | "external" | null;
  structureBreakDirection: "up" | "down" | null;
  changeOfCharacter: boolean;         // internal turned against external
  impulseStrength: number;            // 0–100, ATR-normalized displacement of the last leg
  retracementStrength: number;        // 0–100, depth of the current corrective leg
  compression: "none" | "bullish" | "bearish"; // compressing into a level
  exhaustion: boolean;
  detail: string;
};

/** HOW price arrived at the level — probability evidence, never absolute rules. */
export type ApproachQuality = {
  kind: "FAST_EXPANSION" | "GRIND_COMPRESSION" | "REPEATED_ATTACK" | "WEAK_CORRECTIVE" | "NEUTRAL";
  detail: string;
};

// ── LIQUIDITY ENGINE ────────────────────────────────────────────────────────
export type LiquidityContext = {
  buySidePools: number[];             // obvious liquidity ABOVE (equal highs, day/week highs…)
  sellSidePools: number[];            // obvious liquidity BELOW
  sweep: { side: "buy-side" | "sell-side"; extreme: number; detail: string } | null;
  fakeoutProbability: "FAKEOUT_LOW" | "FAKEOUT_MODERATE" | "FAKEOUT_HIGH" | null;
  detail: string;
};

export type BreakoutQuality = "BREAKOUT_WEAK" | "BREAKOUT_VALID" | "BREAKOUT_STRONG";
export type Acceptance = "ACCEPTANCE" | "REJECTION" | "UNDECIDED";
export type TradeQuality = "NO_TRADE" | "LOW_QUALITY" | "VALID" | "HIGH_QUALITY" | "A_PLUS";
export type EntryQuality = "EARLY" | "OPTIMAL" | "ACCEPTABLE" | "LATE" | "CHASE";

// ── TRADE OUTPUT ────────────────────────────────────────────────────────────
export type SetupType =
  | "REJECTION_SELL" | "REJECTION_BUY"
  | "FAILED_BREAK_SELL" | "FAILED_BREAK_BUY"
  | "BREAKOUT_RUNNER_BUY" | "BREAKOUT_RUNNER_SELL"
  | "CONTINUATION_BUY" | "CONTINUATION_SELL";

export type SetupStatus = "WAIT" | "APPROACHING" | "ARMED" | "TAKE_NOW";

export type Mode = "conservative" | "aggressive";

export type ConfirmationFlag = { key: string; label: string; detail: string };

export type ManagementPlan = {
  breakevenAtPips: number;        // first protective step (default 30)
  partialAtPips: number;          // default 60 (50–70 band) — or halfway to target
  partialAtHalfwayToTarget: boolean;
  lockProfitPips: number;         // after partial, stop locks ~+30 (never backward)
  runnerToward: string;           // plain-English runner destination
};

export type TradeIdea = {
  direction: "buy" | "sell";
  setupType: SetupType;
  entry: number;
  entryZone: { low: number; high: number };
  stopLoss: number;               // STRUCTURAL — where the idea is invalid, never shrunk to a pip limit
  tp1: number;                    // ≈1R (capped at the next meaningful level if closer)
  tp2: number | null;             // ≈2R when structure permits
  runnerTarget: number | null;    // 50% of active range and/or next meaningful level
  riskReward: number;             // to TP1
  invalidationLevel: number;
  stopPips: number;
  tp1Pips: number;
  management: ManagementPlan;
};

export type ScoreBreakdown = {
  levelLocation: number;  // /20 — quality + rank of the level and being AT it
  reaction: number;       // /20 — what price DID there (sweep/reject/break/retest)
  structure: number;      // /15 — advanced market structure context
  liquidity: number;      // /10 — liquidity taken/available, sweep quality
  confirmation: number;   // /15 — CLOSED 15M confirmation
  riskTarget: number;     // /10 — stop quality, room, asymmetry
  momentum: number;       // /5
  dxy: number;            // /3
  news: number;           // /2
  total: number;          // /100
};

export type DecisionObject = {
  ok: true;
  symbol: string;
  displayName: string;
  price: number;
  asOf: string;
  mode: Mode;

  structures: TfStructure[];      // D, H4, H1 — context only
  daily: TfStructure;

  levels: RankedLevel[];          // ranked, with WHY (sources)
  complexes: LevelComplex[];
  activeNode: {                   // the level/complex price is interacting with
    low: number; high: number; kind: "support" | "resistance";
    rank: number; sources: LevelSource[]; isComplex: boolean;
  } | null;
  scenarios: ScenarioView[];      // both directions stay open until price picks
  rangePosition: number;          // 0–100 across the active range

  reaction: ReactionRead;         // the heart
  confirmations: ConfirmationFlag[];
  momentumVerdict: MomentumVerdict | null;   // for no-retest continuations
  expansionOutcome: ExpansionOutcome | null; // for explosive breaks
  expansionDetail: string;

  structureContext: StructureContext;        // advanced structure intelligence
  approach: ApproachQuality;                 // how price ARRIVED at the level
  liquidity: LiquidityContext;               // liquidity pools, sweeps, fakeout odds
  breakoutQuality: BreakoutQuality | null;   // graded when a break is in play
  acceptance: Acceptance;                    // is price ACCEPTING or REJECTING beyond the level
  tradeQuality: TradeQuality;                // GOOD trade vs merely POSSIBLE trade
  entryQuality: EntryQuality | null;
  badLocation: string | null;                // "setup valid but trade quality poor" explanation
  coach: string[];                           // real-time teaching lines

  sar: SarRead | null;
  fractals: FractalRead;
  dxy: { verdict: DxyVerdict; detail: string };
  news: NewsRead;

  status: SetupStatus;
  trade: TradeIdea | null;
  noTradeReason: string | null;
  monitoring: {
    zone: { low: number; high: number } | null;
    distancePips: number | null;
    watching: string;
  };

  score: ScoreBreakdown;
  whyThisTrade: string[];
  engineVersion: string;

  /** MATTY'S CALL (owner 09-04): the always-on "gun to the head" directional
   *  decision with a confidence score — present on every read. See verdict.ts. */
  call?: import("./verdict").MattyCall | null;

  /** Chart data so the UI can PAINT the picture: recent candles to draw
   *  against the level map, the trade lines, and the "what needs to happen"
   *  annotation. Snapshot travels with every saved read. */
  chart: { m15: Candle[]; h1: Candle[] };
};

export type EngineError = { ok: false; error: string; detail?: string };
export type EngineResult = DecisionObject | EngineError;

export const ENGINE_VERSION = "mp-2.0.0";
