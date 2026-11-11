/**
 * ATLAS'S ANSWER CONTRACT — what a typed answer is, how the model's reply is read, and what survives.
 *
 * The console no longer receives a paragraph. It receives the read (lean + horizon), the evidence for and
 * against it, what ATLAS is waiting for, what would make it wrong, how fresh all of that is, and the chart
 * actions that show the evidence. The model is asked for exactly that shape, as JSON — and nothing it
 * returns is trusted on the way through:
 *
 *   • a level must be a real level ID (levelIdOf), a candle a real open time in the bars, a scenario a
 *     real scenario ID, a zone ordered and near the price (validateChartAction, atlasContract.ts);
 *   • a price written in the text must be one the model was actually shown — an invented 4450 drops the
 *     sentence it sits in, never the whole answer;
 *   • the lean shown is the engine's, never the model's — a contradiction is dropped, not displayed;
 *   • a reply that is not JSON at all is still an answer: it is shown as text, with the engine's read
 *     beside it.
 *
 * Browser-safe: no I/O. The console imports the types and `refToAction` from here.
 */
import type { Bar } from "../core/types";
import type { UiAction, UiActionName } from "./types";
import {
  CHART_TFS, LEAN_LABEL, levelIdOf, validateChartAction,
  type AtlasRead, type ChartAction, type ChartActionContext, type ChartTf, type EvidenceRef,
  type FeedState, type FeedStatus, type Lean,
} from "../core/atlasContract";

/* ── the shape ─────────────────────────────────────────────────────────────────────────────────────── */

export const LEANS: readonly Lean[] = ["bullish_lean", "bearish_lean", "balanced", "transitioning", "insufficient_data"];
export const isLean = (v: unknown): v is Lean => typeof v === "string" && (LEANS as readonly string[]).includes(v);

/** One line of evidence. `action` is what clicking it does to the chart — worked out on the server, where
 *  the level's own name is known. */
export type AnswerItem = { text: string; ref?: EvidenceRef; action?: ChartAction };

export type AnswerRead = {
  lean: Lean;
  label: string;
  horizon: AtlasRead["horizon"];
  horizonTf: AtlasRead["horizonTf"];
  strength: AtlasRead["strength"];
  since: number | null;
  at: number | null;
  snapshotId: number | null;
};

export type AtlasAnswer = {
  /** The answer itself, plain text. Also returned as `spokenText` for every older client. */
  say: string;
  /** Always the ENGINE's read — the model may explain it, never replace it. */
  read: AnswerRead | null;
  evidence: AnswerItem[];
  against: AnswerItem[];
  next: string | null;
  invalidation: string | null;
  /** One line saying how fresh the price and the analysis are. */
  freshness: string;
  /** Validated chart actions; the console applies them as the answer arrives. */
  actions: ChartAction[];
};

/** What the chat route returns on top of the older BrainResponse fields. */
export type AtlasChatMeta = {
  answer: AtlasAnswer;
  snapshotId: number | null;
  analysisAt: number | null;
  /** When the server answered, on the server's clock. The console sends it back, so "since your last
   *  update" is measured on one clock — never a browser's that runs fast or slow. */
  answeredAt: number;
  feed: FeedState;
  promptVersion: string;
  /** True when the model's JSON was read; false for plain text or the deterministic voice. */
  structured: boolean;
  /** Echo of the client's request id, so a late answer to an older question can be ignored. */
  requestId: string | null;
  /** Short codes for what validation removed. Empty when nothing was. */
  dropped: string[];
};

export const answerReadOf = (r: AtlasRead): AnswerRead => ({
  lean: r.lean, label: LEAN_LABEL[r.lean], horizon: r.horizon, horizonTf: r.horizonTf, strength: r.strength,
  since: Number.isFinite(r.since) ? r.since : null, at: Number.isFinite(r.at) ? r.at : null, snapshotId: r.snapshotId ?? null,
});

export const FEED_WORD: Record<FeedStatus, string> = {
  live: "LIVE",
  delayed: "DELAYED",
  reconnecting: "RECONNECTING",
  stale: "STALE",
  closed: "MARKET CLOSED",
  demo: "DEMO",
};

/* ── what the answer may point at ──────────────────────────────────────────────────────────────────── */

export type AnswerContext = Omit<ChartActionContext, "scenarios"> & {
  /** The candles behind `candles`, so a swing's price is checked against the bar it names. */
  bars: Partial<Record<ChartTf, Bar[]>>;
  scenarios: { id: string; direction?: "up" | "down" | "range" }[];
  /** Every number the model was shown, plus the snapshot's own. A price in the answer must be one of these. */
  grounded: number[];
};

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v
  : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v)
  : null;

const clean = (v: unknown, max: number): string =>
  String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);

/** Build the context every reference and every price in an answer is checked against. */
export function answerContextOf(i: {
  levels: { kind: string; price: number; label: string }[];
  bars: Partial<Record<ChartTf, Bar[]>>;
  scenarios?: { id: string; direction?: "up" | "down" | "range" }[];
  price: number | null;
  /** Texts the model saw — the context packet, the question, the history. Their numbers are grounded. */
  shown?: string[];
  extra?: (number | null | undefined)[];
}): AnswerContext {
  const levels: AnswerContext["levels"] = [];
  const seen = new Set<string>();
  for (const l of i.levels) {
    if (!l || !(Number(l.price) > 0)) continue;
    const id = levelIdOf(l);
    if (seen.has(id)) continue;
    seen.add(id);
    levels.push({ kind: String(l.kind), price: Number(l.price), label: String(l.label ?? l.kind) });
  }
  const candles: AnswerContext["candles"] = {};
  const bars: AnswerContext["bars"] = {};
  for (const tf of CHART_TFS) {
    const b = (i.bars[tf] ?? []).filter((x) => x && [x.t, x.o, x.h, x.l, x.c].every((v) => Number.isFinite(v)));
    if (!b.length) continue;
    bars[tf] = b;
    candles[tf] = b.map((x) => x.t);
  }
  // A real candle's open, high, low and close are real traded prices — never an invention.
  const grounded: number[] = [];
  for (const t of i.shown ?? []) grounded.push(...numbersIn(t));
  for (const n of i.extra ?? []) if (typeof n === "number" && Number.isFinite(n)) grounded.push(n);
  for (const l of levels) grounded.push(l.price);
  for (const tf of CHART_TFS) for (const b of bars[tf] ?? []) grounded.push(b.o, b.h, b.l, b.c);
  if (i.price != null) grounded.push(i.price);
  return { levels, candles, bars, scenarios: i.scenarios ?? [], price: i.price, grounded };
}

/**
 * Accept an evidence reference only if it points at something real: a known level ID, a known candle open
 * time, a swing whose price is that candle's own high or low, or a sane zone. The price carried out is the
 * real one, never the one the model wrote.
 */
export function validateRef(raw: unknown, ctx: AnswerContext): EvidenceRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = String(r.kind ?? "");
  if (kind === "level") {
    const id = String(r.levelId ?? "");
    const lv = ctx.levels.find((l) => levelIdOf(l) === id);
    return lv ? { kind: "level", levelId: id, price: lv.price } : null;
  }
  if (kind === "candle" || kind === "swing") {
    const tf = String(r.tf ?? "") as ChartTf;
    const t = finite(r.t);
    if (!CHART_TFS.includes(tf) || t == null || !(ctx.candles[tf] ?? []).includes(t)) return null;
    if (kind === "candle") return { kind: "candle", tf, t };
    const bar = (ctx.bars[tf] ?? []).find((b) => b.t === t);
    if (!bar) return null;
    const price = finite(r.price);
    let type: "high" | "low" | null = r.type === "high" || r.type === "low" ? r.type : null;
    if (!type && price != null) type = Math.abs(price - bar.h) <= Math.abs(price - bar.l) ? "high" : "low";
    if (!type) return null;
    const actual = type === "high" ? bar.h : bar.l;
    if (price != null && Math.abs(price - actual) > Math.max(0.5, actual * 0.0001)) return null;
    return { kind: "swing", tf, t, price: actual, type };
  }
  if (kind === "zone") {
    const z = validateChartAction({ type: "show_zone", from: r.from, to: r.to, label: r.label }, ctx);
    if (!z || z.type !== "show_zone") return null;
    if (ungroundedPrices(`${z.from} ${z.to}`, ctx).length) return null;
    return { kind: "zone", from: z.from, to: z.to, label: z.label };
  }
  return null;
}

/** What pointing at a reference does to the chart. Swings and candles are marked on their own timeframe. */
export function refToAction(ref: EvidenceRef, label?: string): ChartAction | null {
  const L = clean(label, 80);
  switch (ref.kind) {
    case "level": return { type: "highlight_level", levelId: ref.levelId, price: ref.price, label: L || ref.levelId };
    case "zone": return { type: "show_zone", from: ref.from, to: ref.to, label: L || ref.label || "Zone" };
    case "candle":
      return CHART_TFS.includes(ref.tf as ChartTf) ? { type: "mark_candle", tf: ref.tf as ChartTf, t: ref.t, label: L || "Candle" } : null;
    case "swing":
      return CHART_TFS.includes(ref.tf as ChartTf)
        ? { type: "mark_candle", tf: ref.tf as ChartTf, t: ref.t, label: L || `Swing ${ref.type} ${ref.price.toFixed(2)}` }
        : null;
  }
}

/** The action for a reference, labelled with what the trader would call the thing (the level's name). */
export function actionForRef(ref: EvidenceRef, ctx: Pick<AnswerContext, "levels">, fallbackLabel?: string): ChartAction | null {
  if (ref.kind === "level") {
    const lv = ctx.levels.find((l) => levelIdOf(l) === ref.levelId);
    return refToAction(ref, lv ? `${lv.label} ${lv.price.toFixed(2)}` : fallbackLabel);
  }
  return refToAction(ref, fallbackLabel);
}

/* ── prices in text ────────────────────────────────────────────────────────────────────────────────── */

/** No lookbehind: this module ships to browsers that do not all support it. */
const NUM_RE = /(^|[^\d.,])\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?!\d)/g;

/** Every number written in a text: "4,392.10", "$4392.1", "4392". */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const s = String(text ?? "");
  NUM_RE.lastIndex = 0;
  for (let m = NUM_RE.exec(s); m; m = NUM_RE.exec(s)) {
    const n = Number(`${m[2].replace(/,/g, "")}${m[3] ? `.${m[3]}` : ""}`);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** A number this close to the current price is a price, and has to be one the model was shown. */
export const PRICE_BAND = 0.12;

/**
 * The prices in a text that nothing in the context supports. Rounding is allowed (4392 for 4392.10); a
 * number nowhere near anything the model was shown is not.
 */
export function ungroundedPrices(text: string, ctx: Pick<AnswerContext, "grounded" | "price">): number[] {
  const ref = ctx.price;
  if (ref == null || !(ref > 0)) return [];
  const tol = Math.max(0.6, ref * 0.0002);
  return numbersIn(text).filter((n) => Math.abs(n - ref) / ref <= PRICE_BAND && !ctx.grounded.some((g) => Math.abs(g - n) <= tol));
}

/** Sentences, without splitting "4392.10" in half. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    cur += ch;
    if ((ch === "." || ch === "!" || ch === "?") && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/* ── the lean the text claims ──────────────────────────────────────────────────────────────────────── */

const LEAN_CLAIM = /\b(?:i(?:'m| am)|i'd be|my (?:read|lean|bias|view) is|leaning|i lean|still)\s+(?:\w+\s+){0,2}?(bullish|bearish)\b|\b(bullish|bearish) lean\b/i;

/** Does this sentence assert the opposite directional lean to the engine's? Negations are not claims. */
export function contradictsLean(sentence: string, lean: Lean): boolean {
  if (lean !== "bullish_lean" && lean !== "bearish_lean") return false;
  const m = sentence.match(LEAN_CLAIM);
  if (!m) return false;
  if (/\b(not|no longer|isn't|aren't|wasn't|n't)\b/i.test(m[0])) return false;
  const said = (m[1] ?? m[2] ?? "").toLowerCase();
  return lean === "bullish_lean" ? said === "bearish" : said === "bullish";
}

/* ── freshness ─────────────────────────────────────────────────────────────────────────────────────── */

const short = (ms: number | null): string => {
  if (ms == null || !Number.isFinite(ms)) return "?";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h}h` : `${Math.round(h / 24)}d`;
};

/** "LIVE · price 2s old · analysis 41s old" — the one line every answer carries. */
export function freshnessLine(feed: FeedState, analysisAt: number | null, nowMs: number): string {
  const parts = [FEED_WORD[feed.status]];
  if (feed.price != null) parts.push(`price ${short(feed.ageMs)} old`);
  if (analysisAt != null) parts.push(`analysis ${short(nowMs - analysisAt)} old`);
  return parts.join(" · ");
}

const ACKNOWLEDGED = /\b(stale|closed|old|ago|delayed|demo|replay|not live|isn't live|not current|reconnect\w*|last (?:price|read|close)|history|behind)\b/i;

/**
 * A stale, closed, demo or reconnecting feed is said up front. If the answer already says so in its own
 * words it is left alone; otherwise one sentence is put in front of it.
 */
export function withFreshnessCaveat(say: string, feed: Pick<FeedState, "status" | "reason">): { say: string; added: boolean } {
  if (feed.status === "live" || feed.status === "delayed") return { say, added: false };
  if (ACKNOWLEDGED.test(say)) return { say, added: false };
  const lead = feed.status === "closed" ? "Gold is closed — this is the last read, not a live market."
    : feed.status === "demo" ? "This is demo data, not the live market."
    : feed.status === "reconnecting" ? "The price feed is reconnecting, so this may be behind."
    : `My feed is stale — ${feed.reason.replace(/\.$/, "").replace(/^\w/, (c) => c.toLowerCase())} — so treat this as history, not the market now.`;
  return { say: say ? `${lead} ${say}` : lead, added: true };
}

/* ── the model's reply ─────────────────────────────────────────────────────────────────────────────── */

export type ParsedReply =
  | { kind: "json"; value: Record<string, unknown> }
  | { kind: "text"; text: string; salvaged: boolean }
  | { kind: "empty" };

/** The first balanced {...} from `start`, respecting strings. Null when it never closes (truncated). */
function balancedObject(s: string, start: number): string | null {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/** The answer itself, from a reply that is cut off or broken after it. */
function salvageSay(s: string): string | null {
  const m = s.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    const v = JSON.parse(`"${m[1]}"`) as string;
    return v.trim().length >= 2 ? v.trim() : null;
  } catch { return null; }
}

/**
 * Read the model's reply. JSON (fenced or not, with prose around it, with a trailing comma) is parsed; a
 * reply cut off mid-object still yields its `say`; plain prose is plain text; nothing usable is `empty`,
 * and the caller answers from the engine instead.
 */
export function parseAtlasReply(raw: string): ParsedReply {
  const text = String(raw ?? "").trim();
  if (!text) return { kind: "empty" };
  const unfenced = text.replace(/```(?:json|JSON)?\s*([\s\S]*?)```/g, "$1").trim();
  const start = unfenced.indexOf("{");
  if (start < 0) return { kind: "text", text: unfenced, salvaged: false };
  const obj = balancedObject(unfenced, start);
  if (obj) {
    for (const candidate of [obj, obj.replace(/,\s*([}\]])/g, "$1")]) {
      try {
        const v = JSON.parse(candidate) as unknown;
        if (v && typeof v === "object" && !Array.isArray(v)) return { kind: "json", value: v as Record<string, unknown> };
      } catch { /* try the repaired form */ }
    }
  }
  const say = salvageSay(unfenced);
  if (say) return { kind: "text", text: say, salvaged: true };
  const prose = unfenced.slice(0, start).replace(/\s+/g, " ").trim();
  return prose.length >= 24 && /[a-z]{3}/i.test(prose) ? { kind: "text", text: prose, salvaged: false } : { kind: "empty" };
}

/* ── the older [[UI: …]] vocabulary ────────────────────────────────────────────────────────────────── */

/** The ONLY UI actions ATLAS may take with a marker. Anything else is discarded silently. */
export const UI_ALLOWED: UiActionName[] = [
  "FOCUS_TIMEFRAME", "FOCUS_PRICE_RANGE", "SHOW_LEVEL", "SHOW_SESSION",
  "SHOW_SCENARIO", "SHOW_EVENT", "SHOW_TRADE", "SHOW_METRICS", "MARK_CHART",
  // Navigation: a member who asks where a setting is gets taken there, not just told.
  "OPEN_SETTINGS", "OPEN_BROKER",
];

/** Parse the strict trailing marker syntax and keep only whitelisted names. */
export function extractUiMarkers(text: string): { clean: string; markers: UiAction[] } {
  const markers: UiAction[] = [];
  const out = String(text ?? "").replace(/\[\[UI:\s*([A-Z_]+)(?:\s+([^\]]+))?\]\]/g, (_m, name: string, arg?: string) => {
    const n = name.trim() as UiActionName;
    if (UI_ALLOWED.includes(n)) {
      const raw = (arg ?? "").trim();
      const num = Number(raw);
      markers.push({ name: n, arg: raw === "" ? null : Number.isFinite(num) ? num : raw });
    }
    return "";
  }).replace(/\s{2,}/g, " ").trim();
  return { clean: out, markers: markers.slice(0, 3) };
}

const TF_ALIAS: Record<string, ChartTf> = {
  "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d",
  "five minute": "5m", "fifteen minute": "15m", hourly: "1h", daily: "1d",
};

/** The chart actions an older marker stands for, when it points at something real. */
export function markersToChartActions(markers: UiAction[], ctx: AnswerContext): ChartAction[] {
  const out: ChartAction[] = [];
  for (const m of markers) {
    if (m.name === "SHOW_LEVEL" && typeof m.arg === "number") {
      const lv = ctx.levels.find((l) => Math.abs(l.price - (m.arg as number)) < 0.06);
      const a = lv ? validateChartAction({ type: "highlight_level", levelId: levelIdOf(lv), label: `${lv.label} ${lv.price.toFixed(2)}` }, ctx) : null;
      if (a) out.push(a);
    } else if (m.name === "FOCUS_TIMEFRAME" && m.arg != null) {
      const tf = TF_ALIAS[String(m.arg).toLowerCase()];
      if (tf) out.push({ type: "timeframe", tf });
    } else if (m.name === "SHOW_SCENARIO" && m.arg != null) {
      const arg = String(m.arg).toLowerCase();
      const dir = /^bull|^up/.test(arg) ? "up" : /^bear|^down/.test(arg) ? "down" : /^neutral|^range/.test(arg) ? "range" : null;
      const sc = ctx.scenarios.find((s) => s.id === String(m.arg)) ?? (dir ? ctx.scenarios.find((s) => s.direction === dir) : undefined);
      if (sc) out.push({ type: "scenario", scenarioId: sc.id });
    } else if (m.name === "FOCUS_PRICE_RANGE" && m.arg != null) {
      const [a, b] = numbersIn(String(m.arg));
      const z = a != null && b != null ? validateChartAction({ type: "show_zone", from: a, to: b, label: "Range" }, ctx) : null;
      if (z && z.type === "show_zone" && !ungroundedPrices(`${z.from} ${z.to}`, ctx).length) out.push(z);
    }
  }
  return out;
}

/** The older vocabulary for a chart action, so screens that only know markers still react. */
export function chartActionsToUi(actions: ChartAction[]): UiAction[] {
  const out: UiAction[] = [];
  for (const a of actions) {
    if (a.type === "highlight_level") out.push({ name: "SHOW_LEVEL", arg: a.price });
    else if (a.type === "timeframe") out.push({ name: "FOCUS_TIMEFRAME", arg: a.tf });
    else if (a.type === "scenario" && a.scenarioId) out.push({ name: "SHOW_SCENARIO", arg: a.scenarioId });
    else if (a.type === "show_zone") out.push({ name: "FOCUS_PRICE_RANGE", arg: `${a.from.toFixed(2)}-${a.to.toFixed(2)}` });
  }
  return out;
}

const key = (a: ChartAction) => JSON.stringify(a);
export const dedupeActions = (xs: ChartAction[], max = 4): ChartAction[] => {
  const seen = new Set<string>();
  const out: ChartAction[] = [];
  for (const a of xs) { const k = key(a); if (!seen.has(k)) { seen.add(k); out.push(a); } }
  return out.slice(0, max);
};

/* ── validating the model's object ─────────────────────────────────────────────────────────────────── */

export type ValidateInput = {
  value: Record<string, unknown>;
  ctx: AnswerContext;
  /** The engine's read: the lean shown, and what fills an empty evidence list, next or invalidation. */
  read: AtlasRead;
  feed: FeedState;
  freshness: string;
  /** Fill evidence / next / invalidation from the read when the model leaves them empty. */
  fillFromRead: boolean;
  /** What is said when nothing of the model's own answer survives. */
  fallbackSay: string;
};

export type Validated = { answer: AtlasAnswer; markers: UiAction[]; dropped: string[] };

/** The read's own evidence as answer items, with their chart actions. */
export function itemsFromRead(xs: AtlasRead["evidenceFor"], ctx: AnswerContext, max: number): AnswerItem[] {
  return [...xs].sort((a, b) => b.weight - a.weight).slice(0, max).map((e) => {
    const ref = e.ref ? validateRef(e.ref, ctx) : null;
    const action = ref ? actionForRef(ref, ctx, e.text) : null;
    return { text: clean(e.text, 220), ...(ref ? { ref } : {}), ...(action ? { action } : {}) };
  });
}

function items(raw: unknown, ctx: AnswerContext, max: number, dropped: string[], tag: string): AnswerItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AnswerItem[] = [];
  for (const x of raw.slice(0, 8)) {
    const o = typeof x === "string" ? { text: x } : x && typeof x === "object" ? (x as Record<string, unknown>) : null;
    const text = clean(o?.text, 220);
    if (!text) continue;
    if (ungroundedPrices(text, ctx).length) { dropped.push(`${tag}:ungrounded_price`); continue; }
    const item: AnswerItem = { text };
    if (o && o.ref != null) {
      const ref = validateRef(o.ref, ctx);
      if (ref) {
        item.ref = ref;
        const action = actionForRef(ref, ctx, text);
        if (action) item.action = action;
      } else dropped.push(`${tag}:ref_${String((o.ref as Record<string, unknown>)?.kind ?? "unknown")}`);
    }
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The model's object, made safe to show: every reference and every price checked, the engine's lean in
 * place of the model's, the freshness line the server measured, and only valid chart actions.
 */
export function validateAtlasAnswer(i: ValidateInput): Validated {
  const { value: v, ctx, read } = i;
  const dropped: string[] = [];

  // say — the answer. Markers come out first; then any sentence with an invented price, or one that
  // claims the opposite lean to the screen's, is dropped on its own.
  const { clean: rawSay, markers } = extractUiMarkers(clean(v.say, 1600));
  const kept: string[] = [];
  for (const s of sentences(rawSay)) {
    if (ungroundedPrices(s, ctx).length) { dropped.push("say:ungrounded_price"); continue; }
    if (contradictsLean(s, read.lean)) { dropped.push("say:contradicts_lean"); continue; }
    kept.push(s);
  }
  let say = kept.join(" ").trim();
  if (say.length < 2) { if (rawSay) dropped.push("say:replaced"); else dropped.push("say:missing"); say = i.fallbackSay; }

  // read — the engine's. The model's lean is only compared.
  const modelRead = v.read && typeof v.read === "object" ? (v.read as Record<string, unknown>) : null;
  const modelLean = modelRead?.lean;
  if (modelLean != null && modelLean !== read.lean) dropped.push(`read:lean_${isLean(modelLean) ? modelLean : "invalid"}`);

  let evidence = items(v.evidence, ctx, 3, dropped, "evidence");
  let against = items(v.against, ctx, 3, dropped, "against");
  if (!evidence.length && i.fillFromRead) evidence = itemsFromRead(read.evidenceFor, ctx, 3);
  if (!against.length && i.fillFromRead) against = itemsFromRead(read.evidenceAgainst, ctx, 2);

  const line = (raw: unknown, fallback: string | null, tag: string): string | null => {
    const t = clean(raw, 240);
    if (t && ungroundedPrices(t, ctx).length) { dropped.push(`${tag}:ungrounded_price`); return fallback; }
    return t || (i.fillFromRead ? fallback : null);
  };
  const next = line(v.next, read.nextWatch?.text ?? null, "next");
  const invalidation = line(v.invalidation, read.invalidation?.text ?? null, "invalidation");

  // actions — validated one by one against real levels, candles and scenarios.
  const actions: ChartAction[] = [];
  if (Array.isArray(v.actions)) {
    for (const raw of v.actions.slice(0, 8)) {
      const a = validateChartAction(raw, ctx);
      if (!a) { dropped.push(`action:${String((raw as Record<string, unknown>)?.type ?? "unknown")}`); continue; }
      if (a.type === "show_zone" && ungroundedPrices(`${a.from} ${a.to}`, ctx).length) { dropped.push("action:show_zone_ungrounded"); continue; }
      actions.push(a);
    }
  }
  actions.push(...markersToChartActions(markers, ctx));

  const fresh = withFreshnessCaveat(say, i.feed);
  return {
    answer: {
      say: fresh.say,
      read: answerReadOf(read),
      evidence, against, next, invalidation,
      freshness: i.freshness,
      actions: dedupeActions(actions, 4),
    },
    markers,
    dropped,
  };
}
