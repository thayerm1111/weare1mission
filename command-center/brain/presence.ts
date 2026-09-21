/**
 * BRAIN PRESENCE — the state the interface breathes to.
 *
 * Everything here is derived from real measurements. `intensity` is what makes the visual pulse faster,
 * and it is volatility and velocity — never a timer, never a random walk. If the market is dead, the
 * screen is still, and that stillness is information.
 */
import type { MarketSnapshot, Timeframe } from "../core/types";
import type { BrainState, BrainThesis, PerceptionEvent, Presence } from "./types";
import { biasDirection } from "./thesis";
import { nearestLevel } from "./perception";

const EXEC: Timeframe = "5m";
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** Market weather — the honest, human summary of how violent the tape is. */
export type Weather = "quiet" | "compressed" | "normal" | "active" | "expanding" | "extreme" | "news_shock";

export function weather(s: MarketSnapshot): Weather {
  const f = s.timeframes[EXEC]?.features;
  if (!f) return "quiet";
  if (s.regime === "news_shock" || s.regime === "post_news_discovery") return "news_shock";
  const vr = f.volRatio;
  const rx = f.rangeExpansion;
  if (vr >= 1.9 || rx >= 2.1) return "extreme";
  if (vr >= 1.35 || rx >= 1.5) return "expanding";
  if (vr >= 1.1) return "active";
  if (vr <= 0.62 || s.regime === "compression" || s.regime === "volatility_squeeze") return "compressed";
  if (vr <= 0.85) return "quiet";
  return "normal";
}

/** Speed, in words a trader uses. Acceleration decides between "fast" and "accelerating". */
export type VelocityBand = "calm" | "building" | "fast" | "accelerating" | "extreme" | "decelerating";

export function velocityBand(s: MarketSnapshot): VelocityBand {
  const f = s.timeframes[EXEC]?.features;
  if (!f || !f.atr) return "calm";
  const rel = Math.abs(f.velocity) / f.atr;          // move per bar relative to normal range
  const accel = f.acceleration;
  if (accel < -0.15 && rel > 0.3) return "decelerating";
  if (rel >= 1.25) return "extreme";
  if (rel >= 0.8) return accel > 0.05 ? "accelerating" : "fast";
  if (rel >= 0.4) return "building";
  return "calm";
}

/** 0 = perfectly still, 100 = violent. This is what Atlas core visual breathes to. */
export function intensity(s: MarketSnapshot): number {
  const f = s.timeframes[EXEC]?.features;
  if (!f) return 4;
  const vol = clamp((f.volRatio - 0.55) * 62);                       // normal (1.0) ≈ 28
  const speed = f.atr > 0 ? clamp((Math.abs(f.velocity) / f.atr) * 55) : 0;
  const expansion = clamp((f.rangeExpansion - 0.8) * 45);
  const news = s.news.inLockout ? 18 : 0;
  return Math.round(clamp(vol * 0.42 + speed * 0.38 + expansion * 0.2 + news));
}

export type PresenceInput = {
  snapshot: MarketSnapshot;
  thesis: BrainThesis | null;
  events: PerceptionEvent[];
  tradeActive?: boolean;
  tradeProtecting?: boolean;
};

export function presenceOf(i: PresenceInput): Presence {
  const { snapshot: s, events } = i;
  if (!s.timeframes[EXEC] && s.blockers.some((b) => b.code === "no_exec_read")) return "offline";
  if (s.blockers.some((b) => b.code === "feed_stale" || b.code === "feed_divergence")) return "offline";
  if (s.session === "closed") return "market_closed";
  if (i.tradeProtecting) return "protecting_trade";
  if (i.tradeActive) return "trade_active";

  const highNews = s.news.inLockout || (s.news.minutesToNext != null && s.news.minutesToNext <= 10 && s.news.nextEvent?.importance === "high");
  if (highNews) return "high_news_risk";

  if (s.regime === "chaotic" || i.thesis?.bias === "stand_aside") return "market_unclear";

  const shift = events.some((e) => e.code === "REGIME_CHANGE" || e.code === "PRESSURE_FLIP" || e.code === "STRUCTURE_BREAK" || e.code === "FAILED_BREAKOUT");
  if (shift) return "market_shift";

  const loud = events.some((e) => e.channel === "voice" || e.channel === "urgent" || e.significance.score >= 70);
  if (loud) return "attention";

  const near = nearestLevel(s);
  if (near && near.distAtr <= 0.55) return "watching_level";

  const w = weather(s);
  if (w === "quiet" || w === "compressed") return "calm";
  return "observing";
}

/** The one line under the presence word. Short, specific, and about the market — not about itself. */
function headlineOf(i: PresenceInput, p: Presence): string {
  const { snapshot: s, events, thesis } = i;
  const loud = events.find((e) => e.channel === "urgent") ?? events.find((e) => e.channel === "voice") ?? events[0];
  switch (p) {
    case "offline": return s.blockers[0]?.detail ?? "No usable market data.";
    case "market_closed": return "Gold is closed. Nothing to read until it reopens.";
    case "high_news_risk":
      return s.news.nextEvent
        ? `${s.news.nextEvent.name} in ${Math.round(s.news.minutesToNext ?? 0)} minutes — short-term signals are unreliable here.`
        : "High-impact news window.";
    case "market_unclear": return "I don't have a clean read on this. I'd rather say so than invent one.";
    case "market_shift": return loud?.detail ?? "The character of the market just changed.";
    case "attention": return loud?.detail ?? "Something is developing.";
    case "watching_level": {
      const n = nearestLevel(s);
      return n ? `Price is at ${n.level.label} (${n.level.price.toFixed(2)}).` : "Price is at a level that matters.";
    }
    case "calm": {
      const f = s.timeframes[EXEC]?.structure;
      return f?.rangeHigh && f?.rangeLow
        ? `Quiet — contained between ${f.rangeLow.toFixed(2)} and ${f.rangeHigh.toFixed(2)}.`
        : "Quiet. Nobody has taken control yet.";
    }
    default:
      return thesis && thesis.bias !== "neutral"
        ? `${thesis.label} — ${Math.abs(Math.round(s.pressure.net))}% pressure with ${s.pressure.net >= 0 ? "buyers" : "sellers"}.`
        : "Watching. Nothing worth acting on yet.";
  }
}

/** What it is watching, most important first. Real levels and real risks only. */
function focusOf(i: PresenceInput): string[] {
  const { snapshot: s, thesis } = i;
  const out: string[] = [];
  const near = nearestLevel(s);
  if (near) out.push(`${near.level.label} at ${near.level.price.toFixed(2)}`);
  for (const w of thesis?.watching ?? []) {
    const l = s.levels.find((x) => Math.abs(x.price - w) < 0.01);
    const line = l ? `${l.label} at ${l.price.toFixed(2)}` : `${w.toFixed(2)}`;
    if (!out.includes(line)) out.push(line);
  }
  const exec = s.timeframes[EXEC];
  if (exec) out.push(`5-minute ${s.pressure.net >= 0 ? "bullish" : "bearish"} pressure`);
  if (s.news.nextEvent && s.news.minutesToNext != null && s.news.minutesToNext <= 90) {
    out.push(`${s.news.nextEvent.name} in ${Math.round(s.news.minutesToNext)} minutes`);
  }
  if (thesis?.invalidationPrice != null) out.push(`Read fails at ${thesis.invalidationPrice.toFixed(2)}`);
  return out.slice(0, 5);
}

/**
 * The question it is currently trying to resolve. Showing this is more honest than pretending it always
 * has an answer — and it is the thing that makes it feel like it is actively interpreting the market.
 */
function questionOf(i: PresenceInput): string {
  const { snapshot: s, thesis, events } = i;
  if (s.session === "closed") return "Where will gold open?";
  if (s.blockers.length) return "Can I trust this data?";
  const near = nearestLevel(s);
  const broke = events.find((e) => e.code === "LEVEL_ACCEPTANCE" || e.code === "BREAKOUT_ATTEMPT");
  const retest = events.find((e) => e.code.startsWith("RETEST"));
  if (retest && near) return `Will the retest of ${near.level.label} hold?`;
  if (broke && broke.level) return `Can ${broke.lean === "bullish" ? "buyers" : "sellers"} hold ${broke.level.label}?`;
  if (near && near.distAtr <= 0.55) {
    const above = s.price < near.level.price;
    return `Can ${above ? "buyers" : "sellers"} get acceptance ${above ? "above" : "below"} ${near.level.label}?`;
  }
  if (thesis?.bias === "breakout_watch") return "Which way does this compression resolve?";
  if (thesis?.bias === "range_fade") return "Does this range edge hold, or does it break?";
  if (thesis && thesis.bias !== "neutral") return `Is ${thesis.label.toLowerCase()} still working?`;
  return "Who is going to take control of this session?";
}

export function brainState(i: PresenceInput): BrainState {
  const p = presenceOf(i);
  return {
    at: i.snapshot.at,
    presence: p,
    headline: headlineOf(i, p),
    focus: focusOf(i),
    question: questionOf(i),
    intensity: p === "market_closed" || p === "offline" ? 2 : intensity(i.snapshot),
    lean: Math.round(clamp(i.snapshot.pressure.net, -100, 100)),
  };
}

export { biasDirection };
