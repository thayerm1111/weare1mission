/**
 * RAPID core types. Prices travel as numbers; every comparison and rounding goes through core/decimal.
 *
 * Two ideas run through all of this and are worth stating once:
 *
 *  1. KNOWN-AT. Everything derived from candles carries the time it first became knowable, separate
 *     from the time it is drawn at. A pivot sits at bar N on the chart but is only knowable when bar
 *     N+pivotRight closes. Nothing may be used before its knownAt.
 *
 *  2. PROVENANCE. A price is only comparable to another price from the same source. Broker bid/ask is
 *     the execution authority; a reference feed is context. They are never spliced.
 */

export type Timeframe = "M5" | "M15" | "H1" | "H4" | "D1" | "W1";

export type Bar = {
  /** Bucket start, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number | null;
};

export type QuoteSource = "broker" | "reference";

export type Quote = {
  source: QuoteSource;
  bid: number;
  ask: number;
  /** Provider event time if one was supplied. TradeLocker /quotes supplies none. */
  providerTs: number | null;
  providerTsPrecision: "ms" | "s" | "none";
  /** Server receive time. Feed age is measured from this when the provider gives no timestamp. */
  receivedAt: number;
  /** Provider sequence or event identity, for deduplication. Timestamp alone is not identity. */
  seq?: string | null;
};

export const mid = (q: Quote) => (q.bid + q.ask) / 2;
export const spreadOf = (q: Quote) => q.ask - q.bid;

export type Side = "buy" | "sell";
export const opposite = (s: Side): Side => (s === "buy" ? "sell" : "buy");
/** +1 for a long, -1 for a short. Used so long/short logic is written once. */
export const dirOf = (s: Side): 1 | -1 => (s === "buy" ? 1 : -1);

export type Regime = "up" | "down" | "sideways" | "unknown";

export type ZoneRole = "support" | "resistance" | "range";

export type PivotKind = "high" | "low";

export type Pivot = {
  kind: PivotKind;
  price: number;
  /** Index into the bar series the pivot was found in. */
  barIndex: number;
  /** Bucket start of the pivot's own bar — where it is DRAWN. */
  t: number;
  /** Close time of the last right-hand confirming bar — when it became KNOWABLE. */
  knownAt: number;
  timeframe: Timeframe;
};

/**
 * A level with a lifecycle. `id` is stable across versions; `version` increments whenever the bounds
 * change. A pending or open trade holds the exact version it was created against and is never
 * retargeted by a later merge.
 */
export type Zone = {
  id: string;
  version: number;
  /** Stable id shared by cross-timeframe copies of the same economic level. */
  parentId: string;
  role: ZoneRole;
  /** Inclusive price bounds, lower first. */
  low: number;
  high: number;
  origin: Timeframe;
  /** Why this zone exists, for the audit trail. */
  provenance: ZoneProvenance;
  createdAt: number;
  knownAt: number;
  /** Role at the last confirmed transition, and when it flipped. */
  roleSince: number;
  previousRole: ZoneRole | null;
  /** Completed reaction visits recorded against this zone. */
  reactions: Reaction[];
  /** Consecutive stop-outs at this zone version within the session. */
  failedStops: number;
  /** Set when the zone stops being tradable; kept for audit rather than deleted. */
  invalidatedAt: number | null;
  invalidReason: string | null;
  /** Source zones folded into this one by a merge, newest last. */
  mergedFrom: string[];
  /** Execution zones can trigger entries; primary zones also cap targets. */
  tier: "primary" | "execution";
};

export type ZoneProvenance =
  | { kind: "swing"; timeframe: Timeframe; pivotT: number }
  | { kind: "prior_day"; day: string; which: "high" | "low" }
  | { kind: "prior_week"; week: string; which: "high" | "low" }
  | { kind: "range_boundary"; rangeId: string; which: "upper" | "lower" }
  | { kind: "drawn"; author: string; createdAt: number };

export type Reaction = {
  /** When the reaction completed — the close of the bar that confirmed the move away. */
  at: number;
  /** The extreme reached inside/at the zone. */
  extreme: number;
  /** Which side price approached from. */
  from: "above" | "below";
  /** How far price subsequently travelled away, in price units. */
  movedAway: number;
};

export type ValidatedRange = {
  id: string;
  upper: Zone;
  lower: Zone;
  timeframe: Timeframe;
  /** When the evidence for this range was complete. */
  knownAt: number;
  upperTouches: number;
  lowerTouches: number;
  /** Net room between the boundaries, in price units. */
  room: number;
  brokenAt: number | null;
  brokenBy: Side | null;
};

export type SetupFamily = "range_reaction" | "break_retest" | "trend_pullback" | "momentum";

export type VisitState =
  | "watching"
  | "approaching"
  | "armed"
  | "triggered"
  | "consumed"
  | "waiting_for_departure"
  | "invalidated"
  | "expired";

/** Tolerances are computed once, at setup creation, from completed data, and then frozen. */
export type FrozenTolerances = {
  atrEntry: number;
  touchTolerance: number;
  breakBuffer: number;
  stopBuffer: number;
  rearmDistance: number;
  /** Spread at freeze time, for the audit trail. Live spread is rechecked before execution. */
  spreadAtFreeze: number | null;
};

export type Setup = {
  setupId: string;
  /** One economic visit to one level. Re-entry needs a new visitId. */
  visitId: string;
  strategyVersion: string;
  configVersion: string;
  family: SetupFamily;
  side: Side;
  state: VisitState;
  timeframe: Timeframe;
  /** The zone this setup is anchored to, captured at its exact version. */
  zoneId: string;
  zoneVersion: number;
  parentId: string;
  createdAt: number;
  stateAt: number;
  expiresAt: number;
  tolerances: FrozenTolerances;
  /** Allowed approach band for the entry, inclusive. */
  entryBandLow: number;
  entryBandHigh: number;
  /** The structural price that invalidates the idea, before the stop buffer. */
  invalidation: number;
  /** Structural stop, buffered and tick-rounded outward. */
  stop: number;
  /** The opposing level that capped the target, if any. */
  opposingLevelId: string | null;
  opposingPrice: number | null;
  /** Reference entry used for planning. The real entry is the executable quote at trigger. */
  refEntry: number;
  target: number;
  targetUsd: number;
  stopUsd: number;
  /** Evidence behind every transition, append-only. */
  transitions: Transition[];
  conditionsMet: string[];
  conditionsPending: string[];
  /** For break_retest: the completed break that armed it. */
  breakEvidence: BreakEvidence | null;
};

export type BreakEvidence = {
  /** Close time of the completed breakout candle. This is the earliest the retest can be armed. */
  closedAt: number;
  closePrice: number;
  bodyRatio: number;
  closePositionInRange: number;
  beyondBy: number;
};

export type Transition = {
  from: VisitState;
  to: VisitState;
  at: number;
  reason: string;
  /** Whatever made the decision: prices, bar times, ids. */
  evidence: Record<string, number | string | boolean | null>;
};

export type RejectionCode =
  | "no_zone" | "zone_expired" | "zone_suspended" | "not_fresh_visit" | "gapped_through"
  | "outside_band" | "no_anchor" | "stop_too_wide" | "target_room_short" | "reward_risk_short"
  | "spread_too_wide" | "cost_too_high" | "stale_quote" | "session_closed" | "warmup"
  | "regime_conflict" | "already_consumed" | "opposite_break" | "expired" | "arbitration_lost"
  | "news_window" | "basis_unstable" | "no_opposing_room";

export type Rejection = {
  at: number;
  stage: string;
  code: RejectionCode;
  detail: string;
  family?: SetupFamily;
  zoneId?: string;
};

/** Account-independent view of the market. Contains nothing user-specific. */
export type MarketSnapshot = {
  snapshotId: string;
  strategyVersion: string;
  configVersion: string;
  generatedAt: number;
  /** The event time of the newest input used. */
  marketEventTime: number;
  feedSource: QuoteSource;
  quoteAgeMs: number | null;
  health: Health;
  regimes: Record<Timeframe, Regime>;
  /** Timeframes whose regimes disagree, surfaced rather than averaged away. */
  regimeConflict: boolean;
  zones: Zone[];
  range: ValidatedRange | null;
  scenarios: Setup[];
  rejections: Rejection[];
  deterministicExplanation: string;
};

export type Health = {
  state: "ok" | "degraded" | "blocked";
  reasons: string[];
  /** Feed age at snapshot time. */
  quoteAgeMs: number | null;
  /** Bars available versus bars needed, per timeframe. */
  warmup: Partial<Record<Timeframe, { have: number; need: number; ready: boolean }>>;
};

export type InstrumentSpec = {
  tradableInstrumentId: string;
  tradeRouteId: string;
  infoRouteId: string;
  brokerSymbol: string;
  /** Units of the underlying per 1.0 lot. Never assumed to be 100. */
  contractSize: number | null;
  lotStep: number | null;
  minLot: number | null;
  maxLot: number | null;
  tickSize: number | null;
  /** Account-currency value of one tick per lot, when the broker reports it. */
  tickValue: number | null;
  priceDecimals: number | null;
  /** Currency the profit is denominated in. */
  currency: string | null;
  minStopDistance: number | null;
  /** The broker's own payload, retained for audit. */
  raw: unknown;
};

/** Everything that can stop THIS account from taking an otherwise valid opportunity. */
export type AccountEligibility = {
  accountId: string;
  automationEnabled: boolean;
  managementEnabled: boolean;
  selectedRiskPct: number;
  quantity: number | null;
  estimatedRisk: number | null;
  estimatedReward: number | null;
  currency: string | null;
  blockers: string[];
};

export type OrderState =
  | "reserved" | "submitting" | "acknowledged" | "partially_filled" | "filled"
  | "protection_pending" | "protected" | "cancel_requested" | "cancelled"
  | "rejected" | "submission_unknown" | "closed";
