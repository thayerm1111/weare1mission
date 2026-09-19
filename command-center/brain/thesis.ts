/**
 * THE BRAIN'S MARKET THESIS — what it currently believes, and its willingness to say it was wrong.
 *
 * Distinct from core/thesis.ts, which is the thesis attached to an individual TRADE. This one is the
 * running market read: the thing The BRAIN would answer "why are you bullish?" with, and the thing it
 * must be able to retract out loud when the market stops agreeing with it.
 *
 * The design rule that matters: a thesis is APPENDED to, never rewritten. When the read changes, the old
 * thesis is closed with a reason and a new one opens. That history is what lets it answer "what were you
 * thinking ten minutes ago" honestly instead of pretending its current view was always obvious.
 */
import type { Level, MarketSnapshot, TfState, Timeframe } from "../core/types";
import type { Bias, BrainThesis, PerceptionEvent, SnapshotDiff, ThesisStrength } from "./types";

const EXEC: Timeframe = "5m";
const CONTEXT: Timeframe[] = ["1h", "4h", "1d"];

const BULL: TfState[] = ["strong_uptrend", "uptrend", "weak_uptrend", "bullish_transition"];
const BEAR: TfState[] = ["strong_downtrend", "downtrend", "weak_downtrend", "bearish_transition"];
const isBull = (s: TfState) => BULL.includes(s);
const isBear = (s: TfState) => BEAR.includes(s);

const px = (n: number) => n.toFixed(2);
const LABEL: Record<Bias, string> = {
  bullish_continuation: "Bullish continuation",
  bullish_reversal: "Bullish reversal",
  bearish_continuation: "Bearish continuation",
  bearish_reversal: "Bearish reversal",
  range_fade: "Range — fade the edges",
  breakout_watch: "Breakout watch",
  neutral: "Neutral",
  stand_aside: "Stand aside",
};

export const biasLabel = (b: Bias) => LABEL[b];
export const biasDirection = (b: Bias): "bullish" | "bearish" | "neutral" =>
  b.startsWith("bullish") ? "bullish" : b.startsWith("bearish") ? "bearish" : "neutral";

/** The evidence, gathered once, so both the bias and the "why" come from exactly the same reading. */
function evidence(s: MarketSnapshot) {
  const exec = s.timeframes[EXEC];
  const ctx = CONTEXT.map((tf) => s.timeframes[tf]?.state).filter(Boolean) as TfState[];
  const bulls = ctx.filter(isBull).length;
  const bears = ctx.filter(isBear).length;
  const pressure = s.pressure.net;
  const pos = exec?.structure.positionInRange ?? null;
  const broke = exec?.structure.brokeStructure ?? null;
  const failed = exec?.structure.failedBreak ?? null;
  const seq = exec?.structure.sequence ?? "unknown";
  const atr = exec?.features.atr ?? null;
  return { exec, ctx, bulls, bears, pressure, pos, broke, failed, seq, atr };
}

/** Levels worth watching from here: the nearest above and the nearest below. */
function watchLevels(s: MarketSnapshot): { above: Level | null; below: Level | null } {
  let above: Level | null = null;
  let below: Level | null = null;
  for (const l of s.levels) {
    if (l.price > s.price && (!above || l.price < above.price)) above = l;
    if (l.price < s.price && (!below || l.price > below.price)) below = l;
  }
  return { above, below };
}

export type Proposal = { bias: Bias; confidence: number; reasons: string[]; watching: number[]; invalidation: number | null };

/**
 * Read the market and propose a view. Deliberately willing to return `neutral` or `stand_aside` —
 * an intelligence that always has an opinion is not reading the market, it is performing.
 */
export function propose(s: MarketSnapshot): Proposal {
  const e = evidence(s);
  const { above, below } = watchLevels(s);
  const reasons: string[] = [];
  const watching = [above?.price, below?.price].filter((n): n is number => typeof n === "number");

  if (s.blockers.length) {
    return {
      bias: "stand_aside", confidence: 90,
      reasons: [s.blockers[0].detail],
      watching: [], invalidation: null,
    };
  }
  if (!e.exec) {
    return { bias: "neutral", confidence: 30, reasons: ["Not enough closed 5-minute bars to read this properly."], watching, invalidation: null };
  }
  if (s.regime === "chaotic") {
    return { bias: "stand_aside", confidence: 70, reasons: ["Price action is chaotic — nothing here is worth acting on."], watching, invalidation: null };
  }

  const dir = e.bulls > e.bears ? 1 : e.bears > e.bulls ? -1 : 0;
  if (dir > 0) reasons.push(`Higher timeframes lean bullish (${e.bulls} of ${e.ctx.length}).`);
  if (dir < 0) reasons.push(`Higher timeframes lean bearish (${e.bears} of ${e.ctx.length}).`);
  if (dir === 0 && e.ctx.length) reasons.push("Higher timeframes disagree with each other.");

  if (Math.abs(e.pressure) >= 15) reasons.push(`${e.pressure > 0 ? "Buyers" : "Sellers"} have the pressure at ${Math.abs(Math.round(e.pressure))}.`);
  if (e.seq === "HH_HL") reasons.push("5-minute is still making higher highs and higher lows.");
  if (e.seq === "LH_LL") reasons.push("5-minute is making lower highs and lower lows.");
  if (e.broke) reasons.push(`Structure broke to the ${e.broke === "up" ? "upside" : "downside"}.`);
  if (e.failed) reasons.push(`The ${e.failed === "up" ? "upside" : "downside"} break failed.`);

  const ranging = s.regime === "sideways_range" || s.regime === "tight_range" || s.regime === "mean_reversion";
  const compressing = s.regime === "compression" || s.regime === "volatility_squeeze";
  const breaking = s.regime === "breakout" || s.regime === "breakout_retest" || s.regime === "expansion";

  let bias: Bias = "neutral";
  if (compressing) { bias = "breakout_watch"; reasons.push("Range is tightening — this usually resolves rather than continues."); }
  else if (ranging && e.pos != null && (e.pos > 0.82 || e.pos < 0.18)) { bias = "range_fade"; reasons.push(`Price is at the ${e.pos > 0.5 ? "top" : "bottom"} of the range.`); }
  else if (ranging) { bias = "neutral"; reasons.push("We are inside a range with no edge nearby."); }
  else if (e.failed === "up") bias = "bearish_reversal";
  else if (e.failed === "down") bias = "bullish_reversal";
  else if (dir > 0 && e.pressure > 5) bias = breaking || e.broke === "up" ? "bullish_continuation" : "bullish_continuation";
  else if (dir < 0 && e.pressure < -5) bias = "bearish_continuation";
  else if (dir > 0 && e.pressure < -12) { bias = "neutral"; reasons.push("Trend is up but short-term pressure is against it — that is a pullback, not a signal."); }
  else if (dir < 0 && e.pressure > 12) { bias = "neutral"; reasons.push("Trend is down but buyers are pushing — likely a bounce inside it."); }

  // Confidence: agreement earns it, contradiction and thin data spend it.
  let confidence = 38;
  confidence += Math.min(22, Math.abs(e.bulls - e.bears) * 9);
  confidence += Math.min(18, Math.abs(e.pressure) * 0.5);
  if (e.broke && biasDirection(bias) === (e.broke === "up" ? "bullish" : "bearish")) confidence += 10;
  if (e.failed) confidence += 6;
  if (s.warnings.length >= 3) confidence -= 8;
  if (bias === "neutral" || bias === "breakout_watch") confidence = Math.min(confidence, 58);
  confidence = Math.max(10, Math.min(92, Math.round(confidence)));

  const d = biasDirection(bias);
  const invalidation = d === "bullish" ? below?.price ?? null : d === "bearish" ? above?.price ?? null : null;
  if (invalidation != null) reasons.push(`This read is wrong below ${px(invalidation)}.`.replace("below", d === "bullish" ? "below" : "above"));

  return { bias, confidence, reasons, watching, invalidation };
}

export const strengthOf = (confidence: number): ThesisStrength =>
  confidence >= 72 ? "strong" : confidence >= 52 ? "moderate" : "tentative";

export function open(p: Proposal, s: MarketSnapshot): BrainThesis {
  return {
    id: `th_${s.at}`,
    bias: p.bias,
    label: LABEL[p.bias],
    strength: strengthOf(p.confidence),
    confidence: p.confidence,
    startedAt: s.at,
    endedAt: null,
    reasonStarted: p.reasons,
    reasonStrengthened: [],
    reasonWeakened: [],
    reasonEnded: null,
    watching: p.watching,
    invalidationPrice: p.invalidation,
    priceAtStart: s.price,
    priceAtEnd: null,
    snapshotAtStart: s.at,
    snapshotAtEnd: null,
  };
}

export type ThesisUpdate = {
  thesis: BrainThesis;
  previous: BrainThesis | null;
  change: "none" | "strengthened" | "weakened" | "changed_mind" | "opened";
  /** What The BRAIN should say about the change, in its own voice. Empty when nothing changed. */
  statement: string;
};

/**
 * How long a thesis must live before it may be replaced, and how much better the new evidence has to be.
 *
 * Without this, a read gets replaced every few bars and the journal becomes a list of mood swings rather
 * than a record of thinking. A real trader does not change their mind about the day every three minutes.
 * Only price going through the invalidation level bypasses this — that is not a change of mind, that is
 * being proven wrong.
 */
const MIN_THESIS_MS = 8 * 60_000;
const CONFIDENCE_MARGIN = 12;

export function update(
  current: BrainThesis | null,
  s: MarketSnapshot,
  diffs: SnapshotDiff[],
  events: PerceptionEvent[],
): ThesisUpdate {
  const p = propose(s);

  if (!current || current.endedAt) {
    const t = open(p, s);
    return { thesis: t, previous: current ?? null, change: "opened", statement: `My read is ${t.label.toLowerCase()}. ${p.reasons[0] ?? ""}`.trim() };
  }

  const dir = biasDirection(current.bias);
  const newDir = biasDirection(p.bias);
  const age = s.at - current.startedAt;

  // Hard invalidation: price went through the thing that was supposed to prove the read wrong.
  const brokenBy =
    current.invalidationPrice != null && dir === "bullish" && s.price < current.invalidationPrice ? current.invalidationPrice
    : current.invalidationPrice != null && dir === "bearish" && s.price > current.invalidationPrice ? current.invalidationPrice
    : null;

  // A genuine change of mind is a change of SIDE, or the data going bad, or the data coming good again.
  // Drifting to "neutral" is not a new opinion — it is the current one weakening, and it is handled below.
  const flippedSide = newDir !== "neutral" && dir !== "neutral" && newDir !== dir;
  const wentBlind = p.bias === "stand_aside" && current.bias !== "stand_aside";
  const canSeeAgain = current.bias === "stand_aside" && p.bias !== "stand_aside" && !s.blockers.length;
  const strongerCase = p.confidence >= current.confidence + CONFIDENCE_MARGIN;

  const biasReallyChanged =
    wentBlind ||                                            // data went bad: say so immediately
    (flippedSide && strongerCase) ||                        // the other side took over, convincingly
    (canSeeAgain && age >= MIN_THESIS_MS);                  // the data came back

  if (brokenBy != null || (biasReallyChanged && (wentBlind || age >= MIN_THESIS_MS))) {
    const reason = brokenBy != null
      ? `we lost ${px(brokenBy)}, which is the level the read depended on`
      : wentBlind
        ? (p.reasons[0] ?? "the data stopped being good enough to read").replace(/\.$/, "").toLowerCase()
        : `the evidence moved against it — ${(p.reasons[0] ?? "the case no longer holds").replace(/\.$/, "").toLowerCase()}`;
    const closed: BrainThesis = {
      ...current,
      endedAt: s.at,
      priceAtEnd: s.price,
      snapshotAtEnd: s.at,
      reasonEnded: reason,
    };
    const next = open(p, s);
    // This sentence is the whole point of tracking theses: it admits the change instead of hiding it.
    const statement = `I've changed my read. ${minutesAgo(age)} I favoured ${current.label.toLowerCase()}; that is no longer the case because ${reason}. I'm now reading this as ${next.label.toLowerCase()}.`;
    return { thesis: next, previous: closed, change: "changed_mind", statement };
  }

  // Same view — did it get stronger or weaker?
  const before = current.confidence;
  const after = Math.round(before * 0.65 + p.confidence * 0.35);
  const supportive = events.filter((e) => e.lean === dir).length;
  const against = events.filter((e) => e.lean !== "neutral" && e.lean !== dir).length;

  const t: BrainThesis = { ...current, confidence: after, strength: strengthOf(after), watching: p.watching, invalidationPrice: p.invalidation ?? current.invalidationPrice };

  if (after - before >= 7 || (supportive >= 2 && supportive > against)) {
    const why = events.find((e) => e.lean === dir)?.detail ?? p.reasons[0] ?? "the evidence has firmed up";
    t.reasonStrengthened = [...current.reasonStrengthened, why].slice(-6);
    return { thesis: t, previous: null, change: "strengthened", statement: `This is getting stronger. ${why}` };
  }
  if (before - after >= 7 || (against >= 2 && against > supportive)) {
    const why = events.find((e) => e.lean !== "neutral" && e.lean !== dir)?.detail ?? "momentum behind it has faded";
    t.reasonWeakened = [...current.reasonWeakened, why].slice(-6);
    const tail = dir === "neutral"
      ? "I'm holding this read more loosely than I was."
      : `I am no longer treating this as clean ${current.label.toLowerCase()}.`;
    return { thesis: t, previous: null, change: "weakened", statement: `Something changed. ${why} ${tail}` };
  }

  return { thesis: t, previous: null, change: "none", statement: "" };
}

function minutesAgo(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m <= 1) return "A minute ago";
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h === 1 ? "An hour ago" : `${h} hours ago`;
}
