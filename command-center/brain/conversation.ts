/**
 * ATLAS IN CONVERSATION — the read, the feed and the thread, at the moment a question is asked.
 *
 * Three things a copilot has to get right before it says a word:
 *
 *   1. HOW FRESH IS WHAT I'M LOOKING AT? The feed is judged at question time. A stale, closed or demo
 *      feed is said as such, never narrated as the market now (conversationFeed).
 *   2. WHAT IS MY READ? The read engine's `read` when it is there; until then a minimal read derived from
 *      the running thesis (readFromThesis) — same lean, same invalidation, evidence that points at real
 *      levels and candles.
 *   3. WHAT IS THIS QUESTION ABOUT? "Why?" and "what about now?" refer to the last thing ATLAS said, and
 *      "what changed since your last update" is measured from when that was (followUpOf, changesSince).
 *
 * Pure: no I/O. The route loads the data; this file decides what it means.
 */
import type { Bar, Level, MarketSnapshot, TfState } from "../core/types";
import { PIP, TF_MINUTES } from "../core/types";
import type { Bias, BrainStatement, BrainThesis, PerceptionEvent, SnapshotDiff } from "./types";
import type { ParsedWatch } from "../engines/watch";
import {
  ATLAS_READ_VERSION, CHART_TFS, LEAN_LABEL, levelIdOf,
  type AtlasRead, type ChartTf, type Evidence, type EvidenceRef, type FeedState, type FeedStatus, type Lean, type Scenario,
} from "../core/atlasContract";
import { priceNow } from "../core/priceNow";
import { aboveBelow } from "../core/levelMap";
import { agoWords } from "./context";
import { FEED_WORD, isLean, numbersIn, type AnswerContext } from "./answer";
import { STALE_MS } from "../engines/live";
import { TICK_FRESH_MS } from "../engines/livePrice";

const px = (n: number) => n.toFixed(2);
const words = (s: string) => s.replace(/_/g, " ");
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v
  : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v)
  : null;

/* ── 1. the feed, at question time ─────────────────────────────────────────────────────────────────── */

/**
 * The feed as the answer must describe it. Built from the snapshot the conversation just loaded and the
 * fresher quote attached to it (engines/livePrice.ts). The route uses the feed engine's FeedState
 * instead whenever one is available; this is the same judgement from what a conversation turn holds.
 */
export function conversationFeed(
  s: MarketSnapshot | null,
  nowMs: number,
  marketIsOpen: boolean,
  opts: { demo?: boolean } = {},
): FeedState {
  const base = { provider: "Twelve Data", symbol: "XAU/USD", quoteType: "mid" as const, providerTs: null, checkedAt: nowMs };
  if (!s) {
    return {
      ...base, transport: opts.demo ? "replay" : "snapshot", price: null, receivedTs: null, ageMs: null,
      status: opts.demo ? "demo" : marketIsOpen ? "stale" : "closed",
      reason: opts.demo ? "Demo data — not the live market." : marketIsOpen ? "No market read is coming through." : "Gold is closed.",
    };
  }
  const receivedTs = s.live?.at ?? s.at;
  const ageMs = Math.max(0, nowMs - receivedTs);
  const analysisAge = Math.max(0, nowMs - s.at);
  const transport = opts.demo ? "replay" : s.live?.source === "stream" ? "websocket_relay" : s.live?.source === "quote" ? "poll" : "snapshot";
  const feedBlocker = s.blockers.find((b) => b.code === "feed_stale");
  let status: FeedStatus;
  let reason: string;
  if (opts.demo) {
    status = "demo"; reason = "Demo data — not the live market.";
  } else if (!marketIsOpen || s.session === "closed" || s.blockers.some((b) => b.code === "market_closed")) {
    status = "closed"; reason = `Gold is closed — the last price was read ${agoWords(ageMs)} ago.`;
  } else if (analysisAge > STALE_MS) {
    status = "stale"; reason = `The last market read was ${agoWords(analysisAge)} ago.`;
  } else if (feedBlocker) {
    status = "stale"; reason = feedBlocker.detail;
  } else if (s.live && ageMs <= TICK_FRESH_MS) {
    status = "live"; reason = `${s.live.source === "stream" ? "Streaming" : "Direct"} quote, read ${agoWords(ageMs)} ago.`;
  } else {
    status = "delayed"; reason = `No fresher quote came through — this price was measured ${agoWords(ageMs)} ago.`;
  }
  return { ...base, transport, price: priceNow(s), receivedTs, ageMs, status, reason };
}

/* ── 2. the read, from the thesis, until the read engine supplies one ──────────────────────────────── */

export function leanOfBias(bias: Bias | string | null | undefined, opts: { blocked?: boolean } = {}): Lean {
  if (opts.blocked) return "insufficient_data";
  if (!bias) return "balanced";
  if (bias.startsWith("bullish")) return "bullish_lean";
  if (bias.startsWith("bearish")) return "bearish_lean";
  return "balanced";
}

const BULL_TF: TfState[] = ["strong_uptrend", "uptrend", "weak_uptrend", "bullish_transition"];
const BEAR_TF: TfState[] = ["strong_downtrend", "downtrend", "weak_downtrend", "bearish_transition"];
const TF_NAME: Record<string, string> = { "5m": "5-minute", "15m": "15-minute", "1h": "1-hour", "4h": "4-hour", "1d": "daily" };

/** A blocker that makes the data unreadable. A closed market and a chaotic one are readable, just not tradeable. */
const unreadable = (s: MarketSnapshot) => s.blockers.some((b) => b.code !== "market_closed" && b.code !== "chaotic");

const allLevels = (s: MarketSnapshot): Level[] => [...s.levels, ...(s.map ?? [])];
const levelRef = (l: Level): EvidenceRef => ({ kind: "level", levelId: levelIdOf(l), price: l.price });

function levelNear(s: MarketSnapshot, price: number, tol = 0.06): Level | null {
  for (const l of allLevels(s)) if (Math.abs(l.price - price) <= tol) return l;
  return null;
}

/** The 5-minute bar a structural swing was printed on, so "show me" can mark it. */
function swingRef(bars: Bar[] | undefined, price: number | null, type: "high" | "low"): EvidenceRef | null {
  if (!bars?.length || price == null) return null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const v = type === "high" ? bars[i].h : bars[i].l;
    if (Math.abs(v - price) < 0.005) return { kind: "swing", tf: "5m", t: bars[i].t, price: v, type };
  }
  return null;
}

const MEANINGFUL_EVENTS = new Set([
  "LEVEL_ACCEPTANCE", "LEVEL_REJECTION", "BREAKOUT_ATTEMPT", "BREAKOUT_CONFIRMED", "BREAKOUT_WEAKENING", "FAILED_BREAKOUT",
  "RETEST_HOLDING", "RETEST_FAILING", "STRUCTURE_BREAK", "STRUCTURE_RECLAIM", "LIQUIDITY_SWEEP", "PRESSURE_FLIP",
  "TIMEFRAME_ALIGNMENT", "TIMEFRAME_CONFLICT", "MOMENTUM_EXHAUSTION",
]);

/** Setup states that come from a real candidate (a side, conditions being worked through). */
const LIVE_SETUP = new Set(["watching", "setup_developing", "waiting_for_trigger", "trade_ready"]);

export type ReadAdapterInput = {
  snapshot: MarketSnapshot | null;
  snapshotId: number | null;
  thesis: BrainThesis | null;
  previousThesis: BrainThesis | null;
  events?: PerceptionEvent[];
  /** The snapshot's 5-minute candles, so a structural swing can point at its bar. */
  bars5m?: Bar[];
  setup?: { state: string; waitingFor: string[]; side?: string | null } | null;
  tradeActive?: boolean;
  nowMs: number;
};

/**
 * A minimal AtlasRead from the running thesis. Not a second opinion: the lean IS the thesis's direction,
 * the invalidation IS the thesis's invalidation price, and every piece of evidence is a measurement from
 * the same snapshot. What it adds is shape — for/against, next, wrong-if — and references to real levels
 * and candles, so the conversation can show its evidence on the chart before the read engine exists.
 */
export function readFromThesis(i: ReadAdapterInput): AtlasRead {
  const s = i.snapshot;
  const t = i.thesis && !i.thesis.endedAt ? i.thesis : null;
  const blocked = !s || unreadable(s);
  let lean: Lean = !s ? "insufficient_data" : leanOfBias(t?.bias ?? null, { blocked });
  const dir = lean === "bullish_lean" ? 1 : lean === "bearish_lean" ? -1 : 0;
  // A directional read held tentatively, with more said against it lately than for it, is changing.
  if (t && dir !== 0 && t.strength === "tentative" && t.reasonWeakened.length > t.reasonStrengthened.length) lean = "transitioning";

  const htfTf: "1h" | "4h" = s?.timeframes["4h"] ? "4h" : "1h";
  const hs = s?.timeframes[htfTf]?.state ?? null;
  const htfState: AtlasRead["htfTrend"]["state"] = !hs ? "unknown" : BULL_TF.includes(hs) ? "up" : BEAR_TF.includes(hs) ? "down" : hs === "range" || hs === "compression" ? "range" : "unknown";
  const htfText = hs ? `${TF_NAME[htfTf]} trend: ${words(hs)}` : "no higher-timeframe read";

  const net = s ? Math.round(s.pressure.net) : 0;
  const ex = s?.timeframes["5m"];
  const momState: AtlasRead["momentum"]["state"] = !ex ? "unknown" : net >= 12 ? "rising" : net <= -12 ? "falling" : "flat";
  const momText = !ex ? "no 5-minute read" : net >= 12 ? `buyers pressing on the 5-minute (net ${net})` : net <= -12 ? `sellers pressing on the 5-minute (net ${net})` : "5-minute pressure balanced";

  const st = i.setup?.state ?? null;
  const setupStage: AtlasRead["setupStage"] = i.tradeActive ? "in_trade" : st === "trade_ready" ? "ready"
    : st === "setup_developing" || st === "waiting_for_trigger" ? "developing" : st === "watching" ? "watching" : "none";
  const entry: AtlasRead["entry"] = i.tradeActive || st === "trade_ready" ? "confirmed" : st === "waiting_for_trigger" ? "awaiting_confirmation" : "none";

  const evFor: Evidence[] = [];
  const evAgainst: Evidence[] = [];
  const push = (xs: Evidence[], text: string, weight: number, ref?: EvidenceRef | null) => {
    const tx = text.trim();
    if (!tx || evFor.some((e) => e.text === tx) || evAgainst.some((e) => e.text === tx)) return;
    xs.push(ref ? { text: tx, weight, ref } : { text: tx, weight });
  };
  /** Directional facts support a directional read on their side; against a balanced read they are the threat. */
  const side = (bullish: boolean) => (dir !== 0 && (bullish ? dir > 0 : dir < 0) ? evFor : evAgainst);

  if (s && !blocked) {
    if (htfState === "up" || htfState === "down") push(side(htfState === "up"), `${htfText.replace(/^\w/, (c) => c.toUpperCase())}.`, 0.8);
    if (ex?.structure.sequence === "HH_HL") push(side(true), "The 5-minute is still printing higher highs and higher lows.", 0.7, swingRef(i.bars5m, ex.structure.swingLow, "low"));
    if (ex?.structure.sequence === "LH_LL") push(side(false), "The 5-minute is printing lower highs and lower lows.", 0.7, swingRef(i.bars5m, ex.structure.swingHigh, "high"));
    const known = new Set(allLevels(s).map(levelIdOf));
    const recent = (i.events ?? [])
      .filter((e) => i.nowMs - e.at <= 30 * 60_000 && e.lean !== "neutral" && MEANINGFUL_EVENTS.has(e.code))
      .slice(-12).reverse().slice(0, 4);
    for (const e of recent) {
      const ref = e.level && known.has(levelIdOf(e.level)) ? levelRef(e.level) : null;
      push(side(e.lean === "bullish"), e.detail, 0.65, ref);
    }
    if (Math.abs(net) >= 15) push(side(net > 0), `${net > 0 ? "Buyers" : "Sellers"} have the short-term pressure (net ${net}).`, 0.5);
    if (t) {
      for (const r of [...t.reasonStrengthened].reverse().slice(0, 2)) push(evFor, r, 0.45);
      for (const r of [...t.reasonWeakened].reverse().slice(0, 2)) push(evAgainst, r, 0.45);
      if (evFor.length < 2) for (const r of t.reasonStarted) if (!/^This read is wrong/i.test(r)) push(evFor, r, 0.4);
    }
  } else if (s) {
    push(evAgainst, s.blockers.find((b) => b.code !== "market_closed")?.detail ?? "The data is not good enough to read.", 0.9);
  }

  let nextWatch: AtlasRead["nextWatch"] = null;
  const at = s ? priceNow(s) : null;
  /*
   * The setup's own conditions are "next" only for a live candidate on the lean's side. Standing aside,
   * the setup engine lists what would make ANY trade — both directions — and "break above" is not what a
   * bearish read is waiting for.
   */
  const setupSide = i.setup?.side === "buy" ? 1 : i.setup?.side === "sell" ? -1 : 0;
  const setupFits = !!i.setup && LIVE_SETUP.has(i.setup.state) && i.setup.waitingFor.length > 0 && setupSide !== 0 && (dir === 0 || setupSide === dir);
  if (setupFits && i.setup) {
    // The setup's own words; when they name a level's price, point at that level.
    const text = i.setup.waitingFor[0];
    const named = s ? numbersIn(text).map((n) => levelNear(s, n)).find((l): l is Level => !!l) ?? null : null;
    nextWatch = named ? { text, ref: levelRef(named) } : { text };
  } else if (s && at != null && !blocked) {
    const { above, below } = aboveBelow(at, [s.levels, s.map ?? []], 1);
    const a = above[0] ?? null, b = below[0] ?? null;
    const lv = dir > 0 ? a : dir < 0 ? b : a && b ? (a.price - at <= at - b.price ? a : b) : a ?? b;
    if (lv) {
      nextWatch = {
        text: dir > 0 ? `Acceptance above ${lv.label} ${px(lv.price)}` : dir < 0 ? `Acceptance below ${lv.label} ${px(lv.price)}` : `How price handles ${lv.label} ${px(lv.price)}`,
        ref: levelRef(lv),
      };
    }
  }

  let invalidation: AtlasRead["invalidation"] = null;
  const inv = t?.invalidationPrice ?? null;
  if (s && inv != null && dir !== 0) {
    const lv = levelNear(s, inv);
    invalidation = {
      text: `Acceptance ${dir > 0 ? "below" : "above"} ${lv ? `${lv.label} ` : ""}${px(inv)} would make this read wrong`,
      price: inv,
      ...(lv ? { ref: levelRef(lv) } : {}),
    };
  } else if (s && at != null && dir === 0 && !blocked) {
    const { above, below } = aboveBelow(at, [s.levels], 1);
    if (above[0] && below[0]) {
      invalidation = { text: `A clean break of either side — above ${above[0].label} ${px(above[0].price)} or below ${below[0].label} ${px(below[0].price)} — with pressure behind it`, price: null };
    }
  }

  const strength: AtlasRead["strength"] = lean === "balanced" || lean === "insufficient_data" ? null
    : t?.strength === "strong" ? "strong" : t?.strength === "moderate" ? "clear" : "slight";
  const score = Math.max(-100, Math.min(100, Math.round(dir * (t?.confidence ?? 0) * (lean === "transitioning" ? 1 / 3 : 1))));
  const prev = i.previousThesis;

  const firstFor = [...evFor].sort((a, b) => b.weight - a.weight)[0]?.text ?? "";
  const why = s?.blockers.find((b) => b.code !== "market_closed" && b.code !== "chaotic") ?? null;
  const summary = lean === "insufficient_data"
    ? `Not enough current data for a lean${why ? ` — ${why.detail.replace(/\.$/, "").toLowerCase()}` : ""}.`
    : `${LEAN_LABEL[lean]}${strength ? ` (${strength})` : ""} on the intraday picture.${firstFor ? ` ${firstFor}` : ""}${nextWatch ? ` Next: ${nextWatch.text}.` : ""}`;

  return {
    version: `${ATLAS_READ_VERSION}/thesis`,
    at: s?.at ?? i.nowMs,
    snapshotId: i.snapshotId,
    horizon: "intraday",
    horizonTf: "1h",
    lean,
    strength,
    score,
    htfTrend: { tf: htfTf, state: htfState, text: htfText },
    momentum: { tf: "5m", state: momState, text: momText },
    setupStage,
    entry,
    evidenceFor: evFor.slice(0, 5),
    evidenceAgainst: evAgainst.slice(0, 4),
    nextWatch,
    invalidation,
    since: t?.startedAt ?? s?.at ?? i.nowMs,
    previous: prev ? { lean: leanOfBias(prev.bias), until: prev.endedAt ?? prev.startedAt, reason: prev.reasonEnded ?? "" } : null,
    summary,
  };
}

/* ── 3. the thread ─────────────────────────────────────────────────────────────────────────────────── */

export type ClientTurn = {
  role: "user" | "assistant";
  content: string;
  at: number | null;
  /** For an answer: the read it was given against, as the console showed it. */
  read: { lean: Lean; snapshotId: number | null; at: number | null } | null;
};

/** What the trader last saw: the read on screen and the last thing ATLAS pointed at. */
export type LastSeen = {
  snapshotId: number | null;
  readAt: number | null;
  lean: Lean | null;
  answerAt: number | null;
  /** The level the chart last highlighted for them — "watch this level" means this one. */
  focusLevelId: string | null;
};

const DAY = 86_400_000;
const when = (v: unknown, nowMs: number): number | null => {
  const n = finite(v);
  return n != null && n > nowMs - DAY && n < nowMs + 60_000 ? n : null;
};
const posInt = (v: unknown): number | null => {
  const n = finite(v);
  return n != null && Number.isInteger(n) && n > 0 ? n : null;
};
const stripText = (v: unknown, max: number) =>
  String(v ?? "").replace(/\[\[UI:[^\]]*\]\]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, max);

/** The last N turns the console sent, typed and trimmed. Anything malformed is dropped, not repaired. */
export function sanitizeHistory(raw: unknown, nowMs: number, max = 8): ClientTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ClientTurn[] = [];
  for (const x of raw.slice(-Math.max(max * 4, 16))) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (o.role !== "user" && o.role !== "assistant") continue;
    const content = stripText(o.content, 1500);
    if (!content) continue;
    const r = o.read && typeof o.read === "object" ? (o.read as Record<string, unknown>) : null;
    out.push({
      role: o.role,
      content,
      at: when(o.at, nowMs),
      read: r && isLean(r.lean) ? { lean: r.lean, snapshotId: posInt(r.snapshotId), at: when(r.at, nowMs) } : null,
    });
  }
  return out.slice(-max);
}

export function sanitizeLastSeen(raw: unknown, nowMs: number): LastSeen | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const focus = typeof o.focusLevelId === "string" && /^[a-z_]{2,20}@\d{1,6}\.\d{2}$/.test(o.focusLevelId) ? o.focusLevelId : null;
  const seen: LastSeen = {
    snapshotId: posInt(o.snapshotId),
    readAt: when(o.readAt, nowMs),
    lean: isLean(o.lean) ? o.lean : null,
    answerAt: when(o.answerAt, nowMs),
    focusLevelId: focus,
  };
  return Object.values(seen).some((v) => v != null) ? seen : null;
}

/**
 * The turns as model messages. Consecutive turns from one side are merged, the thread starts with the
 * trader, and in chat ATLAS's own earlier answers are shown back to it in the JSON shape it answers in —
 * a model shown its last eight answers as prose drifts back into prose.
 */
export function historyMessages(history: ClientTurn[], finalUser: string, mode: "chat" | "voice"): { role: "user" | "assistant"; content: string }[] {
  const merged: { role: "user" | "assistant"; content: string; lean: Lean | null }[] = [];
  for (const t of [...history.map((h) => ({ role: h.role, content: h.content, lean: h.read?.lean ?? null })), { role: "user" as const, content: finalUser, lean: null }]) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) { last.content += `\n\n${t.content}`; last.lean = t.lean ?? last.lean; }
    else merged.push({ ...t });
  }
  while (merged.length && merged[0].role === "assistant") merged.shift();
  return merged.map((m) => ({
    role: m.role,
    content: m.role === "assistant" && mode === "chat" ? JSON.stringify({ say: m.content, ...(m.lean ? { read: { lean: m.lean } } : {}) }) : m.content,
  }));
}

/* ── what a question is asking for ─────────────────────────────────────────────────────────────────── */

export type AtlasIntent =
  | { kind: "since_last" } | { kind: "breakout" } | { kind: "change_mind" } | { kind: "waiting" }
  | { kind: "timeframe"; tf: ChartTf } | { kind: "why" } | { kind: "lean" } | { kind: "scenarios" }
  | { kind: "levels" } | { kind: "other" };

const TF_WORDS: [RegExp, ChartTf][] = [
  [/\b(15m|15 ?min(ute)?s?|fifteen[- ]?min(ute)?s?)\b/, "15m"],
  [/\b(5m|5 ?min(ute)?s?|five[- ]?min(ute)?s?)\b/, "5m"],
  [/\b(4h|4 ?hours?|four[- ]?hours?|h4)\b/, "4h"],
  [/\b(1h|1 ?hour|one[- ]?hour|hourly|h1|60 ?min(ute)?s?)\b/, "1h"],
  [/\b(1d|daily|day chart|the day)\b/, "1d"],
];

export const vocativeless = (q: string) =>
  q.toLowerCase().trim().replace(/^(hey |ok |okay )?(atlas|the brain|brain)[,:!]?\s*/i, "").replace(/^(hey|ok|okay)[,:]?\s*/i, "").trim();

/** ATLAS's conversational intents. The narrator's own classifier still decides watch/unwatch and the rest. */
export function atlasIntent(message: string): AtlasIntent {
  const t = vocativeless(message);
  if (/since (your|the|my) last|what('s| has)? changed since|anything (new|changed)|what about now|how about now|^(and )?now\??$|what'?s new\b|update me|any update|what'?s different/.test(t)) return { kind: "since_last" };
  if (/fake ?out|false (break|move)|breakout or|real break|is (this|it|that) (a )?(real |genuine )?(break|breakout)|bull trap|bear trap|stop run/.test(t)) return { kind: "breakout" };
  if (/chang(e|es|ing) (your|ur) mind|what would (flip|change|make you)|prove you wrong|invalidat|where (are|would) you (be )?wrong|what kills/.test(t)) return { kind: "change_mind" };
  if (/what are you waiting|waiting for|what do you need( to see)?|what'?s the trigger|what matters next|what('s| is) next|what would get you in/.test(t)) return { kind: "waiting" };
  if (/\b(zoom|switch|flip to|go to|take me|pull up|put up|bring up|change to|move to|show me|focus)\b/.test(t)) {
    const hit = TF_WORDS.find(([re]) => re.test(t));
    if (hit && !/^why\b/.test(t)) return { kind: "timeframe", tf: hit[1] };
  }
  if (/^why\b|show me why|\bwhy (are|is|do|did)\b|what makes you|how come|what'?s the evidence|\bevidence\b/.test(t)) return { kind: "why" };
  if (/which way|\blean(ing)?\b|\bbias\b|bullish or bearish|bearish or bullish|\bdirection\b|up or down|where('s| is) (gold|it|price) (going|headed)/.test(t)) return { kind: "lean" };
  if (/scenario|base case|alternative|what if\b/.test(t)) return { kind: "scenarios" };
  if (/key levels|levels? (above|below)|support|resistance/.test(t)) return { kind: "levels" };
  return { kind: "other" };
}

/** "Why?", "and that?", "what does that mean" — short, and about the last thing said. */
export function isShortFollowUp(message: string): boolean {
  const t = vocativeless(message).replace(/[?.!]+$/, "");
  const n = t.split(/\s+/).filter(Boolean).length;
  if (!t || n > 7) return false;
  return /^(why|how come|really|and|so|then|what about|how about|explain|meaning|what do you mean|go on|more|but|ok and|show me)\b/.test(t)
    || /\b(that|this|it|those|there|them)\b/.test(t)
    || /^(and )?now$/.test(t);
}

export type FollowUp = {
  /** A short question about the last answer. */
  isFollowUp: boolean;
  /** "What changed since your last update" / "what about now". */
  asksSinceLast: boolean;
  /** The statement the question refers to. */
  refersTo: { text: string; at: number | null; lean: Lean | null; snapshotId: number | null } | null;
  /** When "since" is measured from: the last answer the trader saw, else the read they saw. */
  since: number | null;
};

export function followUpOf(message: string, history: ClientTurn[], lastSeen: LastSeen | null, intent: AtlasIntent): FollowUp {
  const last = [...history].reverse().find((t) => t.role === "assistant") ?? null;
  const refersTo = last ? { text: last.content, at: last.at, lean: last.read?.lean ?? null, snapshotId: last.read?.snapshotId ?? null } : null;
  const asksSinceLast = intent.kind === "since_last";
  // "Is this a breakout?" names its own subject; "why?" and "and that level?" lean on the last answer.
  const leansOnLast = intent.kind === "other" || intent.kind === "why" || intent.kind === "lean";
  const isFollowUp = !!refersTo && leansOnLast && isShortFollowUp(message);
  const answered = [last?.at ?? null, lastSeen?.answerAt ?? null].filter((x): x is number => x != null);
  const since = asksSinceLast || isFollowUp
    ? (answered.length ? Math.max(...answered) : lastSeen?.readAt ?? null)
    : null;
  return { isFollowUp, asksSinceLast, refersTo, since };
}

/* ── what changed since then ───────────────────────────────────────────────────────────────────────── */

/** One entry of the read's own history. AtlasRead[] fits this shape, and so does the thesis journal. */
export type ReadHistoryEntry = { at: number; lean: Lean; snapshotId?: number | null; summary?: string };

/** A thesis from the journal (adapters/db thesisJournal, or the rolling memory). */
export type JournalEntry = { id: string; at: number; endedAt: number | null; lean: Lean; label: string; reasonEnded: string | null };

export function journalFromRows(rows: Record<string, unknown>[]): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const r of rows) {
    const at = Date.parse(String(r.started_at ?? ""));
    if (!Number.isFinite(at)) continue;
    const ended = r.ended_at ? Date.parse(String(r.ended_at)) : NaN;
    out.push({
      id: String(r.id ?? at), at, endedAt: Number.isFinite(ended) ? ended : null,
      lean: leanOfBias(String(r.bias ?? "")), label: String(r.label ?? r.bias ?? ""),
      reasonEnded: (r.reason_ended as string | null) ?? null,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function journalFromTheses(ts: (BrainThesis | null | undefined)[]): JournalEntry[] {
  return ts.filter((t): t is BrainThesis => !!t).map((t) => ({
    id: t.id, at: t.startedAt, endedAt: t.endedAt, lean: leanOfBias(t.bias), label: t.label, reasonEnded: t.reasonEnded,
  }));
}

export type SinceChanges = {
  since: number;
  ageMs: number;
  leanThen: Lean | null;
  leanNow: Lean;
  leanChanged: boolean;
  leanSource: "read_history" | "journal" | "conversation" | null;
  move: { from: number; to: number; dollars: number; pips: number; window: string } | null;
  transitions: string[];
  noted: string[];
  material: boolean;
  /** Plain sentences, oldest first. */
  lines: string[];
};

/**
 * What changed between `since` and now, measured: the lean then (read history → journal → what the
 * console says it showed) against the lean now, the price move from the closest real snapshot diff
 * (brain/diff.ts), the read's own transitions in between, and what ATLAS noticed and said.
 */
export function changesSince(i: {
  since: number;
  nowMs: number;
  current: AtlasRead;
  readHistory?: ReadHistoryEntry[];
  journal?: JournalEntry[];
  claimedLeanThen?: Lean | null;
  diffs?: SnapshotDiff[];
  statements?: BrainStatement[];
  events?: PerceptionEvent[];
}): SinceChanges {
  const ageMs = Math.max(0, i.nowMs - i.since);
  let leanThen: Lean | null = null;
  let leanSource: SinceChanges["leanSource"] = null;
  const fromHistory = [...(i.readHistory ?? [])].filter((r) => r.at <= i.since).sort((a, b) => b.at - a.at)[0];
  if (fromHistory) { leanThen = fromHistory.lean; leanSource = "read_history"; }
  if (!leanThen) {
    const open = (i.journal ?? []).filter((j) => j.at <= i.since && (j.endedAt == null || j.endedAt > i.since)).sort((a, b) => b.at - a.at)[0];
    if (open) { leanThen = open.lean; leanSource = "journal"; }
  }
  if (!leanThen && i.claimedLeanThen) { leanThen = i.claimedLeanThen; leanSource = "conversation"; }
  const leanNow = i.current.lean;
  const leanChanged = leanThen != null && leanThen !== leanNow;

  // The closest measured window to "since" — never one that misses it by more than a third of the gap.
  let move: SinceChanges["move"] = null;
  const ds = (i.diffs ?? []).filter((d) => Number.isFinite(d.fromAt));
  const best = ds.sort((a, b) => Math.abs(a.fromAt - i.since) - Math.abs(b.fromAt - i.since))[0];
  if (best && Math.abs(best.fromAt - i.since) <= Math.max(90_000, ageMs * 0.35)) {
    move = { from: best.priceFrom, to: best.priceTo, dollars: +best.priceMove.toFixed(2), pips: Math.round(best.priceMove / PIP), window: best.horizon };
  }

  const transitions: { at: number; text: string }[] = [];
  for (const j of i.journal ?? []) {
    if (j.endedAt != null && j.endedAt > i.since && j.endedAt <= i.nowMs) transitions.push({ at: j.endedAt, text: `${hhmm(j.endedAt)} UTC — dropped ${j.label.toLowerCase()}${j.reasonEnded ? `: ${j.reasonEnded}` : ""}.` });
    if (j.at > i.since && j.at <= i.nowMs) transitions.push({ at: j.at, text: `${hhmm(j.at)} UTC — opened ${j.label.toLowerCase()}.` });
  }
  transitions.sort((a, b) => a.at - b.at);

  const noted: { at: number; text: string }[] = [];
  for (const s of i.statements ?? []) {
    if (s.at > i.since && s.at <= i.nowMs && s.kind !== "answer" && s.channel !== "silent") noted.push({ at: s.at, text: `${hhmm(s.at)} UTC — I said: ${s.text}` });
  }
  for (const e of i.events ?? []) {
    if (e.at > i.since && e.at <= i.nowMs && (e.significance.score >= 60 || e.channel === "voice" || e.channel === "urgent")) noted.push({ at: e.at, text: `${hhmm(e.at)} UTC — ${e.detail}` });
  }
  noted.sort((a, b) => a.at - b.at);

  const lines: string[] = [];
  if (ageMs < 45_000) lines.push("Under a minute has passed — nothing has had time to change.");
  lines.push(leanThen == null ? `My lean now: ${LEAN_LABEL[leanNow]}.`
    : leanChanged ? `My lean changed: ${LEAN_LABEL[leanThen]} then, ${LEAN_LABEL[leanNow]} now.`
    : `The lean hasn't changed — still ${LEAN_LABEL[leanNow]}.`);
  if (move) {
    lines.push(Math.abs(move.pips) < 5
      ? `Price is flat since then (${px(move.from)} → ${px(move.to)}).`
      : `Price ${move.dollars > 0 ? "is up" : "is down"} $${Math.abs(move.dollars).toFixed(2)} (${Math.abs(move.pips)} pips) since then: ${px(move.from)} → ${px(move.to)}.`);
  }
  for (const x of transitions.slice(-4)) lines.push(x.text);
  for (const x of noted.slice(-3)) lines.push(x.text);
  const material = leanChanged || (move != null && Math.abs(move.pips) >= 20) || transitions.length > 0 || noted.length > 0;
  if (!material && ageMs >= 45_000) lines.push("Nothing material has changed since then.");

  return {
    since: i.since, ageMs, leanThen, leanNow, leanChanged, leanSource, move,
    transitions: transitions.map((x) => x.text), noted: noted.map((x) => x.text), material, lines,
  };
}

/* ── "watch this level" ────────────────────────────────────────────────────────────────────────────── */

const DEICTIC_LEVEL = /\b(this|that|the same) (level|line|price|one|zone)\b|\bwatch (it|that|this)\b/i;

/**
 * The level a deictic watch request means: the one the chart last highlighted for the trader (validated
 * against today's levels — the browser's word is never taken for a price), else the level the read is
 * watching next. Null when the request names its own level or price.
 */
export function focusLevelFor(
  message: string,
  lastSeen: LastSeen | null,
  levels: { kind: string; price: number; label: string }[],
  read: AtlasRead | null,
): { kind: string; price: number; label: string } | null {
  if (/\b\d{3,5}(\.\d{1,2})?\b/.test(message) || !DEICTIC_LEVEL.test(message)) return null;
  const byId = (id: string | null | undefined) => (id ? levels.find((l) => levelIdOf(l) === id) ?? null : null);
  return byId(lastSeen?.focusLevelId) ?? (read?.nextWatch?.ref?.kind === "level" ? byId(read.nextWatch.ref.levelId) : null);
}

/** The text handed to the watch parser for a deictic request: the same words, with the level's price. */
export const withFocusPrice = (message: string, level: { price: number }) => `${message} (${level.price.toFixed(2)})`;

/** Name the level in the confirmation, rather than repeating its price twice. */
export function namedWatch(parsed: ParsedWatch, level: { price: number; label: string }): ParsedWatch {
  const p = level.price.toFixed(2);
  return { ...parsed, levelLabel: level.label, confirm: parsed.confirm.replace(`${p} at ${p}`, `${level.label} at ${p}`) };
}

/* ── the context the model reads ───────────────────────────────────────────────────────────────────── */

const fmtRef = (r: EvidenceRef | undefined): string => {
  if (!r) return "";
  switch (r.kind) {
    case "level": return ` [ref level ${r.levelId}]`;
    case "candle": return ` [ref candle ${r.tf} t=${r.t}]`;
    case "swing": return ` [ref swing ${r.tf} t=${r.t} ${r.type} ${px(r.price)}]`;
    case "zone": return ` [ref zone ${px(r.from)}–${px(r.to)}]`;
  }
};

const CANDLES_SHOWN: Record<ChartTf, number> = { "5m": 12, "15m": 8, "1h": 6, "4h": 4, "1d": 3 };

export type ConversationBlocksInput = {
  nowMs: number;
  feed: FeedState;
  analysisAt: number | null;
  snapshotId: number | null;
  read: AtlasRead;
  scenarios: Scenario[];
  ctx: AnswerContext;
  chartTf: ChartTf | null;
  followUp: FollowUp;
  since: SinceChanges | null;
  watches?: { said: string; kind: string; levelPrice: number | null }[];
};

/**
 * The conversation's part of the context: the feed and the read first, so the opening of the answer is
 * right; then the things the answer may point at, the trader's chart, and the thread.
 */
export function conversationBlocks(i: ConversationBlocksInput): { head: string; tail: string } {
  const H: string[] = [];
  const ago = (ms: number | null) => (ms == null ? "unknown" : `${agoWords(i.nowMs - ms)} ago`);
  H.push("=== FEED (say this first if it is not LIVE) ===");
  H.push(`${FEED_WORD[i.feed.status]} — ${i.feed.reason}`);
  H.push(`analysis: snapshot ${i.snapshotId ?? "unknown"}, taken ${ago(i.analysisAt)}`);

  const r = i.read;
  H.push("", "=== THE READ — what the screen shows; report THIS lean ===");
  H.push(`lean: ${LEAN_LABEL[r.lean]} (${r.lean})${r.strength ? `, ${r.strength}` : ""} · horizon: ${r.horizon} (${r.horizonTf}) · held since ${hhmm(r.since)} UTC`);
  H.push(`higher timeframe: ${r.htfTrend.text} · momentum: ${r.momentum.text}`);
  H.push(`setup stage: ${words(r.setupStage)} · entry: ${words(r.entry)} — a lean is not an entry`);
  for (const e of r.evidenceFor.slice(0, 4)) H.push(`for: ${e.text}${fmtRef(e.ref)}`);
  for (const e of r.evidenceAgainst.slice(0, 3)) H.push(`against: ${e.text}${fmtRef(e.ref)}`);
  if (r.nextWatch) H.push(`next: ${r.nextWatch.text}${fmtRef(r.nextWatch.ref)}`);
  if (r.invalidation) H.push(`wrong if: ${r.invalidation.text}${fmtRef(r.invalidation.ref)}`);
  if (r.previous) H.push(`before this: ${LEAN_LABEL[r.previous.lean]} until ${hhmm(r.previous.until)} UTC${r.previous.reason ? ` — ${r.previous.reason}` : ""}`);

  const T: string[] = [];
  if (i.scenarios.length) {
    T.push("=== SCENARIOS ===");
    for (const s of i.scenarios.slice(0, 4)) {
      T.push(`[${s.role}] id=${s.id} · ${s.title} (${s.tf}, ${s.direction}, ${s.status}) · trigger: ${s.trigger.text} · invalidation: ${s.invalidation.text}`);
    }
    T.push("");
  }

  T.push("=== CHART OBJECTS — the only things an answer may point at ===");
  const price = i.ctx.price;
  const lv = [...i.ctx.levels].sort((a, b) => (price == null ? 0 : Math.abs(a.price - price) - Math.abs(b.price - price))).slice(0, 16)
    .sort((a, b) => b.price - a.price);
  T.push("levels (id — name — price):");
  if (lv.length) for (const l of lv) T.push(`${levelIdOf(l)} — ${l.label} — ${px(l.price)}${price != null ? ` (${Math.abs(l.price - price).toFixed(2)} ${l.price >= price ? "above" : "below"})` : ""}`);
  else T.push("none");
  for (const tf of CHART_TFS) {
    const bars = (i.ctx.bars[tf] ?? []).slice(-CANDLES_SHOWN[tf]);
    if (!bars.length) continue;
    const span = TF_MINUTES[tf] * 60_000;
    T.push(`${tf} candles (t = open time, ms since epoch, UTC):`);
    for (const b of bars) {
      const stamp = tf === "1d" ? new Date(b.t).toISOString().slice(0, 10) : `${hhmm(b.t)} UTC`;
      T.push(`t=${b.t} ${stamp} O ${px(b.o)} H ${px(b.h)} L ${px(b.l)} C ${px(b.c)}${b.t + span > i.nowMs ? " (forming)" : ""}`);
    }
  }
  T.push(`scenario ids: ${i.scenarios.length ? i.scenarios.map((s) => s.id).join(", ") : "none — do not use scenario actions"}`);
  if (price != null) T.push(`zones: within 5% of ${px(price)}, at most 3% wide, bounded by prices listed here`);

  if (i.chartTf) {
    T.push("", "=== THE TRADER'S CHART ===", `They are looking at the ${i.chartTf} chart. That is a view, not your analysis horizon (${r.horizon}, ${r.horizonTf}).`);
  }

  if (i.watches?.length) {
    T.push("", "=== WHAT THEY ASKED YOU TO WATCH (still armed) ===");
    for (const w of i.watches.slice(0, 6)) T.push(`- ${w.said} (${w.kind}${w.levelPrice != null ? ` at ${px(w.levelPrice)}` : ""})`);
  }

  const f = i.followUp;
  if (f.refersTo && (f.isFollowUp || f.asksSinceLast)) {
    const ref = f.refersTo;
    T.push("", f.isFollowUp ? "=== FOLLOW-UP — this question is about your last answer ===" : "=== YOUR LAST UPDATE ===");
    T.push(`your last answer (${ref.at != null ? `${hhmm(ref.at)} UTC, ${ago(ref.at)}` : "time unknown"}${ref.lean ? `; read then: ${LEAN_LABEL[ref.lean]}` : ""}${ref.snapshotId != null ? `, snapshot ${ref.snapshotId}` : ""}): "${ref.text.slice(0, 600)}"`);
  }
  if (i.since) {
    T.push("", `=== SINCE YOUR LAST UPDATE (${hhmm(i.since.since)} UTC, ${agoWords(i.since.ageMs)} ago) ===`, ...i.since.lines);
  }
  return { head: H.join("\n"), tail: T.join("\n") };
}
