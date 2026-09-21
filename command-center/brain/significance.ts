/**
 * THE SIGNIFICANCE ENGINE — when Atlas is allowed to make a sound.
 *
 * This is the most important restraint in the product. An intelligence that comments on every tick is
 * noise, and noise gets muted; an intelligence that stays quiet for forty minutes and then says one
 * sentence gets listened to. So every perception event is scored and routed, and most of them are
 * routed to silence on purpose.
 *
 * Nothing here manufactures commentary. If nothing important happened, nothing is said.
 */
import type { MarketSnapshot } from "../core/types";
import type { Channel, EventCode, PerceptionEvent, Significance } from "./types";
import { CHANNEL_RANK } from "./types";

/** How much a trader cares about this KIND of thing, before magnitude is considered. */
const BASE_IMPORTANCE: Record<EventCode, number> = {
  MARKET_CLOSED: 40, MARKET_OPENED: 60, FEED_DEGRADED: 85,
  NEWS_APPROACHING: 78, NEWS_RELEASED: 92,
  REGIME_CHANGE: 74, PRESSURE_FLIP: 72,
  STRUCTURE_BREAK: 76, STRUCTURE_RECLAIM: 66, FAILED_BREAKOUT: 80,
  BREAKOUT_ATTEMPT: 64, BREAKOUT_CONFIRMED: 82, BREAKOUT_WEAKENING: 70,
  RETEST_BEGINNING: 58, RETEST_HOLDING: 66, RETEST_FAILING: 72,
  LEVEL_ACCEPTANCE: 70, LEVEL_REJECTION: 62, LEVEL_TOUCH: 48, LEVEL_APPROACH: 42,
  LIQUIDITY_SWEEP: 68, UNUSUAL_PRICE_BEHAVIOR: 76,
  MOMENTUM_ACCELERATION: 56, MOMENTUM_EXHAUSTION: 64,
  PRICE_ACCELERATION: 46, PRICE_DECELERATION: 44,
  VOLATILITY_EXPANSION: 58, VOLATILITY_COMPRESSION: 44,
  BULLISH_PRESSURE_RISING: 50, BULLISH_PRESSURE_COLLAPSING: 62, BEARISH_PRESSURE_RISING: 50,
  TIMEFRAME_ALIGNMENT: 54, TIMEFRAME_CONFLICT: 56,
  SESSION_TRANSITION: 50,
  TRADE_THESIS_STRENGTHENING: 70, TRADE_THESIS_WEAKENING: 84, TRADE_THESIS_INVALIDATED: 94,
};

/** Things that deserve to interrupt a person, even if they said something similar recently. */
const URGENT: EventCode[] = ["FEED_DEGRADED", "NEWS_RELEASED", "TRADE_THESIS_INVALIDATED", "FAILED_BREAKOUT"];

/** The execution timeframes carry more weight than a 1-hour observation for a live decision. */
const HORIZON_WEIGHT: Record<string, number> = { "1m": 1.0, "5m": 1.05, "15m": 0.95, "1h": 0.85, "-": 1 };

export type ScoreContext = {
  snapshot: MarketSnapshot;
  /** Events already raised in the recent past — used for novelty, so nothing repeats itself. */
  recent: PerceptionEvent[];
  /** When Atlas last spoke out loud. Restraint is enforced here, not left to taste. */
  lastSpokeAt: number | null;
  /** Minimum gap between spoken comments, unless the event is urgent. */
  quietMs?: number;
  /** Is a position open? Everything about an open trade matters more. */
  tradeActive?: boolean;
};

const DEFAULT_QUIET_MS = 150_000;   // ~2.5 minutes between voice comments in normal conditions
/** How long a standing observation stays "already said". */
const SUPPRESS_MS = 18 * 60_000;
/** How much more important it must have become to be worth saying again inside that window. */
const ESCALATION = 10;

/**
 * Novelty: has Atlas effectively already said this? Same code within the window decays hard,
 * so "bullish pressure rising" does not get announced six times during one push.
 */
function noveltyOf(e: Omit<PerceptionEvent, "significance" | "channel">, recent: PerceptionEvent[]): number {
  const sameCode = recent.filter((r) => r.code === e.code);
  if (!sameCode.length) return 100;
  const newest = Math.max(...sameCode.map((r) => r.at));
  const ageMin = (e.at - newest) / 60_000;
  if (ageMin < 2) return 8;
  if (ageMin < 5) return 28;
  if (ageMin < 12) return 55;
  if (ageMin < 30) return 78;
  return 95;
}

/** Confidence is a property of the DATA, not of the opinion. Thin or degraded data lowers it. */
function confidenceOf(s: MarketSnapshot): number {
  let c = 92;
  if (s.blockers.some((b) => b.code === "feed_stale" || b.code === "feed_divergence")) c -= 45;
  if (s.blockers.some((b) => b.code === "exec_data_gaps" || b.code === "exec_data_behind")) c -= 30;
  if (s.warnings.length >= 3) c -= 8;
  if (!s.timeframes["5m"]) c -= 40;
  if (s.regime === "chaotic") c -= 20;
  return Math.max(5, Math.min(100, c));
}

/** Magnitude bonus from whatever the detector measured — a 2-ATR move outranks a 0.9-ATR one. */
function magnitudeBonus(e: Omit<PerceptionEvent, "significance" | "channel">): number {
  const d = e.data;
  let bonus = 0;
  const atr = typeof d.atr === "number" ? Math.abs(d.atr) : null;
  if (atr != null) bonus += Math.min(18, (atr - 0.8) * 14);
  const change = typeof d.change === "number" ? Math.abs(d.change) : null;
  if (change != null) bonus += Math.min(14, (change - 12) * 0.6);
  const ratio = typeof d.ratio === "number" ? d.ratio : null;
  if (ratio != null) bonus += Math.min(12, Math.abs(ratio - 1) * 22);
  const z = typeof d.z === "number" ? Math.abs(d.z) : null;
  if (z != null) bonus += Math.min(14, (z - 2.6) * 6);
  const minutes = typeof d.minutes === "number" ? d.minutes : null;
  if (minutes != null) bonus += Math.max(0, 16 - minutes);      // news gets louder as it gets closer
  return Math.max(0, bonus);
}

export function score(e: Omit<PerceptionEvent, "significance" | "channel">, ctx: ScoreContext): Significance {
  const base = BASE_IMPORTANCE[e.code] ?? 50;
  const hw = HORIZON_WEIGHT[e.horizon ?? "-"] ?? 1;
  let importance = Math.min(100, (base + magnitudeBonus(e)) * hw);
  if (ctx.tradeActive) importance = Math.min(100, importance * 1.15);

  const novelty = noveltyOf(e, ctx.recent);
  const confidence = confidenceOf(ctx.snapshot);
  const urgency = URGENT.includes(e.code) ? 95 : Math.min(100, importance * (e.horizon === "1m" || e.horizon === "5m" ? 0.95 : 0.7));

  // Importance decides whether it matters; novelty decides whether it is worth saying again;
  // confidence decides whether we should be opening our mouth at all.
  const raw = importance * 0.46 + novelty * 0.24 + urgency * 0.14 + confidence * 0.16;
  return {
    importance: Math.round(importance),
    novelty: Math.round(novelty),
    urgency: Math.round(urgency),
    confidence: Math.round(confidence),
    score: Math.round(raw),
  };
}

/**
 * Route an event to a channel. The gaps between the thresholds are where the product's manners live.
 * A low-confidence read can reach the screen but is never allowed to speak.
 */
export function route(sig: Significance, code: EventCode, ctx: ScoreContext): Channel {
  const quiet = ctx.quietMs ?? DEFAULT_QUIET_MS;
  const urgent = URGENT.includes(code);

  if (urgent && sig.confidence >= 40) return "urgent";
  if (sig.score < 34) return "silent";
  if (sig.score < 48) return "visual";
  if (sig.score < 62) return "stream";

  // Above here it wants to talk. Two gates before it may: the data has to be trustworthy, and it has to
  // have kept quiet for a while. An intelligence with no restraint is a notification spammer.
  if (sig.confidence < 55) return "stream";
  const gap = ctx.lastSpokeAt == null ? Infinity : ctx.snapshot.at - ctx.lastSpokeAt;
  if (sig.score >= 78 && gap >= quiet * 0.5) return "voice";
  if (gap >= quiet) return "voice";
  return "text";
}

/**
 * Two events can be the same observation seen through different look-back windows — "the 15-minute turned
 * bullish" measured over five minutes and over an hour is ONE thing that happened, and "pressure is
 * easing" over 5m and over 15m is one story told twice. The reader is told once, by whichever window
 * saw it most clearly. Deliberately keyed on WHAT happened and to what, not on the numbers, because the
 * numbers differ between windows while the observation does not.
 */
const semanticKey = (e: Omit<PerceptionEvent, "significance" | "channel">): string =>
  `${e.code}|${e.timeframe ?? ""}|${e.level ? e.level.price.toFixed(2) : ""}`;

/** Score, route, dedupe, sort and cap. The output of this is what the rest of the product is allowed to see. */
export function significant(
  raw: Omit<PerceptionEvent, "significance" | "channel">[],
  ctx: ScoreContext,
  max = 12,
): PerceptionEvent[] {
  // A CONDITION that persists is not news every time it is re-measured. Sellers took control once; the
  // fact that they are still in control five minutes later is the same sentence, and repeating it is how
  // an intelligence turns into a notification feed people mute.
  const said = new Map<string, { at: number; score: number }>();
  for (const r of ctx.recent) {
    const k = semanticKey(r);
    const prev = said.get(k);
    if (!prev || r.at > prev.at) said.set(k, { at: r.at, score: r.significance.score });
  }

  const byKey = new Set<string>();
  const best = new Map<string, PerceptionEvent>();
  for (const e of raw) {
    if (byKey.has(e.key)) continue;
    byKey.add(e.key);
    const sk = semanticKey(e);
    const significance = score(e, ctx);

    // Re-raise a standing observation only if it has become materially more important.
    const before = said.get(sk);
    const restated = before != null && e.at - before.at < SUPPRESS_MS && significance.score <= before.score + ESCALATION;
    if (restated && !URGENT.includes(e.code)) continue;

    const channel = route(significance, e.code, ctx);
    if (channel === "silent") continue;
    const scored: PerceptionEvent = { ...e, significance, channel };
    const existing = best.get(sk);
    if (!existing || existing.significance.score < significance.score) best.set(sk, scored);
  }
  const out = [...best.values()];
  out.sort((a, b) =>
    CHANNEL_RANK[b.channel] - CHANNEL_RANK[a.channel] || b.significance.score - a.significance.score);
  return out.slice(0, max);
}

/** The single event, if any, that has earned the right to be spoken this pass. */
export const toSpeak = (events: PerceptionEvent[]): PerceptionEvent | null =>
  events.find((e) => e.channel === "urgent") ?? events.find((e) => e.channel === "voice") ?? null;
