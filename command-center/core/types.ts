/**
 * COMMAND CENTER XAUUSD — DOMAIN CONTRACTS
 *
 * Every other module speaks in these types. They are deliberately plain data: no classes, no methods, no
 * hidden state — so a snapshot can be persisted, replayed, diffed and argued with a year from now.
 */

export type Side = "buy" | "sell";
export type Mode = "scalp" | "intraday" | "swing";
export const MODES: Mode[] = ["scalp", "intraday", "swing"];

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
export const TF_MINUTES: Record<Timeframe, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };

export type Bar = { t: number; o: number; h: number; l: number; c: number; v?: number };
export type Tick = { t: number; bid: number; ask: number; mid: number; spread: number; source: FeedName };

export type FeedName = "tradelocker" | "twelvedata";
export type FeedHealth = { feed: FeedName; state: "live" | "degraded" | "stale" | "disconnected"; lastTickMs: number | null; ageMs: number | null };

/** What the market is doing on one timeframe. Ordered from most bullish to most bearish for comparisons. */
export type TfState =
  | "strong_uptrend" | "uptrend" | "weak_uptrend" | "bullish_transition"
  | "range" | "compression" | "breakout" | "volatility_expansion"
  | "bearish_transition" | "weak_downtrend" | "downtrend" | "strong_downtrend" | "chaotic";

export type Regime =
  | "trend_up" | "trend_down" | "orderly_trend" | "strong_momentum" | "parabolic"
  | "sideways_range" | "tight_range" | "compression" | "volatility_squeeze" | "expansion"
  | "breakout" | "breakout_retest" | "breakout_failure" | "mean_reversion"
  | "liquidity_sweep" | "news_shock" | "post_news_discovery" | "transition" | "chaotic";

export type SessionName = "asia" | "london" | "new_york" | "closed";

export type Level = {
  price: number;
  kind: "pdh" | "pdl" | "dh" | "dl" | "pwh" | "pwl" | "wh" | "wl" | "daily_open" | "weekly_open"
      | "asia_high" | "asia_low" | "london_high" | "london_low" | "ny_high" | "ny_low"
      | "swing_high" | "swing_low" | "range_high" | "range_low" | "manual";
  label: string;
  /** How far price sits from it, in ATR units — the only distance measure that means the same thing daily. */
  distanceAtr?: number;
};

export type Pressure = { bullish: number; bearish: number; net: number; acceleration: number };

export type StructureState = {
  swingHigh: number | null;
  swingLow: number | null;
  sequence: "HH_HL" | "LH_LL" | "mixed" | "unknown";
  brokeStructure: "up" | "down" | null;
  failedBreak: "up" | "down" | null;
  rangeHigh: number | null;
  rangeLow: number | null;
  positionInRange: number | null;   // 0 at the low, 1 at the high
  sweptLevel: number | null;
  reclaimed: boolean;
};

/** The ONLY thing The BRAIN and the strategy engine ever read. Versioned, persisted, replayable. */
export type MarketSnapshot = {
  snapshotVersion: string;
  at: number;
  price: number;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  feeds: FeedHealth[];
  session: SessionName;
  minutesIntoSession: number;
  timeframes: Partial<Record<Timeframe, { state: TfState; features: Features; structure: StructureState }>>;
  regime: Regime;
  pressure: Pressure;
  levels: Level[];
  /**
   * Where price has turned over the past days and weeks (core/levelMap.ts). Reference only — the setup
   * engine targets `levels`, never this, so adding it changed nothing about how THE BRAIN trades.
   * Optional because snapshots persisted before 09-20 do not carry it.
   */
  map?: Level[];
  news: { nextEvent: { name: string; at: number; importance: "high" | "medium" | "low" } | null; minutesToNext: number | null; inLockout: boolean };
  warnings: string[];      // things worth knowing; they do not stop a trade on their own
  /** Hard reasons this snapshot must not be traded on. Explicit, never inferred from wording. */
  blockers: { code: BlockerCode; detail: string }[];
};

export type BlockerCode =
  | "market_closed" | "no_exec_read" | "feed_stale" | "feed_divergence" | "exec_data_behind"
  | "exec_data_gaps" | "chaotic";

export type Features = {
  atr: number;
  atrPct: number;
  volRatio: number;
  returns1: number;
  returns5: number;
  velocity: number;
  acceleration: number;
  slope: number;
  slopeR2: number;
  rsi: number;
  efficiency: number;
  bodyBias: number;
  wickBias: number;
  rangeExpansion: number;
  zScore: number;

  /*
   * ACTIVITY, WHICH IS THE ONLY "VOLUME" SPOT GOLD HAS.
   *
   * XAU/USD is over-the-counter. There is no exchange, no consolidated tape, and therefore no
   * reportable traded quantity — the volume figure a spot-gold feed returns is TICK volume, the
   * number of price updates inside the bar. That measures how busy the market was, not how much
   * changed hands, and the two are not the same thing. Real gold volume lives on COMEX futures,
   * which is a different instrument and a second data source.
   *
   * Both fields are null when the feed sends nothing, and null must never be read as "quiet" — a
   * missing number and a low number mean completely different things, and conflating them is how a
   * system talks confidently about something it cannot see.
   */

  /** Tick count on the latest bar, straight from the feed. Null when the feed omits it. */
  ticks: number | null;
  /** That bar's tick count against its own 20-bar average. 1 is typical, 2 is twice as busy. */
  relativeActivity: number | null;
};

/** Why a trade was taken, and what would prove it wrong. Written once, never edited. */
export type TradeThesis = {
  strategy: string;
  mode: Mode;
  side: Side;
  reason: string;
  expected: string;
  invalidation: string;
  invalidationPrice: number;
  followThroughMs: number;
  entryContext: { regime: Regime; pressure: number; atr: number; positionInRange: number | null };
};

export type ExecState =
  | "analyzing" | "setup_forming" | "armed" | "entry_requested" | "order_submitted" | "order_acknowledged"
  | "filled" | "open" | "protected" | "partial_taken" | "runner" | "exit_requested" | "closed"
  | "canceled" | "invalidated" | "error" | "unknown";

export type Decision = {
  decisionId: string;
  at: number;
  snapshotVersion: string;
  strategy: string;
  mode: Mode;
  side: Side;
  entryLow: number;
  entryHigh: number;
  stop: number;
  targets: number[];
  confidence: number;
  probability: number | null;     // from the quant model, when one is fitted
  expectancyPips: number | null;
  thesis: TradeThesis;
  evidence: string[];
  conflicts: string[];
};

export const PIP = 0.1;                      // gold: one pip = $0.10
export const pips = (a: number, b: number) => Math.round(Math.abs(a - b) / PIP);
export const signedPips = (from: number, to: number, side: Side) =>
  Math.round(((side === "buy" ? to - from : from - to)) / PIP);
