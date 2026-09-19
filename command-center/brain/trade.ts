/**
 * TRADE INTELLIGENCE — THE BRAIN, once a position exists.
 *
 * Before a trade, THE BRAIN watches gold. After a trade, it watches gold THROUGH the position. That is
 * not a different screen; it is a different question. "What is gold doing?" becomes "is the reason we
 * took this still true?"
 *
 * The hardest thing in this file, and the thing most systems get wrong, is the difference between a
 * NORMAL PULLBACK and REAL DETERIORATION. A system that cannot tell them apart either closes every good
 * trade at the first red candle or sits through a reversal all the way to the stop. So deterioration here
 * has to be VOTED for by several independent signals, and how many votes it takes depends on the style —
 * a five-minute wobble is evidence in a QUICK trade and is explicitly not evidence in a SWING one.
 */
import type { MarketSnapshot, Side, Timeframe } from "../core/types";
import { STYLE, type Style } from "../core/style";
import { toPips } from "../core/instrument";
import type { SnapshotDiff } from "./types";

export type LivePosition = {
  id: string;
  side: Side;
  style: Style;
  entry: number;
  qty: number;
  initQty: number;
  initStop: number;
  curStop: number;
  takeProfit: number | null;
  openedAt: number;
  pipSize: number;
  pipValuePerLot: number | null;
  mfePips: number;
  maePips: number;
  breakEvenAt: number | null;
  partials: { at: number; fraction: number; qty: number; price?: number }[];
  thesis: { reason?: string; expected?: string; invalidation?: string; invalidationPrice?: number } | null;
  aiManagement: boolean;
};

/* ── live numbers ───────────────────────────────────────────────────────── */

export type TradeMetrics = {
  price: number;
  pips: number;
  money: number | null;
  r: number | null;
  mfePips: number;
  maePips: number;
  giveBackPips: number;
  /** How much of the best it has given back, 0–1. The number profit protection actually cares about. */
  giveBackFraction: number;
  riskPips: number;
  distanceToStopPips: number;
  distanceToTargetPips: number | null;
  heldMs: number;
  beyondBreakEven: boolean;
  remainingFraction: number;
};

export function metrics(p: LivePosition, price: number, now = Date.now()): TradeMetrics {
  const dir = p.side === "buy" ? 1 : -1;
  const pips = toPips((price - p.entry) * dir, p.pipSize);
  const riskPips = Math.max(1e-6, toPips(Math.abs(p.entry - p.initStop), p.pipSize));
  const mfe = Math.max(p.mfePips, pips);
  const mae = Math.min(p.maePips, pips);
  const giveBack = Math.max(0, mfe - pips);

  return {
    price,
    pips: +pips.toFixed(1),
    money: p.pipValuePerLot != null ? +(pips * p.pipValuePerLot * p.qty).toFixed(2) : null,
    r: +(pips / riskPips).toFixed(2),
    mfePips: +mfe.toFixed(1),
    maePips: +mae.toFixed(1),
    giveBackPips: +giveBack.toFixed(1),
    giveBackFraction: mfe > 0 ? +(giveBack / mfe).toFixed(3) : 0,
    riskPips: +riskPips.toFixed(1),
    distanceToStopPips: +toPips(Math.abs(price - p.curStop), p.pipSize).toFixed(1),
    distanceToTargetPips: p.takeProfit != null ? +toPips(Math.abs(p.takeProfit - price), p.pipSize).toFixed(1) : null,
    heldMs: now - p.openedAt,
    beyondBreakEven: p.side === "buy" ? p.curStop >= p.entry : p.curStop <= p.entry,
    remainingFraction: p.initQty > 0 ? +(p.qty / p.initQty).toFixed(3) : 1,
  };
}

/* ── change of character ────────────────────────────────────────────────── */

export type Character =
  | "intact"              // nothing has changed that matters
  | "noise"               // movement against, but inside this style's noise floor
  | "normal_pullback"     // a pullback that has not damaged anything structural
  | "healthy_retest"      // it came back to the level and the level held
  | "momentum_slowdown"   // still going our way, just not accelerating
  | "thesis_weakening"    // several things have turned, but the reason still stands
  | "character_change"    // the behaviour of the market has genuinely changed
  | "invalidated";        // the reason we entered is gone

export type CharacterRead = {
  state: Character;
  votes: { signal: string; against: boolean; weight: number }[];
  score: number;             // 0 = perfect, higher = more deterioration
  headline: string;
  /** Written so it can be read aloud unchanged. */
  explanation: string;
};

const BULL = /strong_uptrend|uptrend|weak_uptrend|bullish/;
const BEAR = /strong_downtrend|downtrend|weak_downtrend|bearish/;

export function character(p: LivePosition, s: MarketSnapshot, m: TradeMetrics, diffs: SnapshotDiff[]): CharacterRead {
  const pol = STYLE[p.style];
  const long = p.side === "buy";
  const votes: { signal: string; against: boolean; weight: number }[] = [];
  const add = (signal: string, against: boolean, weight = 1) => votes.push({ signal, against, weight });

  /* 1 — hard invalidation first. If price has accepted through the level the trade depended on, nothing
         else in this function matters. */
  const inv = p.thesis?.invalidationPrice ?? null;
  const through = inv != null && (long ? s.price < inv : s.price > inv);
  if (through) {
    return {
      state: "invalidated",
      votes: [{ signal: `price accepted through ${inv!.toFixed(2)}`, against: true, weight: 3 }],
      score: 100,
      headline: "The original thesis is gone.",
      explanation: `Price has accepted ${long ? "below" : "above"} ${inv!.toFixed(2)}, which is the level this trade was built on. The reason we entered is no longer true.`,
    };
  }

  /* 2 — only the timeframes this STYLE listens to may vote. */
  for (const tf of pol.decisive as Timeframe[]) {
    const v = s.timeframes[tf];
    if (!v) continue;
    const withUs = long ? BULL.test(v.state) : BEAR.test(v.state);
    const againstUs = long ? BEAR.test(v.state) : BULL.test(v.state);
    if (againstUs) add(`${tf} turned ${v.state.replace(/_/g, " ")}`, true, tf === pol.decisive[0] ? 1.5 : 1);
    else if (withUs) add(`${tf} still ${v.state.replace(/_/g, " ")}`, false, 1);
  }

  /* 3 — structure on the decisive timeframe. */
  const exec = s.timeframes[pol.decisive[0] as Timeframe] ?? s.timeframes["5m"];
  if (exec) {
    const broke = exec.structure.brokeStructure;
    if (broke && ((long && broke === "down") || (!long && broke === "up"))) add("structure broke against the position", true, 2);
    const failed = exec.structure.failedBreak;
    if (failed && ((long && failed === "up") || (!long && failed === "down"))) add("the breakout that started this failed", true, 2);
    if (exec.structure.reclaimed && m.pips < 0) add("price reclaimed the level after losing it", false, 1);
  }

  /* 4 — pressure and momentum. */
  const pressureWithUs = long ? s.pressure.net > 0 : s.pressure.net < 0;
  if (!pressureWithUs && Math.abs(s.pressure.net) > 15) add(`${long ? "sellers" : "buyers"} have taken the pressure`, true, 1.5);
  else if (pressureWithUs && Math.abs(s.pressure.net) > 15) add(`${long ? "buyers" : "sellers"} still have pressure`, false, 1);

  const short = diffs.find((d) => d.horizon === "5m") ?? diffs[0];
  const decelerating = short?.velocityChange != null && short.velocityChange < 0 && m.pips > 0;
  if (decelerating) add("the move has stopped accelerating", true, 0.5);

  /* 5 — has it given back most of its best? */
  if (m.mfePips > pol.noiseFloorPips && m.giveBackFraction >= pol.giveBackFraction) {
    add(`given back ${Math.round(m.giveBackFraction * 100)}% of the best it saw`, true, 1.5);
  }

  /* 6 — has it simply done nothing for too long? Silence is evidence too. */
  if (m.heldMs > pol.stallMs && Math.abs(m.pips) < pol.noiseFloorPips) {
    add(`${Math.round(m.heldMs / 60_000)} minutes with no movement`, true, 1);
  }

  const against = votes.filter((v) => v.against);
  const score = against.reduce((a, v) => a + v.weight, 0);
  const needed = pol.characterVotesNeeded;

  /* 7 — classify. The order of these branches is the whole point: an adverse move is only allowed to be
         called deterioration AFTER it has cleared this style's noise floor. */
  const adverse = m.pips < 0;
  const insideNoise = Math.abs(m.pips) < pol.noiseFloorPips;

  let state: Character;
  if (score >= needed + 1.5) state = "character_change";
  else if (score >= needed) state = "thesis_weakening";
  else if (adverse && insideNoise) state = "noise";
  else if (adverse && score < needed) state = "normal_pullback";
  else if (exec?.structure.reclaimed && m.pips >= 0 && score < needed) state = "healthy_retest";
  else if (decelerating && score < needed) state = "momentum_slowdown";
  else state = "intact";

  const headline: Record<Character, string> = {
    intact: "The trade is doing what it was supposed to.",
    noise: "Movement against us, but inside the noise of this style.",
    normal_pullback: "This is a pullback, not damage.",
    healthy_retest: "The retest held.",
    momentum_slowdown: "Still our way, but it has stopped accelerating.",
    thesis_weakening: "The case for this trade is weaker than it was.",
    character_change: "The character of this move has changed.",
    invalidated: "The original thesis is gone.",
  };

  const forWords = votes.filter((v) => !v.against).map((v) => v.signal);
  const againstWords = against.map((v) => v.signal);
  const explanation = (() => {
    if (state === "intact" || state === "healthy_retest") {
      return forWords.length ? `${forWords.slice(0, 2).join(", and ")}. Nothing here needs changing.` : "Nothing has changed that matters.";
    }
    if (state === "noise") {
      return `We're ${Math.abs(Math.round(m.pips))} pips offside, which is inside what a ${STYLE[p.style].label} trade does on its own. I'm not reading anything into it.`;
    }
    if (state === "normal_pullback") {
      return `Price has come back${againstWords.length ? ` and ${againstWords[0]}` : ""}, but ${forWords.length ? forWords[0] : "the structure that supported this is still intact"}. I'd let it breathe.`;
    }
    if (state === "momentum_slowdown") {
      return `We're still onside${m.mfePips > 0 ? ` and the best was ${Math.round(m.mfePips)} pips` : ""}, but the move has stopped accelerating. That usually matters more than the direction of the last candle.`;
    }
    if (state === "thesis_weakening") {
      return `${againstWords.slice(0, 2).join(", and ")}. The trade is not broken, but the case for it is thinner than when we entered.`;
    }
    return `${againstWords.slice(0, 3).join(", ")}. This is no longer the move we entered.`;
  })();

  return { state, votes, score: +score.toFixed(1), headline: headline[state], explanation };
}

/* ── profit protection ──────────────────────────────────────────────────── */

export type ProtectionAction = "hold" | "break_even" | "protect_stop" | "partial" | "close";

export type Protection = {
  action: ProtectionAction;
  /** Where the stop would go, for the stop-moving actions. */
  price: number | null;
  fraction: number | null;
  urgency: "low" | "normal" | "high";
  /** Said out loud, unchanged. It always explains itself — an instruction without a reason is an order. */
  say: string;
};

/**
 * What THE BRAIN would do about this position right now, and why.
 *
 * It is biased toward HOLD on purpose. Protecting a trade costs a little upside every time it is wrong,
 * and closing a healthy trade early is the most expensive habit a trader can have.
 */
export function protection(p: LivePosition, m: TradeMetrics, ch: CharacterRead, s: MarketSnapshot): Protection {
  const pol = STYLE[p.style];
  const long = p.side === "buy";
  const hold = (say: string, urgency: Protection["urgency"] = "low"): Protection => ({ action: "hold", price: null, fraction: null, urgency, say });

  if (ch.state === "invalidated") {
    return {
      action: "close", price: null, fraction: null, urgency: "high",
      say: `${ch.explanation} I would close this rather than wait for the stop.`,
    };
  }

  if (ch.state === "character_change") {
    if (m.pips > 0) {
      const price = long ? Math.max(p.curStop, p.entry) : Math.min(p.curStop, p.entry);
      return {
        action: "protect_stop", price, fraction: null, urgency: "high",
        say: `${ch.explanation} You're ${Math.round(m.pips)} pips up. I would protect what is there rather than give it back.`,
      };
    }
    return {
      action: "close", price: null, fraction: null, urgency: "high",
      say: `${ch.explanation} We're not in profit to protect, so I would take the loss here rather than the full stop.`,
    };
  }

  // Give-back protection: it went well, and it is handing it back.
  if (m.mfePips > pol.noiseFloorPips * 2 && m.giveBackFraction >= pol.giveBackFraction && m.pips > 0) {
    const price = long ? Math.max(p.curStop, p.entry) : Math.min(p.curStop, p.entry);
    return {
      action: m.beyondBreakEven ? "protect_stop" : "break_even", price, fraction: null, urgency: "normal",
      say: `The best this saw was ${Math.round(m.mfePips)} pips and we're at ${Math.round(m.pips)}. It's handing back more than I'd like. I would protect the position and leave the rest running.`,
    };
  }

  // Partial: enough R banked, and the trade is not in trouble.
  const alreadyPartialed = p.partials.length > 0;
  if (!alreadyPartialed && (m.r ?? 0) >= pol.partialR && ch.state !== "thesis_weakening") {
    return {
      action: "partial", price: null, fraction: pol.partialFraction, urgency: "normal",
      say: `We're ${m.r}R up on a ${pol.label} trade. I would take ${Math.round(pol.partialFraction * 100)}% off here and let the rest run with the stop protected.`,
    };
  }

  // Break even: earned it, and the stop is still behind entry.
  if (!m.beyondBreakEven && (m.r ?? 0) >= pol.breakEvenR) {
    return {
      action: "break_even", price: long ? p.entry : p.entry, fraction: null, urgency: "low",
      say: `You're ${m.r}R up. I'd move the stop to break even — it costs nothing and it takes the loss off the table.`,
    };
  }

  if (ch.state === "thesis_weakening") {
    return m.pips > 0
      ? { action: "break_even", price: p.entry, fraction: null, urgency: "normal", say: `${ch.explanation} I wouldn't close it, but I would stop risking money on it.` }
      : hold(`${ch.explanation} It hasn't broken yet, so I'd give it until the stop or until the structure actually fails.`, "normal");
  }

  if (s.news.nextEvent && (s.news.minutesToNext ?? 999) <= 10 && m.pips > pol.noiseFloorPips) {
    return {
      action: "break_even", price: p.entry, fraction: null, urgency: "normal",
      say: `${s.news.nextEvent.name} is ${Math.round(s.news.minutesToNext ?? 0)} minutes away and you're ${Math.round(m.pips)} pips up. I'd protect this before the number rather than after it.`,
    };
  }

  return hold(ch.state === "intact" || ch.state === "healthy_retest"
    ? `${ch.explanation}${m.pips > 0 ? ` You're ${Math.round(m.pips)} pips up.` : ""} Nothing needs changing.`
    : ch.explanation);
}

/* ── trade-aware focus and question ─────────────────────────────────────── */

/** WHAT I'M WATCHING, once there is a position to watch it for. */
export function tradeFocus(p: LivePosition, m: TradeMetrics, s: MarketSnapshot): string[] {
  const out: string[] = [];
  const long = p.side === "buy";
  const ahead = s.levels
    .filter((l) => (long ? l.price > s.price : l.price < s.price))
    .sort((a, b) => Math.abs(a.price - s.price) - Math.abs(b.price - s.price))[0];
  if (ahead) out.push(`${ahead.label} at ${ahead.price.toFixed(2)} ahead of you`);
  out.push(`${long ? "5-minute bullish" : "5-minute bearish"} pressure holding`);
  if (!m.beyondBreakEven) out.push(`your break-even at ${p.entry.toFixed(2)}`);
  const oneR = long ? p.entry + m.riskPips * p.pipSize : p.entry - m.riskPips * p.pipSize;
  if ((m.r ?? 0) < 1) out.push(`your +1R level at ${oneR.toFixed(2)}`);
  if (p.thesis?.invalidationPrice) out.push(`the trade fails at ${p.thesis.invalidationPrice.toFixed(2)}`);
  if (s.news.nextEvent && (s.news.minutesToNext ?? 999) <= 90) out.push(`${s.news.nextEvent.name} in ${Math.round(s.news.minutesToNext ?? 0)} minutes`);
  return out.slice(0, 5);
}

/** THE QUESTION, once there is a position. */
export function tradeQuestion(p: LivePosition, m: TradeMetrics, ch: CharacterRead, s: MarketSnapshot): string {
  const long = p.side === "buy";
  if (ch.state === "invalidated") return "Is there any reason left to be in this?";
  if (ch.state === "character_change") return "How much of this can I still protect?";
  if (ch.state === "thesis_weakening") return "Has the original thesis actually failed, or just weakened?";
  if (ch.state === "normal_pullback" || ch.state === "noise") return "Is this pullback healthy?";
  if (m.pips < 0) return `Can ${long ? "buyers" : "sellers"} take this back?`;
  const ahead = s.levels
    .filter((l) => (long ? l.price > s.price : l.price < s.price))
    .sort((a, b) => Math.abs(a.price - s.price) - Math.abs(b.price - s.price))[0];
  if (ahead && Math.abs(ahead.price - s.price) / (s.timeframes["5m"]?.features.atr ?? 1) < 1) {
    return `Can momentum push through ${ahead.label}?`;
  }
  if ((m.r ?? 0) >= 1) return "How much more is there in this move?";
  return `Can ${long ? "buyers" : "sellers"} hold what they've taken?`;
}

/* ── the spoken trade read ──────────────────────────────────────────────── */

/** The answer to "how's my trade?" — the exact position, never generic advice. */
export function tradeRead(p: LivePosition, m: TradeMetrics, ch: CharacterRead, prot: Protection): string {
  const bits: string[] = [];
  const sign = m.pips >= 0 ? "up" : "down";
  bits.push(`You're ${Math.abs(Math.round(m.pips))} pips ${sign}${m.money != null ? `, ${m.money >= 0 ? "+" : "-"}$${Math.abs(m.money).toFixed(0)}` : ""}${m.r != null ? `, ${m.r}R` : ""}.`);
  if (m.mfePips > 0 || m.maePips < 0) {
    bits.push(`The best has been ${Math.round(m.mfePips)} pips and the worst ${Math.round(m.maePips)}.`);
  }
  bits.push(ch.explanation);
  if (prot.action !== "hold") bits.push(prot.say);
  else if (m.beyondBreakEven) bits.push("Your stop is already protected, so this costs nothing to hold.");
  return bits.join(" ");
}

/** A short line for the header of the trade panel. */
export const tradeThesisState = (ch: CharacterRead): string =>
  ch.state === "intact" || ch.state === "healthy_retest" ? "Healthy"
  : ch.state === "noise" || ch.state === "normal_pullback" ? "Holding"
  : ch.state === "momentum_slowdown" ? "Slowing"
  : ch.state === "thesis_weakening" ? "Weakening"
  : ch.state === "character_change" ? "Character changed"
  : "Invalidated";

/* ── position health ────────────────────────────────────────────────────── */

export type TradeHealth = {
  score: number;                                   // 0–100
  verdict: "strong" | "healthy" | "holding" | "weakening" | "at_risk";
  drivers: { label: string; delta: number }[];
};

/**
 * A 0–100 reading of how the POSITION is behaving. Deliberately not a probability and never presented as
 * one — it is a summary of evidence, and every point of it is attributable to a driver a member could
 * check on their own chart.
 */
export function health(p: LivePosition, m: TradeMetrics, ch: CharacterRead): TradeHealth {
  const pol = STYLE[p.style];
  const drivers: { label: string; delta: number }[] = [];
  let score = 70;
  const add = (label: string, delta: number) => { drivers.push({ label, delta }); score += delta; };

  for (const v of ch.votes) {
    const d = v.against ? -Math.round(v.weight * 7) : Math.round(v.weight * 4);
    add(v.signal, d);
  }

  if (m.pips > pol.noiseFloorPips) add(`${Math.round(m.pips)} pips onside`, Math.min(12, Math.round(m.pips / pol.noiseFloorPips) * 4));
  if (m.pips < -pol.noiseFloorPips) add(`${Math.round(Math.abs(m.pips))} pips offside`, -Math.min(14, Math.round(Math.abs(m.pips) / pol.noiseFloorPips) * 5));
  if (m.beyondBreakEven) add("stop is protected", 8);
  if (m.giveBackFraction >= pol.giveBackFraction && m.mfePips > pol.noiseFloorPips) {
    add(`gave back ${Math.round(m.giveBackFraction * 100)}% of the best`, -10);
  }
  if (p.partials.length) add("profit already banked", 6);
  if (ch.state === "invalidated") score = Math.min(score, 8);
  if (ch.state === "character_change") score = Math.min(score, 30);

  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict: TradeHealth["verdict"] =
    score >= 80 ? "strong" : score >= 64 ? "healthy" : score >= 48 ? "holding" : score >= 30 ? "weakening" : "at_risk";
  return { score, verdict, drivers: drivers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 6) };
}
