/**
 * THE BRAIN — CONTRACTS
 *
 * The deterministic engine under command-center/core answers "what is true now?". These types answer the
 * question that makes an intelligence feel alive: "what just changed, and does it matter?"
 *
 * Same discipline as core/types.ts — plain data, no classes, no hidden state. A perception event written
 * today must still be readable, replayable and arguable in a year.
 */
import type { Level, MarketSnapshot, Regime, SessionName, TfState, Timeframe } from "../core/types";

/* ───────────────────────────── horizons ───────────────────────────── */

/**
 * The look-back windows The BRAIN compares against. These are the windows the data can actually support:
 * the market read is rebuilt from closed bars plus a live price poll, so a "one second ago" comparison
 * would be invented rather than measured. We compare what we really have.
 */
export type Horizon = "1m" | "5m" | "15m" | "1h";
export const HORIZONS: Horizon[] = ["1m", "5m", "15m", "1h"];
export const HORIZON_MS: Record<Horizon, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };

/* ───────────────────────────── the difference engine ───────────────────────────── */

/** What measurably moved between two snapshots. Every field is a real subtraction, never an estimate. */
export type SnapshotDiff = {
  horizon: Horizon;
  /** How far apart the two snapshots actually were — a 5m horizon may be served by a 4m-old snapshot. */
  actualMs: number;
  fromAt: number;
  toAt: number;

  priceFrom: number;
  priceTo: number;
  priceMove: number;          // dollars, signed
  pipsMove: number;           // signed pips
  /** Price move expressed in ATR — the only way "a big move" means the same thing on a quiet and a wild day. */
  moveAtr: number | null;

  pressureFrom: number;
  pressureTo: number;
  pressureChange: number;
  pressureFlipped: boolean;

  velocityFrom: number | null;
  velocityTo: number | null;
  velocityChange: number | null;

  atrFrom: number | null;
  atrTo: number | null;
  /** > 1 means volatility expanded over the window, < 1 means it compressed. */
  atrRatio: number | null;

  regimeFrom: Regime;
  regimeTo: Regime;
  regimeChanged: boolean;

  sessionFrom: SessionName;
  sessionTo: SessionName;
  sessionChanged: boolean;

  /** Per-timeframe state transitions, only where the state actually differs. */
  tfChanges: { tf: Timeframe; from: TfState; to: TfState; direction: "more_bullish" | "more_bearish" | "sideways" }[];

  /** Structure changes on the execution timeframe. */
  brokeStructure: "up" | "down" | null;
  failedBreak: "up" | "down" | null;
  reclaimed: boolean;
  positionInRangeFrom: number | null;
  positionInRangeTo: number | null;
};

/* ───────────────────────────── perception events ───────────────────────────── */

export type EventCode =
  | "PRICE_ACCELERATION" | "PRICE_DECELERATION"
  | "VOLATILITY_EXPANSION" | "VOLATILITY_COMPRESSION"
  | "BULLISH_PRESSURE_RISING" | "BULLISH_PRESSURE_COLLAPSING"
  | "BEARISH_PRESSURE_RISING" | "PRESSURE_FLIP"
  | "STRUCTURE_BREAK" | "STRUCTURE_RECLAIM"
  | "LEVEL_APPROACH" | "LEVEL_TOUCH" | "LEVEL_REJECTION" | "LEVEL_ACCEPTANCE"
  | "BREAKOUT_ATTEMPT" | "BREAKOUT_CONFIRMED" | "BREAKOUT_WEAKENING" | "FAILED_BREAKOUT"
  | "RETEST_BEGINNING" | "RETEST_HOLDING" | "RETEST_FAILING"
  | "REGIME_CHANGE" | "TIMEFRAME_ALIGNMENT" | "TIMEFRAME_CONFLICT"
  | "LIQUIDITY_SWEEP" | "MOMENTUM_ACCELERATION" | "MOMENTUM_EXHAUSTION"
  | "SESSION_TRANSITION" | "NEWS_APPROACHING" | "NEWS_RELEASED"
  | "UNUSUAL_PRICE_BEHAVIOR"
  | "TRADE_THESIS_STRENGTHENING" | "TRADE_THESIS_WEAKENING" | "TRADE_THESIS_INVALIDATED"
  | "FEED_DEGRADED" | "MARKET_CLOSED" | "MARKET_OPENED";

/**
 * How loud an event is allowed to be. The BRAIN earning the right to stay quiet is what makes it worth
 * listening to when it does speak — a professional does not narrate every tick.
 */
export type Channel = "silent" | "visual" | "stream" | "text" | "voice" | "urgent";
export const CHANNEL_RANK: Record<Channel, number> = { silent: 0, visual: 1, stream: 2, text: 3, voice: 4, urgent: 5 };

export type Significance = {
  /** Does this matter to a trader at all? 0–100. */
  importance: number;
  /** Is this new information, or the same thing it already said two minutes ago? 0–100. */
  novelty: number;
  /** Does it need attention NOW, or is it background? 0–100. */
  urgency: number;
  /** How sure the measurement is — thin data and degraded feeds lower this. 0–100. */
  confidence: number;
  /** The combined score the channel is chosen from. */
  score: number;
};

export type PerceptionEvent = {
  /** Stable within a run: code + horizon + the minute it fired. Lets the UI dedupe without a database. */
  key: string;
  at: number;
  code: EventCode;
  horizon: Horizon | null;
  timeframe: Timeframe | null;
  /** What a trader would say happened, in one line. Not a metric dump. */
  detail: string;
  /** The measurements behind the sentence, so "show me the math" is always answerable. */
  data: Record<string, number | string | null>;
  level: Level | null;
  significance: Significance;
  channel: Channel;
  /** bullish / bearish / neutral — used for the stream's colour and for thesis pressure. */
  lean: "bullish" | "bearish" | "neutral";
};

/* ───────────────────────────── presence ───────────────────────────── */

/**
 * The BRAIN's current internal state. The screen shows this so the intelligence itself visibly
 * notices things, rather than the user having to hunt for a changed number.
 */
export type Presence =
  | "offline"            // no market data at all — never dressed up as calm
  | "market_closed"
  | "observing"          // watching, nothing worth saying
  | "calm"               // quiet market, low volatility
  | "watching_level"     // price is near something that matters
  | "attention"          // something is developing
  | "market_shift"       // the character of the market just changed
  | "setup_developing"
  | "setup_armed"
  | "trade_active"
  | "protecting_trade"
  | "high_news_risk"
  | "market_unclear";    // honest "I don't know" — chaotic or contradictory

export type BrainState = {
  at: number;
  presence: Presence;
  /** One short line under the presence word, e.g. "Bullish pressure building beneath London high." */
  headline: string;
  /** What it is watching right now, most important first. */
  focus: string[];
  /** The market question it is currently trying to resolve. */
  question: string;
  /** Drives the visual: 0 = still, 100 = violent. Derived from volatility and velocity, never random. */
  intensity: number;
  /** -100 (sellers) … +100 (buyers). Drives directional lean of the visual. */
  lean: number;
};

/* ───────────────────────────── thesis ───────────────────────────── */

export type Bias =
  | "bullish_continuation" | "bullish_reversal" | "bearish_continuation" | "bearish_reversal"
  | "range_fade" | "breakout_watch" | "neutral" | "stand_aside";

export type ThesisStrength = "tentative" | "moderate" | "strong";

export type BrainThesis = {
  id: string;
  bias: Bias;
  /** How it reads on screen: "Bullish continuation". */
  label: string;
  strength: ThesisStrength;
  confidence: number;            // 0–100
  startedAt: number;
  endedAt: number | null;
  /** Why it started, why it got stronger, why it weakened, why it ended. Appended, never rewritten. */
  reasonStarted: string[];
  reasonStrengthened: string[];
  reasonWeakened: string[];
  reasonEnded: string | null;
  /** Prices it is watching, and the price that would make it wrong. */
  watching: number[];
  invalidationPrice: number | null;
  priceAtStart: number;
  priceAtEnd: number | null;
  snapshotAtStart: number;
  snapshotAtEnd: number | null;
};

/* ───────────────────────────── memory + statements ───────────────────────────── */

export type StatementKind = "briefing" | "observation" | "thesis_change" | "answer" | "alert" | "minute";

export type BrainStatement = {
  at: number;
  kind: StatementKind;
  /** What it said, in its own words. This is what "what were you thinking ten minutes ago" reads back. */
  text: string;
  channel: Channel;
  priceAt: number | null;
  thesisId: string | null;
};

/** Structured short-term memory. Deliberately NOT a conversation transcript dumped into a prompt. */
export type BrainMemory = {
  now: MarketSnapshot | null;
  diffs: SnapshotDiff[];
  recentEvents: PerceptionEvent[];
  thesis: BrainThesis | null;
  previousThesis: BrainThesis | null;
  statements: BrainStatement[];
  watchedLevels: Level[];
  state: BrainState | null;
  /** Things the trader has explicitly taught it. */
  lessons: { at: number; text: string }[];
};

/* ───────────────────────────── conversation ───────────────────────────── */

/** The safe, defined UI actions The BRAIN may take. It never gets arbitrary control of the page. */
export type UiActionName =
  | "FOCUS_TIMEFRAME" | "FOCUS_PRICE_RANGE" | "SHOW_LEVEL" | "SHOW_SESSION"
  | "SHOW_SCENARIO" | "SHOW_EVENT" | "SHOW_TRADE" | "SHOW_METRICS" | "MARK_CHART";

export type UiAction = { name: UiActionName; arg: string | number | null };

export type BrainResponse = {
  /** What gets spoken. Plain sentences — no markdown, no lists, no numbers read out as decimals. */
  spokenText: string;
  shortSummary: string;
  marketRead: string;
  changes: string[];
  focus: string[];
  watchedLevels: number[];
  scenario: { bull: string; bear: string; neutral: string } | null;
  tradeRead: string | null;
  uiActions: UiAction[];
  urgency: "low" | "normal" | "high";
  voiceEligible: boolean;
  /** Which engine produced this: the language model, or the deterministic narrator. Always disclosed. */
  source: "llm" | "narrator";
};
