/**
 * THE PERCEPTION ENGINE — where measurements become things a trader would actually notice.
 *
 * A number changing is not an event. "Bullish pressure went from 54 to 71 while price reclaimed the London
 * high" is an event. This file is the line between the two, and it is deliberately conservative: if the
 * evidence is thin, no event is raised. Silence is a feature — see significance.ts.
 *
 * Every detector reads only real snapshot fields and real diffs. Nothing here invents market activity.
 */
import type { Level, MarketSnapshot, Timeframe } from "../core/types";
import { PIP } from "../core/types";
import type { EventCode, Horizon, PerceptionEvent, SnapshotDiff } from "./types";
import { diffFor } from "./diff";

const EXEC: Timeframe = "5m";
const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;
const px = (n: number) => n.toFixed(2);

/* ── thresholds ──────────────────────────────────────────────────────────────
   All distance and movement thresholds are ATR-relative, so "a big move" means
   the same thing on a dead Tuesday and during CPI. Percentages are absolute
   because pressure is already a 0–100 scale. */
const T = {
  moveAtr: 0.8,             // a move worth naming, in ATR of the 5m read
  bigMoveAtr: 1.6,
  pressureMove: 12,         // points of net pressure
  pressureBigMove: 22,
  atrExpand: 1.35,          // volatility ratio over the window
  atrCompress: 0.72,
  velocityJump: 0.4,        // relative change in velocity
  levelTouchAtr: 0.18,      // inside this, price is AT the level
  levelNearAtr: 0.55,       // inside this, price is approaching it
  zUnusual: 2.6,            // standardised move that does not belong to the recent distribution
  newsSoonMin: 15,
};

const ev = (
  at: number,
  code: EventCode,
  detail: string,
  opts: Partial<Pick<PerceptionEvent, "horizon" | "timeframe" | "data" | "level" | "lean">> = {},
): Omit<PerceptionEvent, "significance" | "channel"> => ({
  key: `${code}:${opts.horizon ?? "-"}:${opts.level ? px(opts.level.price) : opts.timeframe ?? "-"}:${Math.floor(at / 60_000)}`,
  at,
  code,
  horizon: opts.horizon ?? null,
  timeframe: opts.timeframe ?? null,
  detail,
  data: opts.data ?? {},
  level: opts.level ?? null,
  lean: opts.lean ?? "neutral",
});

/** The level price is closest to, with its distance in ATR. Null when the read has no levels or no ATR. */
export function nearestLevel(s: MarketSnapshot): { level: Level; distAtr: number } | null {
  const atr = s.timeframes[EXEC]?.features.atr;
  if (!atr || atr <= 0 || !s.levels.length) return null;
  let best: { level: Level; distAtr: number } | null = null;
  for (const l of s.levels) {
    const d = Math.abs(s.price - l.price) / atr;
    if (!best || d < best.distAtr) best = { level: l, distAtr: +d.toFixed(2) };
  }
  return best;
}

/** Did price cross this level between the two snapshots, and which way? */
function crossed(from: number, to: number, level: number): "up" | "down" | null {
  if (from < level && to >= level) return "up";
  if (from > level && to <= level) return "down";
  return null;
}

export type PerceiveInput = {
  now: MarketSnapshot;
  prev: MarketSnapshot | null;
  diffs: SnapshotDiff[];
  /** Keys already raised recently, so the same observation is not re-announced every tick. */
  seenKeys?: Set<string>;
};

/**
 * Turn the current read and its differences into the events a trader would have noticed.
 * Returns them unscored — significance.ts decides which of these are allowed to make a sound.
 */
export function detect(i: PerceiveInput): Omit<PerceptionEvent, "significance" | "channel">[] {
  const { now, prev, diffs } = i;
  const out: Omit<PerceptionEvent, "significance" | "channel">[] = [];
  const at = now.at;
  const exec = now.timeframes[EXEC];
  const atr = exec?.features.atr ?? null;

  /* ── data integrity first. A degraded feed outranks every market observation. ── */
  for (const b of now.blockers) {
    if (b.code === "market_closed") out.push(ev(at, "MARKET_CLOSED", "Gold is closed.", { data: {} }));
    else if (b.code === "feed_stale" || b.code === "feed_divergence" || b.code === "exec_data_gaps" || b.code === "exec_data_behind") {
      out.push(ev(at, "FEED_DEGRADED", b.detail, { data: {} }));
    }
  }
  if (prev && prev.session === "closed" && now.session !== "closed") {
    out.push(ev(at, "MARKET_OPENED", `Gold is open again — ${now.session.replace("_", " ")} session.`, {}));
  }
  if (prev && prev.session !== now.session && now.session !== "closed" && prev.session !== "closed") {
    out.push(ev(at, "SESSION_TRANSITION", `${now.session.replace("_", " ")} session has taken over.`, {
      data: { from: prev.session, to: now.session },
    }));
  }

  /* ── movement and volatility, per horizon ── */
  for (const d of diffs) {
    const win = windowWords(d.horizon);

    if (d.moveAtr != null && Math.abs(d.moveAtr) >= T.moveAtr) {
      const up = d.priceMove > 0;
      const big = Math.abs(d.moveAtr) >= T.bigMoveAtr;
      out.push(ev(at, up ? "MOMENTUM_ACCELERATION" : "MOMENTUM_ACCELERATION",
        `${big ? "Sharp" : "Decisive"} ${up ? "push higher" : "drop"} — ${money(d.priceMove)} ${win}.`, {
          horizon: d.horizon, lean: up ? "bullish" : "bearish",
          data: { pips: d.pipsMove, atr: d.moveAtr, from: d.priceFrom, to: d.priceTo },
        }));
    }

    if (d.atrRatio != null) {
      if (d.atrRatio >= T.atrExpand) {
        out.push(ev(at, "VOLATILITY_EXPANSION", `Volatility is expanding — ranges are ${Math.round((d.atrRatio - 1) * 100)}% wider than ${win}.`, {
          horizon: d.horizon, data: { ratio: d.atrRatio, atr: d.atrTo },
        }));
      } else if (d.atrRatio <= T.atrCompress) {
        out.push(ev(at, "VOLATILITY_COMPRESSION", `Price is compressing — ranges have tightened since ${win}.`, {
          horizon: d.horizon, data: { ratio: d.atrRatio, atr: d.atrTo },
        }));
      }
    }

    if (d.velocityChange != null && d.velocityFrom != null && Math.abs(d.velocityFrom) > 1e-6) {
      const rel = d.velocityChange / Math.abs(d.velocityFrom);
      if (rel >= T.velocityJump && Math.abs(d.velocityTo ?? 0) > Math.abs(d.velocityFrom)) {
        out.push(ev(at, "PRICE_ACCELERATION", `Price is moving faster than it was ${win}.`, {
          horizon: d.horizon, data: { velocity: d.velocityTo, change: d.velocityChange },
        }));
      } else if (rel <= -T.velocityJump) {
        out.push(ev(at, "PRICE_DECELERATION", `The move is losing speed — slower than ${win}.`, {
          horizon: d.horizon, data: { velocity: d.velocityTo, change: d.velocityChange },
        }));
      }
    }

    /* ── pressure ── */
    if (d.pressureFlipped) {
      const toBulls = d.pressureTo > 0;
      out.push(ev(at, "PRESSURE_FLIP", `Control has changed hands — ${toBulls ? "buyers" : "sellers"} are now in front.`, {
        horizon: d.horizon, lean: toBulls ? "bullish" : "bearish",
        data: { from: d.pressureFrom, to: d.pressureTo },
      }));
    } else if (Math.abs(d.pressureChange) >= T.pressureMove) {
      // Direction alone is not the story: pressure moving from -32 to -18 is SELLERS EASING, not buyers
      // taking over. Getting this wrong is how a dashboard ends up cheerfully calling a downtrend bullish.
      const p = pressureWords(d.pressureFrom, d.pressureTo, Math.abs(d.pressureChange) >= T.pressureBigMove, win);
      out.push(ev(at, p.code, p.text, {
        horizon: d.horizon, lean: p.lean,
        data: { from: d.pressureFrom, to: d.pressureTo, change: d.pressureChange },
      }));
    }

    /* ── regime and timeframe transitions ── */
    if (d.regimeChanged) {
      out.push(ev(at, "REGIME_CHANGE", `The character of the market changed — ${words(d.regimeFrom)} into ${words(d.regimeTo)}.`, {
        horizon: d.horizon, data: { from: d.regimeFrom, to: d.regimeTo },
      }));
    }
    for (const c of d.tfChanges) {
      if (c.direction === "sideways") continue;
      out.push(ev(at, c.direction === "more_bullish" ? "TIMEFRAME_ALIGNMENT" : "TIMEFRAME_CONFLICT",
        `${c.tf} flipped from ${words(c.from)} to ${words(c.to)}.`, {
          horizon: d.horizon, timeframe: c.tf,
          lean: c.direction === "more_bullish" ? "bullish" : "bearish",
          data: { from: c.from, to: c.to },
        }));
    }

    /* ── structure ── */
    if (d.brokeStructure) {
      out.push(ev(at, "STRUCTURE_BREAK", `5-minute structure broke to the ${d.brokeStructure === "up" ? "upside" : "downside"}.`, {
        horizon: d.horizon, lean: d.brokeStructure === "up" ? "bullish" : "bearish", data: { direction: d.brokeStructure },
      }));
    }
    if (d.failedBreak) {
      out.push(ev(at, "FAILED_BREAKOUT", `That ${d.failedBreak === "up" ? "upside" : "downside"} break failed — price came back inside.`, {
        horizon: d.horizon, lean: d.failedBreak === "up" ? "bearish" : "bullish", data: { direction: d.failedBreak },
      }));
    }
    if (d.reclaimed) {
      out.push(ev(at, "STRUCTURE_RECLAIM", "Price reclaimed the level it had lost.", { horizon: d.horizon, lean: "bullish" }));
    }
  }

  /* ── levels: approach, touch, rejection, acceptance ── */
  const near = nearestLevel(now);
  if (near && atr) {
    const { level, distAtr } = near;
    if (distAtr <= T.levelTouchAtr) {
      out.push(ev(at, "LEVEL_TOUCH", `Price is right at ${level.label} (${px(level.price)}).`, {
        level, data: { distAtr, price: now.price },
      }));
    } else if (distAtr <= T.levelNearAtr) {
      const above = now.price > level.price;
      out.push(ev(at, "LEVEL_APPROACH", `Approaching ${level.label} at ${px(level.price)} from ${above ? "above" : "below"}.`, {
        level, data: { distAtr, price: now.price },
      }));
    }
  }
  const short = diffFor(diffs, "5m") ?? diffFor(diffs, "1m");
  if (short && atr) {
    for (const l of now.levels.slice(0, 8)) {
      const x = crossed(short.priceFrom, short.priceTo, l.price);
      if (!x) continue;
      const beyond = Math.abs(now.price - l.price) / atr;
      if (beyond >= 0.35) {
        out.push(ev(at, "LEVEL_ACCEPTANCE", `Price has accepted ${x === "up" ? "above" : "below"} ${l.label} (${px(l.price)}).`, {
          level: l, lean: x === "up" ? "bullish" : "bearish", data: { beyondAtr: +beyond.toFixed(2) },
        }));
        out.push(ev(at, "BREAKOUT_ATTEMPT", `Breakout ${x === "up" ? "above" : "below"} ${l.label} is underway.`, {
          level: l, lean: x === "up" ? "bullish" : "bearish", data: { price: now.price },
        }));
      } else {
        out.push(ev(at, "LEVEL_REJECTION", `${l.label} at ${px(l.price)} pushed price back — no acceptance yet.`, {
          level: l, lean: x === "up" ? "bearish" : "bullish", data: { beyondAtr: +beyond.toFixed(2) },
        }));
      }
    }
  }

  /* ── retest: price came back to a level it had recently left, and is holding or failing ── */
  if (near && atr && short && near.distAtr <= T.levelNearAtr) {
    const cameBack = Math.abs(short.priceFrom - near.level.price) / atr > T.levelNearAtr;
    if (cameBack) {
      const holding = (short.priceFrom > near.level.price && now.price >= near.level.price)
                   || (short.priceFrom < near.level.price && now.price <= near.level.price);
      out.push(ev(at, holding ? "RETEST_HOLDING" : "RETEST_FAILING",
        holding ? `Retest of ${near.level.label} is holding so far.` : `The retest of ${near.level.label} is not holding.`, {
          level: near.level, lean: holding ? (short.priceFrom > near.level.price ? "bullish" : "bearish") : "neutral",
          data: { distAtr: near.distAtr },
        }));
    }
  }

  /* ── sweeps and behaviour that does not fit the recent distribution ── */
  const swept = exec?.structure.sweptLevel ?? null;
  if (swept != null && prev?.timeframes[EXEC]?.structure.sweptLevel !== swept) {
    out.push(ev(at, "LIQUIDITY_SWEEP", `Liquidity was taken at ${px(swept)} before price turned.`, { data: { level: swept } }));
  }
  const z = exec?.features.zScore;
  if (z != null && Math.abs(z) >= T.zUnusual) {
    out.push(ev(at, "UNUSUAL_PRICE_BEHAVIOR", `This move is well outside the recent range of behaviour — treat short-term signals carefully.`, {
      lean: "neutral", data: { z: +z.toFixed(2) },
    }));
  }

  /* ── news ── */
  const n = now.news;
  if (n.nextEvent && n.minutesToNext != null && n.minutesToNext <= T.newsSoonMin && n.minutesToNext >= 0) {
    out.push(ev(at, "NEWS_APPROACHING", `${n.nextEvent.name} is ${Math.round(n.minutesToNext)} minutes away.`, {
      data: { minutes: Math.round(n.minutesToNext), importance: n.nextEvent.importance },
    }));
  }
  if (prev?.news.nextEvent && !n.nextEvent && prev.news.minutesToNext != null && prev.news.minutesToNext <= 2) {
    out.push(ev(at, "NEWS_RELEASED", `${prev.news.nextEvent.name} has been released — this is price discovery, not a normal breakout.`, {}));
  }

  return out;
}

/**
 * Say what actually happened to pressure. Four cases, because the sign matters as much as the direction:
 * buyers can strengthen, buyers can fade, sellers can strengthen, sellers can fade — and "pressure went
 * up" describes two completely different markets depending on which side of zero it was on.
 */
function pressureWords(from: number, to: number, big: boolean, win: string): { code: EventCode; text: string; lean: PerceptionEvent["lean"] } {
  const rising = to > from;
  const much = big ? "much " : "";
  const range = `${Math.round(from)} to ${Math.round(to)}`;
  if (rising && to > 0) {
    return { code: "BULLISH_PRESSURE_RISING", lean: "bullish", text: `Buyers are getting ${much}stronger — pressure ${range} ${win}.` };
  }
  if (rising) {
    // still negative: sellers are easing off rather than buyers taking control
    return { code: "BULLISH_PRESSURE_RISING", lean: "bullish", text: `Sellers are easing off — pressure ${range} ${win}, but buyers have not taken over.` };
  }
  if (from > 0) {
    return { code: "BULLISH_PRESSURE_COLLAPSING", lean: "bearish", text: `Buyers are losing the grip they had ${win} — pressure ${range}.` };
  }
  return { code: "BEARISH_PRESSURE_RISING", lean: "bearish", text: `Sellers are getting ${much}stronger — pressure ${range} ${win}.` };
}

function windowWords(h: Horizon): string {
  return h === "1m" ? "in the last minute" : h === "5m" ? "over five minutes" : h === "15m" ? "over fifteen minutes" : "over the last hour";
}
const words = (s: string) => s.replace(/_/g, " ");
export const pipsOf = (a: number, b: number) => Math.round((b - a) / PIP);
