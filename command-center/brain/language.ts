/**
 * THE BRAIN'S VOICE — deterministic trader language.
 *
 * Two jobs. First, this is how perception becomes something a person wants to hear: "buyers are getting
 * stronger", not "bullish price-pressure score has increased". Second, it is the REAL fallback when no
 * language model is configured — every sentence below is generated from measured state, so the product
 * still speaks truthfully rather than faking intelligence with canned filler.
 *
 * Rules it follows: no hype, no certainty it has not earned, and it is allowed to say "I don't know".
 */
import type { MarketSnapshot, Timeframe } from "../core/types";
import type { BrainMemory, BrainResponse, Horizon, SnapshotDiff, UiAction } from "./types";
import { diffFor } from "./diff";
import { velocityBand, weather } from "./presence";

const EXEC: Timeframe = "5m";
const px = (n: number) => n.toFixed(2);
const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;
const words = (s: string | null | undefined) => (s ? s.replace(/_/g, " ") : "");
const join = (xs: string[]) => (xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const HORIZON_WORDS: Record<Horizon, string> = {
  "1m": "the last minute", "5m": "the last five minutes", "15m": "the last fifteen minutes", "1h": "the last hour",
};

/* ───────────────────────── the situation, in one or two sentences ───────────────────────── */

export function marketRead(m: BrainMemory): string {
  const s = m.now;
  if (!s) return "I don't have a market read right now — the feed hasn't given me anything usable.";
  if (s.blockers.length) return `I can't read this properly: ${s.blockers[0].detail.toLowerCase()}.`;
  if (s.session === "closed") return "Gold is closed, so there's nothing live to read.";

  const bits: string[] = [];
  bits.push(`XAUUSD is at ${px(s.price)}`);

  const ctx = (["4h", "1h"] as Timeframe[]).map((tf) => s.timeframes[tf]?.state).filter(Boolean);
  if (ctx.length) bits.push(`higher timeframes are ${words(ctx[0])}`);

  const p = Math.abs(Math.round(s.pressure.net));
  if (p >= 10) bits.push(`${s.pressure.net > 0 ? "buyers" : "sellers"} have the edge at ${p}`);
  else bits.push("neither side has taken control");

  const w = weather(s);
  if (w === "compressed" || w === "quiet") bits.push("and it's quiet");
  else if (w === "expanding" || w === "extreme") bits.push("and volatility is picking up");

  return `${join(bits)}.`;
}

/* ───────────────────────── what changed ───────────────────────── */

function changeLines(d: SnapshotDiff): string[] {
  const out: string[] = [];
  if (Math.abs(d.pipsMove) >= 10) {
    out.push(`price ${d.priceMove > 0 ? "gained" : "lost"} ${money(d.priceMove)} (${Math.abs(d.pipsMove)} pips)`);
  }
  if (Math.abs(d.pressureChange) >= 8) {
    out.push(`pressure moved from ${Math.round(d.pressureFrom)} to ${Math.round(d.pressureTo)}`);
  }
  if (d.pressureFlipped) out.push(`control flipped to ${d.pressureTo > 0 ? "buyers" : "sellers"}`);
  if (d.regimeChanged) out.push(`the market went from ${words(d.regimeFrom)} to ${words(d.regimeTo)}`);
  for (const c of d.tfChanges.slice(0, 2)) out.push(`${c.tf} turned ${words(c.to)}`);
  if (d.atrRatio != null && d.atrRatio >= 1.3) out.push("ranges widened");
  if (d.atrRatio != null && d.atrRatio <= 0.75) out.push("ranges tightened");
  if (d.brokeStructure) out.push(`structure broke to the ${d.brokeStructure === "up" ? "upside" : "downside"}`);
  if (d.failedBreak) out.push(`the ${d.failedBreak === "up" ? "upside" : "downside"} break failed`);
  if (d.reclaimed) out.push("price reclaimed the level it had lost");
  return out;
}

export function whatChanged(m: BrainMemory, horizon: Horizon = "5m"): string {
  const d = diffFor(m.diffs, horizon) ?? m.diffs[0] ?? null;
  if (!d) return "I don't have enough history yet to tell you what changed — I've only just started watching.";
  const lines = changeLines(d);
  const window = HORIZON_WORDS[d.horizon];
  if (!lines.length) return `Nothing material changed over ${window}. Price has been going sideways and nobody has done anything worth reacting to.`;

  let out = `Over ${window}, ${lines.length === 1 ? "one thing" : `${lines.length} things`} changed. ${join(lines)}.`;
  if (m.thesis) {
    out += ` My read is still ${m.thesis.label.toLowerCase()}`;
    if (m.thesis.invalidationPrice != null) out += `, and the thing that would break it is ${px(m.thesis.invalidationPrice)}`;
    out += ".";
  }
  return out;
}

/* ───────────────────────── why, and what would change its mind ───────────────────────── */

export function why(m: BrainMemory): string {
  const t = m.thesis;
  if (!t) return "I don't have a firm read at the moment, so there's nothing to justify.";
  if (t.bias === "stand_aside") return `I'm standing aside. ${t.reasonStarted[0] ?? "The data isn't good enough to act on."}`;
  const reasons = [...t.reasonStarted, ...t.reasonStrengthened].filter(Boolean).slice(0, 3);
  if (!reasons.length) return `My read is ${t.label.toLowerCase()}, but honestly the evidence is thin.`;
  const head = reasons.length === 1 ? "One reason" : `${reasons.length === 2 ? "Two" : "Three"} reasons`;
  let out = `${head}. ${reasons.map((r) => r.replace(/\.$/, "")).join(". ")}.`;
  if (t.confidence < 55) out += " I'm not fully committed to it — the evidence is suggestive rather than strong.";
  return out;
}

export function whatWouldChangeMyMind(m: BrainMemory): string {
  const t = m.thesis;
  const s = m.now;
  if (!t || !s) return "Without a read there's nothing to change.";
  const dir = t.bias.startsWith("bullish") ? "bullish" : t.bias.startsWith("bearish") ? "bearish" : null;
  if (t.invalidationPrice == null || !dir) {
    return "Mostly a clean break of the range with pressure behind it. Until that happens I'd stay where I am.";
  }
  const side = dir === "bullish" ? "below" : "above";
  return `A five-minute acceptance ${side} ${px(t.invalidationPrice)} with ${dir === "bullish" ? "bearish" : "bullish"} pressure expanding would do it. That's the level the whole read depends on — losing it means I was wrong about who is in control, not just early.`;
}

/* ───────────────────────── the spoken briefing ───────────────────────── */

export function briefing(m: BrainMemory): string {
  const s = m.now;
  if (!s) return "I can't see the market right now. The feed isn't delivering, so I'd rather tell you that than guess.";
  if (s.session === "closed") {
    return `Gold is closed. The last thing I saw was ${px(s.price)}. I'll pick the read back up when it reopens.`;
  }
  if (s.blockers.length) {
    return `I'm not going to give you a read right now — ${s.blockers[0].detail.toLowerCase()}. Acting on data I can't trust is worse than waiting.`;
  }

  const parts: string[] = [];
  parts.push(`XAUUSD is trading at ${px(s.price)}.`);

  const h4 = s.timeframes["4h"]?.state;
  const m15 = s.timeframes["15m"]?.state;
  const m5 = s.timeframes[EXEC]?.state;
  if (h4 && m5) {
    const agree = (h4.includes("up") && m5.includes("up")) || (h4.includes("down") && m5.includes("down"));
    parts.push(agree
      ? `The four hour and the five minute are pointing the same way — ${words(h4)} into ${words(m5)}.`
      : `The four hour is ${words(h4)} but the five minute is ${words(m5)}, so the timeframes aren't agreeing yet.`);
  } else if (m5) parts.push(`The five minute is ${words(m5)}.`);
  if (m15 && m15 !== m5) parts.push(`Fifteen minute is ${words(m15)}.`);

  const p = Math.round(s.pressure.net);
  parts.push(Math.abs(p) < 10
    ? "Pressure is close to balanced — nobody has proven anything yet."
    : `${p > 0 ? "Buyers" : "Sellers"} have the pressure at ${Math.abs(p)}, ${Math.abs(p) > 30 ? "and it's decisive" : "but not decisively"}.`);

  const near = m.watchedLevels[0];
  if (near) parts.push(`The level I'm watching is ${near.label} at ${px(near.price)}.`);

  const d = diffFor(m.diffs, "15m") ?? diffFor(m.diffs, "5m");
  if (d) {
    const lines = changeLines(d);
    if (lines.length) parts.push(`Over ${HORIZON_WORDS[d.horizon]}, ${join(lines.slice(0, 2))}.`);
  }

  const vb = velocityBand(s);
  if (vb === "extreme" || vb === "accelerating") parts.push("Price is moving quickly right now, so I'd be careful chasing.");
  if (vb === "decelerating") parts.push("The move is losing speed, which usually matters more than the direction of the last candle.");

  if (m.thesis && m.thesis.bias !== "neutral") {
    parts.push(`My read is ${m.thesis.label.toLowerCase()}${m.thesis.confidence < 55 ? ", held loosely" : ""}.`);
    if (m.thesis.invalidationPrice != null) parts.push(`If we lose ${px(m.thesis.invalidationPrice)}, that read is wrong.`);
  } else {
    parts.push("I don't have a strong view here. I'd wait.");
  }

  if (s.news.nextEvent && s.news.minutesToNext != null && s.news.minutesToNext <= 60) {
    parts.push(`${s.news.nextEvent.name} is ${Math.round(s.news.minutesToNext)} minutes away, so I'd treat short-term signals carefully until it's out.`);
  }

  return parts.join(" ");
}

/* ───────────────────────── the deterministic answering path ───────────────────────── */

type Intent =
  | "briefing" | "what_changed" | "why" | "change_mind" | "level" | "thesis_history"
  | "timeframe" | "trade" | "math" | "scalp" | "swing" | "setup" | "unknown";

export function classify(q: string): { intent: Intent; arg: string | null } {
  // People address it by name — "THE BRAIN, talk to me" — so the vocative is stripped before matching.
  const t = q.toLowerCase().trim()
    .replace(/^(hey |ok |okay )?(the )?brain[,:]?\s*/i, "")
    .replace(/^(hey|ok|okay)[,:]?\s*/i, "")
    .trim();
  if (/^(talk to me|brief|briefing|what('s| is) going on|how does .* look|give me the read|what do you see)/.test(t)) return { intent: "briefing", arg: null };
  if (/what changed|what('s| has) changed|anything change/.test(t)) return { intent: "what_changed", arg: /hour/.test(t) ? "1h" : /fifteen|15/.test(t) ? "15m" : /minute\b/.test(t) && !/five|5/.test(t) ? "1m" : "5m" };
  if (/change your mind|would make you (bearish|bullish)|what would change/.test(t)) return { intent: "change_mind", arg: null };
  if (/why (are|do) you|why bullish|why bearish|why that read|justify/.test(t)) return { intent: "why", arg: null };
  if (/(what|which) level|show me (that|the) level|watching/.test(t)) return { intent: "level", arg: null };
  if (/thinking .*(ago|earlier)|what have you thought|today|journal|change(d)? your read/.test(t)) return { intent: "thesis_history", arg: null };
  // Math first: "show me the math" must not be swallowed by the timeframe matcher below.
  if (/show me the math|the numbers|the metrics|the stats/.test(t)) return { intent: "math", arg: null };
  if (/my trade|the trade|position|how is my/.test(t)) return { intent: "trade", arg: null };
  if (/(show|focus|pull up|switch to).*(1m|5m|15m|1h|4h|1d|daily|hourly|one minute|five minute|fifteen minute)/.test(t)) {
    const m = t.match(/(1m|5m|15m|1h|4h|1d|daily|one minute|five minute|fifteen minute|hourly)/);
    return { intent: "timeframe", arg: m ? m[1] : null };
  }
  // ASKING FOR A TRADE. This must be matched BEFORE the scalp/swing lines below, which would otherwise
  // swallow "find me a swing trade" and answer it with a lecture about the daily chart instead of the
  // setup THE BRAIN has actually already computed.
  if (/find me a|got a trade|see a (trade|setup|long|short)|any (trade|setup)s?\b|what would you (trade|take|do)|is there a (trade|setup)|should i (buy|sell)|trade idea|give me a (trade|setup)|do you (see|have) (a|any)/.test(t)) {
    const style = /quick|scalp|fast|50.?100|short term/.test(t) ? "quick"
      : /swing|daily|overnight|multi.?day/.test(t) ? "swing"
      : /intraday|session|today/.test(t) ? "intraday"
      : null;
    return { intent: "setup", arg: style };
  }
  if (/scalp/.test(t)) return { intent: "scalp", arg: null };
  if (/swing/.test(t)) return { intent: "swing", arg: null };
  return { intent: "unknown", arg: null };
}

const TF_ALIAS: Record<string, string> = {
  "one minute": "1m", "five minute": "5m", "fifteen minute": "15m", hourly: "1h", daily: "1d",
};

function mathLines(s: MarketSnapshot): string[] {
  const f = s.timeframes[EXEC]?.features;
  if (!f) return ["No 5-minute read to show."];
  return [
    `pressure ${Math.round(s.pressure.bullish)}/${Math.round(s.pressure.bearish)} (net ${Math.round(s.pressure.net)})`,
    `ATR ${f.atr.toFixed(2)} · vol ratio ${f.volRatio.toFixed(2)}`,
    `velocity ${f.velocity.toFixed(3)} · acceleration ${f.acceleration.toFixed(3)}`,
    `slope ${f.slope.toFixed(4)} · R² ${f.slopeR2.toFixed(2)} · efficiency ${(f.efficiency * 100).toFixed(0)}%`,
    `RSI ${f.rsi.toFixed(0)} · z ${f.zScore.toFixed(2)} · regime ${words(s.regime)}`,
  ];
}

/**
 * The narrator's answer. Used when no language model is configured, and as the safety net if one fails.
 * It is grounded in the same state the model would have received — it is a plainer voice, not a fake one.
 */
/** What THE BRAIN currently wants to do about gold, as the conversation needs to see it. */
export type SetupView = {
  state: string; side: string | null; style: string | null; stop: number | null;
  entryLow: number | null; entryHigh: number | null;
  initialObjective: number | null; extendedObjective: number | null;
  stopPips: number | null; expectedMovePips: [number, number] | null;
  confidence: number; say: string; headline: string;
  waitingFor: string[]; conditions: { text: string; met: boolean }[];
  thesis: string | null; invalidation: string | null;
};

export function answer(question: string, m: BrainMemory, opts?: { setup?: SetupView | null }): BrainResponse {
  const { intent, arg } = classify(question);
  const s = m.now;
  const ui: UiAction[] = [];
  let spoken: string;

  switch (intent) {
    case "briefing": spoken = briefing(m); break;
    case "what_changed": spoken = whatChanged(m, (arg as Horizon) ?? "5m"); break;
    case "why": spoken = why(m); break;
    case "change_mind": spoken = whatWouldChangeMyMind(m); break;
    case "level": {
      const l = m.watchedLevels[0];
      spoken = l
        ? `The one that matters is ${l.label} at ${px(l.price)}. ${s && s.price > l.price ? "We're above it" : "We're below it"}, and whether that holds is the question.`
        : "I don't have a level mapped that's close enough to matter right now.";
      if (l) ui.push({ name: "SHOW_LEVEL", arg: l.price });
      break;
    }
    case "thesis_history": {
      const prev = m.previousThesis;
      const cur = m.thesis;
      if (!cur && !prev) { spoken = "I haven't formed a view yet today."; break; }
      const bits: string[] = [];
      if (prev) bits.push(`Earlier I was reading this as ${prev.label.toLowerCase()}${prev.reasonEnded ? `, until ${prev.reasonEnded}` : ""}.`);
      if (cur) bits.push(`Right now I'm on ${cur.label.toLowerCase()}, held ${cur.strength}ly.`.replace("moderately ly", "moderately"));
      spoken = bits.join(" ");
      break;
    }
    case "timeframe": {
      const tf = arg ? TF_ALIAS[arg] ?? arg : "15m";
      const v = s?.timeframes[tf as Timeframe];
      spoken = v ? `The ${tf} is ${words(v.state)}, efficiency ${(v.features.efficiency * 100).toFixed(0)} percent.` : `I don't have a usable ${tf} read.`;
      ui.push({ name: "FOCUS_TIMEFRAME", arg: tf });
      break;
    }
    case "math":
      spoken = s ? `Here are the numbers behind that read: ${mathLines(s).join("; ")}.` : "No read to show numbers for.";
      ui.push({ name: "SHOW_METRICS", arg: null });
      break;
    case "trade":
      spoken = m.state?.presence === "trade_active" || m.state?.presence === "protecting_trade"
        ? "Let me look at the position." // the trade companion fills this in when a position exists
        : "You don't have a position open that I can see, so there's nothing for me to manage.";
      ui.push({ name: "SHOW_TRADE", arg: null });
      break;
    /*
     * "Find me a trade."
     *
     * Answered from the SETUP ENGINE, never improvised. Before this existed the question was matched by
     * /scalp/ and answered with a generic line about the five minute — a platitude, while three feet away
     * the engine already held a complete trade with an entry, a stop and objectives. Asking for a trade
     * and being told about timeframes is the exact failure this product exists to remove.
     */
    case "setup": {
      // A setup legitimately carries nulls (there may be no trade), so it gets its own tolerant
      // formatter rather than being forced through the market one, which assumes a number exists.
      const n2 = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));
      const su = opts?.setup ?? null;
      if (!su) {
        spoken = "I can't reach my own trade read right now, so I'm not going to guess one for you.";
        break;
      }
      if (arg && su.style && su.style !== arg) {
        spoken = `The trade I have is ${su.style === "quick" ? "a QUICK" : su.style === "swing" ? "a SWING" : "an INTRADAY"} one, not ${arg === "quick" ? "a quick" : arg === "swing" ? "a swing" : "an intraday"}. ${su.say}`;
        ui.push({ name: "SHOW_TRADE", arg: null });
        break;
      }
      if (su.state === "trade_ready" && su.side) {
        const ln = [
          `${su.say}`,
          `Entry ${su.entryLow === su.entryHigh ? n2(su.entryLow) : `${n2(su.entryLow)} to ${n2(su.entryHigh)}`}, stop ${n2(su.stop)} — ${su.stopPips} pips.`,
          `First objective ${n2(su.initialObjective)}, extended ${n2(su.extendedObjective)}.`,
          `Conviction ${su.confidence}. It's on your screen as TRADE READY — take it or pass, I'm not sending anything without you.`,
        ];
        spoken = ln.join(" ");
      } else if (su.side) {
        const missing = su.conditions.filter((c) => !c.met).map((c) => c.text.toLowerCase());
        spoken = `${su.say}${missing.length ? ` I still need ${missing.join(" and ")}.` : ""}`;
      } else {
        spoken = `${su.say}${su.waitingFor.length ? ` What would change that: ${su.waitingFor.join("; ")}.` : ""}`;
      }
      ui.push({ name: "SHOW_TRADE", arg: null });
      break;
    }

    case "scalp":
      spoken = s ? `For a scalp I'd be working around ${m.watchedLevels[0] ? px(m.watchedLevels[0].price) : px(s.price)} and I'd want the five minute moving with me, not against me. ${m.thesis?.bias === "range_fade" ? "Inside this range I'd rather fade the edges than chase the middle." : ""}`.trim() : "No live read.";
      break;
    case "swing":
      spoken = s ? `The swing picture is set by the four hour and daily. ${s.timeframes["4h"] ? `Four hour is ${words(s.timeframes["4h"]!.state)}` : "I don't have a clean four hour read"}${s.timeframes["1d"] ? ` and the daily is ${words(s.timeframes["1d"]!.state)}` : ""}. That's a slower decision than anything happening on the five minute right now.` : "No live read.";
      break;
    default:
      spoken = `${marketRead(m)} ${m.thesis ? `My read is ${m.thesis.label.toLowerCase()}.` : ""} Ask me what changed, why I'm reading it that way, or what would change my mind.`.trim();
  }

  const d = diffFor(m.diffs, "5m");
  return {
    spokenText: spoken,
    shortSummary: m.state?.headline ?? marketRead(m),
    marketRead: marketRead(m),
    changes: d ? changeLines(d) : [],
    focus: m.state?.focus ?? [],
    watchedLevels: m.watchedLevels.map((l) => l.price),
    scenario: scenarioOf(m),
    tradeRead: null,
    uiActions: ui,
    urgency: m.state?.presence === "market_shift" || m.state?.presence === "high_news_risk" ? "high" : "normal",
    voiceEligible: true,
    source: "narrator",
  };
}

/** The bull / bear / neutral paths, each with the trigger that would activate it. */
export function scenarioOf(m: BrainMemory): { bull: string; bear: string; neutral: string } | null {
  const s = m.now;
  if (!s) return null;
  let above: number | null = null;
  let below: number | null = null;
  for (const l of s.levels) {
    if (l.price > s.price && (above == null || l.price < above)) above = l.price;
    if (l.price < s.price && (below == null || l.price > below)) below = l.price;
  }
  return {
    bull: above != null ? `Acceptance above ${px(above)} opens continuation higher.` : "A clean break of the session high opens continuation higher.",
    bear: below != null ? `Losing ${px(below)} turns this into a move back down through the range.` : "Losing the session low turns this lower.",
    neutral: above != null && below != null ? `Between ${px(below)} and ${px(above)} this stays a range, and the edges are the only thing worth trading.` : "Until one side breaks, this stays a range.",
  };
}

export { mathLines };
