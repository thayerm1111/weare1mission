/**
 * ATLAS EXPLAINS ON THE CHART (owner 11-11: "Atlas must visually explain its answers directly on the live
 * chart while speaking … It should feel like an intelligent analyst pointing at the chart beside me.")
 *
 * An answer is turned into an EXPLANATION SEQUENCE: short spoken segments, the evidence each one refers to,
 * and the chart annotations that go with it — each cued at the character where it is mentioned, so the
 * annotation can appear as that phrase is spoken (the voice line knows which character is being spoken from
 * the provider's alignment data; a typed answer shows the whole sequence at once).
 *
 * THE MODEL NEVER DRAWS. Nothing here trusts a coordinate from the language model. An annotation exists only
 * when a price, a candle time or a word in the answer resolves to something REAL that the screen already
 * holds for this snapshot: a level by its ID, one of the read's own references (its support, resistance,
 * invalidation, a confirmed swing, a closed candle), a scenario by its ID, or the current candle. A number
 * that resolves to nothing draws nothing. That is the whole validation rule, and it is why this file takes
 * the screen's context rather than the model's output.
 *
 * STABLE IDS. An annotation's id is its kind and its real coordinates ("lv:4371.77", "sw:15m:1789742700000"),
 * so the same level mentioned in two answers is one line that is updated, not two; it can be faded and
 * removed by id; and an older response can never overwrite a newer one (every event carries its sequence).
 *
 * WHAT STAYS AND WHAT GOES. Evidence that is still true stays on the chart, at rest, when the next answer
 * starts. A conditional scenario path, a distance read-out and the current-candle marker belong to the
 * answer that drew them and go with it — an abandoned scenario is never left on the chart as if it stood.
 *
 * Pure and browser-safe: no I/O, no DOM, no clock except `now`. Shared by the server (tests) and the screen.
 */
import { CHART_TFS, levelIdOf, type AtlasRead, type ChartAction, type ChartTf, type EvidenceRef, type Scenario } from "./atlasContract";

export const EXPLAIN_VERSION = "explain-1";

export const EXPLAIN_RULES = {
  /** A spoken price is a real one when it is within this of it (cents are said exactly). */
  EXACT: 0.06,
  /** A price said in round numbers resolves to the ONE real price within this — or to nothing. */
  ROUND: 1.0,
  /** A number is only read as a gold price when it is within this fraction of the current price. */
  NEAR_PRICE: 0.12,
  /** Segments longer than this are split at a semicolon or a dash, so each stays a short spoken thought. */
  MAX_SEGMENT: 190,
  /** An annotation is cued this many characters early, so it lands as the phrase begins, not after it. */
  LEAD_CHARS: 6,
  /** Evidence at rest is removed after this long: the chart is not a museum of old answers. */
  REST_TTL_MS: 12 * 60_000,
  /** At most this many annotations at rest; the oldest go first. */
  MAX_REST: 7,
  /** An explanation stops being current after this long, whatever the market did. */
  TTL_MS: 10 * 60_000,
  /** How far through a watched level price must trade before the explanation is called obsolete. */
  CROSS: 0.2,
} as const;

export type AnnRole = "support" | "resistance" | "invalidation" | "watch" | "trigger" | "entry" | "stop" | "target" | "level";

export type Annotation =
  | { id: string; kind: "level"; price: number; label: string; levelId: string | null; role: AnnRole }
  | { id: string; kind: "zone"; from: number; to: number; label: string }
  | { id: string; kind: "candle"; tf: ChartTf; t: number; label: string }
  | { id: string; kind: "candles"; tf: ChartTf; from: number; to: number; label: string }
  | { id: string; kind: "swing"; tf: ChartTf; t: number; price: number; type: "high" | "low"; label: string }
  | { id: string; kind: "current"; label: string }
  | { id: string; kind: "distance"; price: number; label: string }
  | { id: string; kind: "scenario"; scenarioId: string; label: string };

/** Annotations that belong to the answer that drew them, and leave with it. */
const TRANSIENT: Annotation["kind"][] = ["scenario", "distance", "current"];
export const isTransient = (a: Annotation): boolean => TRANSIENT.includes(a.kind);

export type ExplainSegment = { i: number; text: string; start: number; end: number; annotations: string[] };
/**
 * "Annotation `id` is being talked about from character `at` of the answer, in segment `segment`." Its first
 * cue is when it appears; a later cue (the same level named again) is when it is emphasised again.
 */
export type ExplainCue = { at: number; id: string; segment: number };

export type ExplainWatch = { price: number; label: string; side: "above" | "below" };

export type Explanation = {
  version: string;
  responseId: string;
  snapshotId: number | null;
  analysisAt: number | null;
  /** When it was built, and gold then. An answer takes time to say: this is the briefing's own timestamp. */
  at: number;
  priceAt: number | null;
  /** The answer, whitespace collapsed. Character offsets below index into this. */
  text: string;
  segments: ExplainSegment[];
  annotations: Annotation[];
  cues: ExplainCue[];
  /** Real prices whose crossing makes this explanation obsolete. `side` is where gold was when it was built. */
  watch: ExplainWatch[];
  expiresAt: number;
};

export type ExplainBar = { t: number; o: number; h: number; l: number; c: number };
export type ExplainContext = {
  /** Every real level the screen holds for this snapshot (today's levels and the wider level map). */
  levels: { kind: string; price: number; label: string }[];
  read: AtlasRead | null;
  scenarios: Scenario[];
  /** The candles on hand, per timeframe (closed, plus the forming one last). */
  bars: Partial<Record<ChartTf, ExplainBar[]>>;
  price: number | null;
  snapshotId: number | null;
  analysisAt: number | null;
  /** Other real prices on screen with a name: a generated idea's entry, stop and targets; an open trade's levels. */
  named?: { price: number; label: string; role?: AnnRole }[];
  now: number;
};

/* ── small pieces ──────────────────────────────────────────────────────────────────────────────────── */

const TF_MS: Record<ChartTf, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
const fmt = (n: number): string => {
  const [i, d] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${d}`;
};
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const isTf = (v: unknown): v is ChartTf => (CHART_TFS as readonly string[]).includes(String(v));

export const annId = {
  level: (p: number) => `lv:${p.toFixed(2)}`,
  zone: (a: number, b: number) => `zn:${Math.min(a, b).toFixed(2)}:${Math.max(a, b).toFixed(2)}`,
  candle: (tf: ChartTf, t: number) => `cd:${tf}:${t}`,
  candles: (tf: ChartTf, a: number, b: number) => `cs:${tf}:${a}:${b}`,
  swing: (tf: ChartTf, t: number) => `sw:${tf}:${t}`,
  current: () => "now",
  distance: (p: number) => `ds:${p.toFixed(2)}`,
  scenario: (id: string) => `sc:${id}`,
};

/** Collapse whitespace: the text the offsets index into. The voice line normalises what it heard the same way. */
export const explainText = (raw: string): string => String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Short spoken segments. A sentence ends at . ! or ? followed by a space — so the point in 4,371.77 never
 * ends one — and a long sentence is split again at a semicolon or a spaced dash.
 */
export function segmentsOf(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const push = (a: number, b: number) => {
    while (a < b && text[a] === " ") a++;
    while (b > a && text[b - 1] === " ") b--;
    if (b > a) out.push({ text: text.slice(a, b), start: a, end: b });
  };
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const sentenceEnd = (c === "." || c === "!" || c === "?") && (i + 1 >= text.length || text[i + 1] === " ");
    if (!sentenceEnd) continue;
    push(from, i + 1);
    from = i + 1;
  }
  push(from, text.length);
  // A long thought is split where it pauses.
  const fine: typeof out = [];
  for (const s of out) {
    if (s.text.length <= EXPLAIN_RULES.MAX_SEGMENT) { fine.push(s); continue; }
    let a = s.start;
    const re = /;\s|\s[—–-]\s/g;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    const body = text.slice(s.start, s.end);
    while ((m = re.exec(body))) {
      const cut = s.start + m.index + m[0].length;
      if (cut - a < 40 || s.end - cut < 30) continue;
      fine.push({ text: text.slice(a, cut).trim(), start: a, end: cut });
      a = cut;
    }
    fine.push({ text: text.slice(a, s.end).trim(), start: a, end: s.end });
  }
  return fine.filter((s) => s.text.length > 0);
}

/** Numbers in a piece of text that could be gold prices: 4,371.77 · 4371.77 · 4,372 · 4372. */
export function pricesIn(text: string, near: number | null): { value: number; at: number; len: number; exact: boolean }[] {
  const out: { value: number; at: number; len: number; exact: boolean }[] = [];
  // No lookbehind (older Safari cannot parse one): the character before the number is captured and skipped.
  const re = /(^|[^\d.,:])(\d{1,2},\d{3}|\d{3,5})(\.\d{1,2})?(?![\d:]|,\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const lead = m[1].length;
    const value = Number((m[2] + (m[3] ?? "")).replace(/,/g, ""));
    // The next number may start right after this one's last character.
    re.lastIndex = m.index + m[0].length;
    if (!Number.isFinite(value) || value <= 0) continue;
    if (near != null && near > 0 && Math.abs(value - near) / near > EXPLAIN_RULES.NEAR_PRICE) continue;
    if (near == null && value < 500) continue;
    out.push({ value, at: m.index + lead, len: m[0].length - lead, exact: !!m[3] });
  }
  return out;
}

/* ── prices as they are SPOKEN ─────────────────────────────────────────────────────────────────────── */

const UNITS: Record<string, number> = {
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
type Tok = { w: string; at: number; end: number };

/** Two-digit groups the way a desk says a price: "forty-three" "seventy-one" → [43, 71]; "oh five" → [5]. */
function pairGroups(words: string[]): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in TENS) {
      const next = words[i + 1];
      if (next != null && next in UNITS && UNITS[next] >= 1 && UNITS[next] <= 9) { out.push(TENS[w] + UNITS[next]); i++; } else out.push(TENS[w]);
    } else if (w === "oh" || w === "o" || w === "zero") {
      const next = words[i + 1];
      if (next != null && next in UNITS && UNITS[next] <= 9 && next !== "oh" && next !== "o" && next !== "zero") { out.push(UNITS[next]); i++; } else out.push(0);
    } else if (w in UNITS) out.push(UNITS[w]);
    else return null;
  }
  return out;
}

/** "four thousand three hundred seventy one", "forty-three hundred and five". */
function cardinal(words: string[]): number | null {
  let total = 0, cur = 0, seen = false;
  for (const w of words) {
    if (w === "and") continue;
    if (w in UNITS) { cur += UNITS[w]; seen = true; }
    else if (w in TENS) { cur += TENS[w]; seen = true; }
    else if (w === "hundred") { cur = (cur || 1) * 100; seen = true; }
    else if (w === "thousand") { total += (cur || 1) * 1000; cur = 0; seen = true; }
    else return null;
  }
  return seen ? total + cur : null;
}

/**
 * Gold prices said in words — the voice line is told to speak numbers the way a person does ("forty-three
 * seventy-two"), so that is what its text contains. Returned with the position of the words in the text, so
 * an annotation can be cued on the phrase itself. A run of number words that is not near the price of gold
 * is not a price and is ignored.
 */
export function spokenPricesIn(text: string, near: number | null): { value: number; at: number; len: number; exact: boolean }[] {
  const toks: Tok[] = [];
  const re = /[A-Za-z]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) toks.push({ w: m[0].toLowerCase(), at: m.index, end: m.index + m[0].length });
  const isNum = (w: string) => w in UNITS || w in TENS || w === "hundred" || w === "thousand";
  // Number words belong to one price only when nothing but a space or a hyphen separates them: a comma is a
  // new clause ("forty-three seventy, two pips above").
  const joined = (a: Tok, b: Tok) => /^[\s-]*$/.test(text.slice(a.end, b.at));
  const out: { value: number; at: number; len: number; exact: boolean }[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (!isNum(toks[i].w) || toks[i].w === "o") continue;
    let j = i;
    let point = -1;
    while (j + 1 < toks.length && joined(toks[j], toks[j + 1])) {
      const w = toks[j + 1].w;
      if (isNum(w)) { j++; continue; }
      // "and" belongs to a number only after hundred/thousand ("forty-three hundred and five"); anywhere else it
      // joins two prices ("forty-three seventy-one and forty-three ninety-two"), which stay two.
      const andOk = w === "and" && point < 0 && (toks[j].w === "hundred" || toks[j].w === "thousand");
      if ((andOk || (w === "point" && point < 0)) && j + 2 < toks.length && isNum(toks[j + 2].w) && joined(toks[j + 1], toks[j + 2])) {
        if (w === "point") point = j + 1;
        j += 2; continue;
      }
      break;
    }
    const run = toks.slice(i, j + 1);
    const intWords = (point >= 0 ? toks.slice(i, point) : run).map((t) => t.w);
    const decWords = point >= 0 ? toks.slice(point + 1, j + 1).map((t) => t.w) : [];
    let value: number | null = null, exact = false;
    if (intWords.includes("thousand") || intWords.includes("hundred")) value = cardinal(intWords);
    else {
      const g = pairGroups(intWords.filter((w) => w !== "and"));
      if (g && g.length === 2 && g[0] >= 10) value = g[0] * 100 + g[1];
      else if (g && g.length === 3 && g[0] >= 10 && g[2] < 100) { value = g[0] * 100 + g[1] + g[2] / 100; exact = true; }
    }
    if (value != null && decWords.length) {
      // "point seven seven" and "point oh five" are digits; "point seventy-seven" is a pair.
      const single = decWords.every((w) => w in UNITS && UNITS[w] <= 9);
      const g = single ? null : pairGroups(decWords);
      const digits = single ? decWords.map((w) => UNITS[w]).join("") : g && g.length === 1 ? String(g[0]).padStart(2, "0") : null;
      if (digits == null) value = null;
      else { value += Number(`0.${digits}`); exact = true; }
    }
    if (value != null && Number.isFinite(value) && near != null && near > 0 && Math.abs(value - near) / near <= EXPLAIN_RULES.NEAR_PRICE) {
      out.push({ value: Math.round(value * 100) / 100, at: run[0].at, len: run[run.length - 1].end - run[0].at, exact });
    }
    i = j;
  }
  return out;
}

/** Other ways a session level is said aloud. */
const LEVEL_ALIASES: Record<string, string[]> = {
  pdh: ["yesterday's high", "previous day's high", "previous day high", "prior day's high", "prior day high"],
  pdl: ["yesterday's low", "previous day's low", "previous day low", "prior day's low", "prior day low"],
  dh: ["today's high", "the day's high", "high of the day", "session high"],
  dl: ["today's low", "the day's low", "low of the day", "session low"],
  london_high: ["london high", "london's high", "london session high"],
  london_low: ["london low", "london's low", "london session low"],
  ny_high: ["new york high", "new york's high", "new york session high"],
  ny_low: ["new york low", "new york's low", "new york session low"],
  asia_high: ["asia high", "asian high", "asia session high", "asian session high"],
  asia_low: ["asia low", "asian low", "asia session low", "asian session low"],
  daily_open: ["daily open", "the day's open", "today's open"],
  weekly_open: ["weekly open", "the week's open"],
  pwh: ["last week's high"], pwl: ["last week's low"], wh: ["this week's high"], wl: ["this week's low"],
};

/** Levels the segment names aloud ("the London low") — only when exactly one real level carries that name. */
function levelsNamedIn(seg: string, levels: ExplainContext["levels"]): { price: number; at: number }[] {
  const low = seg.toLowerCase().replace(/[’`]/g, "'");
  const out: { price: number; at: number }[] = [];
  const seenAt = new Set<number>();
  for (const [kind, names] of Object.entries(LEVEL_ALIASES)) {
    const have = levels.filter((l) => l.kind === kind);
    if (have.length !== 1) continue;
    for (const name of names) {
      const at = low.indexOf(name);
      if (at < 0 || seenAt.has(at)) continue;
      const before = at > 0 ? low[at - 1] : " ", after = low[at + name.length] ?? " ";
      if (/[a-z]/.test(before) || /[a-z]/.test(after)) continue;
      seenAt.add(at);
      out.push({ price: have[0].price, at });
      break;
    }
  }
  return out;
}

/* ── what is real ──────────────────────────────────────────────────────────────────────────────────── */

type Known = { price: number; ann: Annotation; rank: number; extra?: Annotation[] };

/** The read's two levels, from its own references (the same recovery core/read.ts edgesOfRead does). */
function edgesOf(r: AtlasRead | null): { support: { price: number; ref?: EvidenceRef } | null; resistance: { price: number; ref?: EvidenceRef } | null } {
  const none = { support: null, resistance: null };
  if (!r) return none;
  const px = (ref?: EvidenceRef): number | null => (ref && (ref.kind === "level" || ref.kind === "swing") ? ref.price : null);
  const inv = r.invalidation?.price != null && Number.isFinite(r.invalidation.price) ? { price: r.invalidation.price, ...(r.invalidation.ref ? { ref: r.invalidation.ref } : {}) } : null;
  const nwPx = px(r.nextWatch?.ref);
  const nw = nwPx != null ? { price: nwPx, ref: r.nextWatch!.ref } : null;
  if (r.lean === "bullish_lean") return { support: inv, resistance: nw };
  if (r.lean === "bearish_lean") return { support: nw, resistance: inv };
  if (r.lean === "balanced") {
    const z = r.nextWatch?.ref;
    return z?.kind === "zone" && z.from < z.to ? { support: { price: z.from }, resistance: { price: z.to } } : none;
  }
  if (r.lean === "transitioning" && inv && nw) return nw.price > inv.price ? { support: inv, resistance: nw } : { support: nw, resistance: inv };
  return none;
}

const tfWord = (tf: ChartTf) => (tf === "1d" ? "daily" : tf === "1h" ? "1-hour" : tf === "4h" ? "4-hour" : `${tf.replace("m", "")}-minute`);

/** Everything a price in the answer may resolve to, most specific first. */
function knownOf(ctx: ExplainContext): { known: Known[]; support: Known | null; resistance: Known | null; invalidation: Known | null } {
  const known: Known[] = [];
  const labelFor = (price: number, fallback: string): { label: string; levelId: string | null } => {
    const lv = ctx.levels.find((l) => Math.abs(l.price - price) < EXPLAIN_RULES.EXACT);
    return lv ? { label: cap(lv.label), levelId: levelIdOf(lv) } : { label: fallback, levelId: null };
  };
  const level = (price: number, role: AnnRole, fallback: string, rank: number, extra?: Annotation[]): Known => {
    const { label, levelId } = labelFor(price, fallback);
    return { price, rank, ann: { id: annId.level(price), kind: "level", price: +price.toFixed(2), label, levelId, role }, ...(extra ? { extra } : {}) };
  };
  /** A reference the read carries: the swing or candle it points at is drawn with the level. */
  const refExtra = (ref?: EvidenceRef): Annotation[] => {
    if (!ref) return [];
    if (ref.kind === "swing" && isTf(ref.tf)) return [{ id: annId.swing(ref.tf, ref.t), kind: "swing", tf: ref.tf, t: ref.t, price: ref.price, type: ref.type, label: `${cap(tfWord(ref.tf))} swing ${ref.type} ${fmt(ref.price)}` }];
    if (ref.kind === "candle" && isTf(ref.tf)) return [{ id: annId.candle(ref.tf, ref.t), kind: "candle", tf: ref.tf, t: ref.t, label: `${cap(tfWord(ref.tf))} candle` }];
    return [];
  };

  const r = ctx.read;
  const e = edgesOf(r);
  let invalidation: Known | null = null, support: Known | null = null, resistance: Known | null = null;
  if (r?.invalidation?.price != null) {
    invalidation = level(r.invalidation.price, "invalidation", "Read invalidation", 1, refExtra(r.invalidation.ref));
    known.push(invalidation);
  }
  if (e.support) { support = level(e.support.price, "support", "Support", 2, refExtra(e.support.ref)); known.push(support); }
  if (e.resistance) { resistance = level(e.resistance.price, "resistance", "Resistance", 2, refExtra(e.resistance.ref)); known.push(resistance); }
  for (const sc of ctx.scenarios) {
    if (sc.status !== "watching" && sc.status !== "developing") continue;
    if (sc.trigger.price != null) known.push(level(sc.trigger.price, "trigger", "Scenario trigger", 3, refExtra(sc.trigger.ref)));
    if (sc.invalidation.price != null) known.push(level(sc.invalidation.price, "invalidation", "Scenario invalidation", 4, refExtra(sc.invalidation.ref)));
  }
  for (const ev of [...(r?.evidenceFor ?? []), ...(r?.evidenceAgainst ?? [])]) {
    const ref = ev.ref;
    if (!ref) continue;
    if (ref.kind === "level") known.push(level(ref.price, "level", "Level", 5));
    else if (ref.kind === "swing") known.push(level(ref.price, "level", `${cap(tfWord(ref.tf as ChartTf))} swing ${ref.type}`, 5, refExtra(ref)));
  }
  for (const n of ctx.named ?? []) {
    if (Number.isFinite(n.price) && n.price > 0) known.push({ price: n.price, rank: 6, ann: { id: annId.level(n.price), kind: "level", price: +n.price.toFixed(2), label: n.label, levelId: null, role: n.role ?? "level" } });
  }
  for (const l of ctx.levels) {
    if (Number.isFinite(l.price) && l.price > 0) known.push({ price: l.price, rank: 7, ann: { id: annId.level(l.price), kind: "level", price: +l.price.toFixed(2), label: cap(l.label), levelId: levelIdOf(l), role: "level" } });
  }
  return { known, support, resistance, invalidation };
}

/** The real thing a spoken price is, or null. Exact first; a round number only when exactly one real price is near. */
function resolvePrice(value: number, exact: boolean, known: Known[]): Known | null {
  const R = EXPLAIN_RULES;
  const hits = known.filter((k) => Math.abs(k.price - value) < R.EXACT).sort((a, b) => a.rank - b.rank);
  if (hits.length) return hits[0];
  if (exact) return null;                                   // cents were said and they match nothing: not real
  const near = known.filter((k) => Math.abs(k.price - value) <= R.ROUND);
  const distinct = [...new Set(near.map((k) => k.price.toFixed(2)))];
  if (distinct.length !== 1) return null;                   // ambiguous or nothing: draw nothing
  return near.sort((a, b) => a.rank - b.rank)[0];
}

/** A candle named by its close time ("the 15-minute candle that closed at 14:30 UTC"), if it is really on hand. */
function candleByClose(seg: string, ctx: ExplainContext): Annotation | null {
  const m = /(\d{1,2}):(\d{2})\s*UTC/i.exec(seg);
  if (!m) return null;
  const tf: ChartTf | null = /\b15[- ]?min/i.test(seg) ? "15m" : /\b(5|five)[- ]?min/i.test(seg) ? "5m" : /\b(1[- ]?hour|hourly|60[- ]?min)/i.test(seg) ? "1h" : /\b(4[- ]?hour)/i.test(seg) ? "4h" : null;
  if (!tf) return null;
  const bars = ctx.bars[tf] ?? [];
  if (!bars.length) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  // The newest candle on hand whose CLOSE is that time of day.
  for (let i = bars.length - 1; i >= 0; i--) {
    const close = new Date(bars[i].t + TF_MS[tf]);
    if (close.getUTCHours() === hh && close.getUTCMinutes() === mm) {
      return { id: annId.candle(tf, bars[i].t), kind: "candle", tf, t: bars[i].t, label: `${cap(tfWord(tf))} candle · closed ${m[1].padStart(2, "0")}:${m[2]} UTC` };
    }
  }
  return null;
}

const COUNT_WORD: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6 };

/** "The last three closed 5-minute candles" — the run itself, from the candles on hand. */
function candleRun(seg: string, ctx: ExplainContext): Annotation | null {
  const m = /\blast\s+(two|three|four|five|six|[2-6])\s+(?:closed\s+)?(?:(5|five|15|fifteen)[- ]?minute\s+)?candles\b/i.exec(seg);
  if (!m) return null;
  const n = COUNT_WORD[m[1].toLowerCase()];
  const tf: ChartTf = m[2] && /15|fifteen/i.test(m[2]) ? "15m" : "5m";
  const bars = ctx.bars[tf] ?? [];
  const closed = bars.filter((b) => b.t + TF_MS[tf] <= ctx.now);
  if (!n || closed.length < n) return null;
  const run = closed.slice(-n);
  return { id: annId.candles(tf, run[0].t, run[n - 1].t), kind: "candles", tf, from: run[0].t, to: run[n - 1].t, label: `Last ${n} closed ${tfWord(tf)} candles` };
}

/** A validated chart action from the server's structured answer, as an annotation. */
export function annotationOfAction(a: ChartAction): Annotation | null {
  if (a.type === "highlight_level") return { id: annId.level(a.price), kind: "level", price: +a.price.toFixed(2), label: cap(a.label.replace(/\s+[\d,]+\.\d{2}$/, "")), levelId: a.levelId, role: "level" };
  if (a.type === "show_zone") return { id: annId.zone(a.from, a.to), kind: "zone", from: Math.min(a.from, a.to), to: Math.max(a.from, a.to), label: a.label };
  if (a.type === "mark_candle") return { id: annId.candle(a.tf, a.t), kind: "candle", tf: a.tf, t: a.t, label: a.label };
  if (a.type === "scenario" && a.scenarioId) return { id: annId.scenario(a.scenarioId), kind: "scenario", scenarioId: a.scenarioId, label: "Conditional scenario" };
  return null;
}

/* ── the explanation ───────────────────────────────────────────────────────────────────────────────── */

export type BuildExplanationInput = {
  responseId: string;
  text: string;
  ctx: ExplainContext;
  /** Chart actions the server already validated for this answer (the structured chat answer). */
  actions?: ChartAction[];
  /**
   * What the MEMBER pointed at when they asked (the candle they tapped for "Explain this candle"). It is theirs
   * and it is real — the chart handed it over — so it is on the chart from the answer's first word.
   */
  lead?: Annotation[];
};

export function buildExplanation(i: BuildExplanationInput): Explanation {
  const { ctx } = i;
  const R = EXPLAIN_RULES;
  const text = explainText(i.text);
  const { known, support, resistance, invalidation } = knownOf(ctx);
  const annotations = new Map<string, Annotation>();
  const cues: ExplainCue[] = [];
  const watch = new Map<string, ExplainWatch>();
  // One cue per annotation per segment: a level named again in a later sentence lights again on that phrase.
  const add = (a: Annotation, at: number, segment: number) => {
    if (!annotations.has(a.id)) annotations.set(a.id, a);
    if (!cues.some((c) => c.id === a.id && c.segment === segment)) cues.push({ at: Math.max(0, at - R.LEAD_CHARS), id: a.id, segment });
  };
  const watchLevel = (k: Known | null) => {
    if (!k || ctx.price == null) return;
    if (Math.abs(ctx.price - k.price) < R.CROSS) return;      // price is on it: it cannot be "crossed" yet
    watch.set(k.ann.id, { price: k.price, label: k.ann.kind === "level" ? k.ann.label : "level", side: ctx.price > k.price ? "above" : "below" });
  };
  const liveScenarios = ctx.scenarios.filter((s) => s.status === "watching" || s.status === "developing");
  const leadIds: string[] = [];
  for (const a of i.lead ?? []) { add(a, 0, 0); leadIds.push(a.id); }

  const segments: ExplainSegment[] = segmentsOf(text).map((s, idx) => {
    const seg = s.text, low = seg.toLowerCase();
    const before = new Set(annotations.keys());
    const mentioned: Known[] = [];

    /* 1 — prices said in this segment: in digits (the typed console) or in words (the voice). */
    const prices = [...pricesIn(seg, ctx.price), ...spokenPricesIn(seg, ctx.price)].sort((a, b) => a.at - b.at);
    // A range between two real prices is a zone.
    for (let k = 0; k + 1 < prices.length; k++) {
      const a = prices[k], b = prices[k + 1];
      const between = seg.slice(a.at + a.len, b.at);
      if (!/^\s*(–|—|-|to|and)\s*$/i.test(between)) continue;
      const ka = resolvePrice(a.value, a.exact, known), kb = resolvePrice(b.value, b.exact, known);
      if (!ka || !kb || Math.abs(ka.price - kb.price) < 0.05) continue;
      const from = Math.min(ka.price, kb.price), to = Math.max(ka.price, kb.price);
      if (ctx.price != null && (to - from) / ctx.price > 0.03) continue;
      add({ id: annId.zone(from, to), kind: "zone", from, to, label: `${fmt(from)} – ${fmt(to)}` }, s.start + a.at, idx);
    }
    for (const p of prices) {
      const onLevel = known.some((k) => Math.abs(k.price - p.value) < R.EXACT);
      const nearNow = ctx.price != null && Math.abs(p.value - ctx.price) <= (p.exact ? R.EXACT : R.ROUND);
      const k = resolvePrice(p.value, p.exact, known);
      if (nearNow && !onLevel) {
        // The price of gold itself — unless a real level is just as near, in which case it is not clear which
        // was meant and nothing is drawn.
        if (!k) add({ id: annId.current(), kind: "current", label: `Now ${fmt(ctx.price as number)}` }, s.start + p.at, idx);
        continue;
      }
      if (!k) continue;                                        // a number that is nothing real draws nothing
      mentioned.push(k);
      add(k.ann, s.start + p.at, idx);
      for (const x of k.extra ?? []) add(x, s.start + p.at, idx);
      if (k.ann.kind === "level" && (k.ann.role === "invalidation" || k.ann.role === "trigger" || k.ann.role === "support" || k.ann.role === "resistance")) watchLevel(k);
    }

    /* 1b — a level named aloud ("the London low"), when exactly one real level has that name. */
    for (const nm of levelsNamedIn(seg, ctx.levels)) {
      const k = resolvePrice(nm.price, true, known);
      if (!k || mentioned.includes(k)) continue;
      mentioned.push(k);
      add(k.ann, s.start + nm.at, idx);
      for (const x of k.extra ?? []) add(x, s.start + nm.at, idx);
      if (k.ann.kind === "level" && (k.ann.role === "invalidation" || k.ann.role === "trigger" || k.ann.role === "support" || k.ann.role === "resistance")) watchLevel(k);
    }

    /* 2 — words that point at something the read names, when no price said it already. */
    const word = (re: RegExp): number => { const m = re.exec(low); return m ? m.index : -1; };
    const pointAt = (k: Known | null, at: number) => {
      if (!k || at < 0 || mentioned.includes(k)) return;
      mentioned.push(k);
      add(k.ann, s.start + at, idx);
      for (const x of k.extra ?? []) add(x, s.start + at, idx);
      watchLevel(k);
    };
    pointAt(resistance, word(/\bresistance\b/));
    pointAt(support, word(/\bsupport\b/));
    pointAt(invalidation, word(/\b(invalidat\w*|prove (me|it|the read) wrong|would change my (mind|view)|ends? the (bullish|bearish) lean)\b/));

    /* 3 — candles: one named by its close time, a run of the last few, the one forming now. */
    const named = candleByClose(seg, ctx);
    if (named) add(named, s.start + Math.max(0, word(/\d{1,2}:\d{2}\s*utc/)), idx);
    const run = candleRun(seg, ctx);
    if (run) add(run, s.start + Math.max(0, word(/\blast\s+(two|three|four|five|six|[2-6])\b/)), idx);
    const nowAt = word(/\b(right now|at the moment|currently|current candle|this candle|forming candle|candle that is forming|as i speak)\b/);
    if (nowAt >= 0 && ctx.price != null) add({ id: annId.current(), kind: "current", label: `Now ${fmt(ctx.price)}` }, s.start + nowAt, idx);

    /* 4 — a conditional path: only ever a real scenario, by its ID. */
    const scAt = word(/\b(base case|scenario|alternative|if (it|gold|price) (closes|breaks|holds|accepts|loses)|what would change)\b/);
    if (scAt >= 0 && liveScenarios.length) {
      const wantsDown = /\b(below|lower|breakdown|bearish|loses|sell)\b/.test(low), wantsUp = /\b(above|higher|breakout|bullish|buy)\b/.test(low);
      const byPrice = liveScenarios.find((sc) => mentioned.some((k) => sc.trigger.price != null && Math.abs(sc.trigger.price - k.price) < R.EXACT));
      const byRole = /\balternative\b/.test(low) ? liveScenarios.find((sc) => sc.role === "alternative")
        : /\bwhat would change|change my (mind|view)\b/.test(low) ? liveScenarios.find((sc) => sc.role === "view_change")
        : /\bbase case\b/.test(low) ? liveScenarios.find((sc) => sc.role === "base") : undefined;
      const byDir = wantsDown !== wantsUp ? liveScenarios.find((sc) => sc.direction === (wantsDown ? "down" : "up")) : undefined;
      const sc = byPrice ?? byRole ?? byDir ?? liveScenarios.find((x) => x.role === "base");
      if (sc) add({ id: annId.scenario(sc.id), kind: "scenario", scenarioId: sc.id, label: `Conditional scenario · ${sc.title}` }, s.start + scAt, idx);
    }

    /* 5 — how far price is from what is being watched, when the answer talks about getting there. */
    const distAt = word(/\b(approaching|closing in on|heading (for|to|toward)|pips? (from|away|below|above|short of)|distance|next i'?m watching|watching)\b/);
    const target = mentioned.find((k) => k.ann.kind === "level");
    if (distAt >= 0 && target && ctx.price != null && Math.abs(target.price - ctx.price) > 0.3) {
      add({ id: annId.distance(target.price), kind: "distance", price: target.price, label: target.ann.kind === "level" ? target.ann.label : "level" }, s.start + distAt, idx);
    }

    return { i: idx, text: seg, start: s.start, end: s.end, annotations: [...(idx === 0 ? leadIds : []), ...[...annotations.keys()].filter((id) => !before.has(id))] };
  });

  /* The server's own validated actions: attached where their price is said, else to the last segment. */
  for (const act of i.actions ?? []) {
    const a = annotationOfAction(act);
    if (!a || annotations.has(a.id)) continue;
    const last = segments[segments.length - 1];
    if (!last) break;
    add(a, last.start, last.i);
    last.annotations.push(a.id);
  }

  cues.sort((a, b) => a.at - b.at);
  return {
    version: EXPLAIN_VERSION, responseId: i.responseId, snapshotId: ctx.snapshotId, analysisAt: ctx.analysisAt,
    at: ctx.now, priceAt: ctx.price, text, segments, annotations: [...annotations.values()], cues,
    watch: [...watch.values()], expiresAt: ctx.now + R.TTL_MS,
  };
}

/* ── playing it ────────────────────────────────────────────────────────────────────────────────────── */

export type ShownAnnotation = { ann: Annotation; responseId: string; active: boolean; shownAt: number };

export type ExplainState = {
  /** Only ever increases: a response with a lower sequence than this is an old one and is ignored. */
  seq: number;
  explanation: Explanation | null;
  /** "showing": the member is stepping back through a finished answer ("Show me"). */
  status: "idle" | "explaining" | "done" | "cancelled" | "corrected" | "showing";
  /** How many characters of the answer have been spoken (Infinity for a typed answer). */
  chars: number;
  /** The segment being spoken, or -1. */
  segment: number;
  shown: ShownAnnotation[];
  /** One line when the market overtook the explanation. */
  correction: string | null;
};

export const NO_EXPLANATION: ExplainState = { seq: 0, explanation: null, status: "idle", chars: 0, segment: -1, shown: [], correction: null };

export type ExplainEvent =
  | { type: "begin"; seq: number; explanation: Explanation }
  /**
   * More of the SAME response is now known (its words arrive with its audio, a little ahead of being heard):
   * the explanation is replaced in place. Nothing already spoken is replayed and nothing flickers.
   */
  | { type: "update"; responseId: string; explanation: Explanation }
  /** `chars` characters of that response have now been spoken. */
  | { type: "progress"; responseId: string; chars: number }
  | { type: "end"; responseId: string }
  /** Interrupted or stopped: nothing further from that response is shown. */
  | { type: "cancel"; responseId: string }
  /** The market made it obsolete. */
  | { type: "correct"; responseId: string; text: string }
  /** The member asked to see one annotation again. */
  | { type: "focus"; id: string }
  /** "Show me": step to segment `segment` of the answer on the chart and emphasise what it refers to. */
  | { type: "show"; segment: number }
  /** Stop emphasising: everything on the chart comes to rest, and a correction caption is dismissed. */
  | { type: "rest" }
  | { type: "remove"; id: string }
  | { type: "prune" }
  | { type: "clear" };

/** The segment being spoken once `chars` characters have been. */
export function segmentAt(ex: Explanation, chars: number): number {
  let cur = -1;
  for (const s of ex.segments) { if (s.start <= chars) cur = s.i; else break; }
  return cur;
}

const rest = (list: ShownAnnotation[]): ShownAnnotation[] => list.map((x) => (x.active ? { ...x, active: false } : x));
const capRest = (list: ShownAnnotation[]): ShownAnnotation[] => {
  const resting = list.filter((x) => !x.active);
  if (resting.length <= EXPLAIN_RULES.MAX_REST) return list;
  const drop = new Set(resting.sort((a, b) => a.shownAt - b.shownAt).slice(0, resting.length - EXPLAIN_RULES.MAX_REST).map((x) => x.ann.id));
  return list.filter((x) => !drop.has(x.ann.id));
};

/**
 * One step of the explanation on the chart. Pure: the same state and event always give the same state.
 *
 *  • begin    a NEWER response replaces the current one. Evidence already on the chart stays, at rest; a
 *             scenario path, distance read-out or current-candle marker from the old answer goes.
 *  • progress annotations appear when their own mention is reached; the ones in the segment being spoken are
 *             emphasised, earlier ones rest. Progress never runs backwards.
 *  • cancel   an interruption: nothing more from that response appears, and its conditional path is removed.
 *  • update   more of the same response became known: replaced in place, what has been spoken stays as it is.
 *  • correct  the market crossed a level the answer stood on: its conditional path goes, and it is said once.
 */
export function explainStep(s: ExplainState, e: ExplainEvent, now: number): ExplainState {
  switch (e.type) {
    case "begin": {
      if (e.seq <= s.seq) return s;                           // an older response can never overwrite a newer one
      const kept = capRest(rest(s.shown).filter((x) => !isTransient(x.ann)));
      return { seq: e.seq, explanation: e.explanation, status: "explaining", chars: 0, segment: -1, shown: kept, correction: null };
    }
    case "update": {
      const cur = s.explanation;
      if (!cur || cur.responseId !== e.responseId || s.status !== "explaining") return s;
      // The briefing keeps the moment it started; only what it refers to has grown.
      const ex: Explanation = { ...e.explanation, at: cur.at, priceAt: cur.priceAt, expiresAt: cur.expiresAt };
      const ids = new Set(ex.annotations.map((a) => a.id));
      // Something the shorter text seemed to point at, that the fuller text does not: off the chart.
      const shown = s.shown.filter((x) => x.responseId !== ex.responseId || ids.has(x.ann.id));
      const base: ExplainState = { ...s, explanation: ex, shown };
      const stepped = explainStep({ ...base, chars: Math.max(0, s.chars - 1) }, { type: "progress", responseId: ex.responseId, chars: s.chars }, now);
      return { ...stepped, chars: s.chars };
    }
    case "progress": {
      const ex = s.explanation;
      if (!ex || ex.responseId !== e.responseId || s.status !== "explaining") return s;
      const chars = Math.max(s.chars, e.chars);
      const segment = segmentAt(ex, chars);
      const due = ex.cues.filter((c) => c.at <= chars);
      const dueIds = new Set(due.map((c) => c.id));
      const inSegment = new Set(due.filter((c) => c.segment === segment).map((c) => c.id));
      const have = new Map(s.shown.map((x) => [x.ann.id, x]));
      let changed = chars !== s.chars || segment !== s.segment;
      const next: ShownAnnotation[] = s.shown.map((x) => {
        const active = inSegment.has(x.ann.id);
        if (dueIds.has(x.ann.id) && (x.active !== active || x.responseId !== ex.responseId)) { changed = true; return { ...x, active, responseId: ex.responseId }; }
        if (!dueIds.has(x.ann.id) && x.active) { changed = true; return { ...x, active: false }; }
        return x;
      });
      for (const a of ex.annotations) {
        if (!dueIds.has(a.id) || have.has(a.id)) continue;
        changed = true;
        next.push({ ann: a, responseId: ex.responseId, active: inSegment.has(a.id), shownAt: now });
      }
      return changed ? { ...s, chars, segment, shown: capRest(next) } : s;
    }
    case "end": {
      if (s.explanation?.responseId !== e.responseId || s.status !== "explaining") return s;
      // Whatever the answer referred to is now on the chart, at rest — including anything a cut-short audio
      // clock never reached (the words were all said).
      const all = explainStep({ ...s }, { type: "progress", responseId: e.responseId, chars: Number.MAX_SAFE_INTEGER }, now);
      return { ...all, status: "done", segment: -1, shown: capRest(rest(all.shown)) };
    }
    case "cancel": {
      if (s.explanation?.responseId !== e.responseId || s.status !== "explaining") return s;
      return { ...s, status: "cancelled", segment: -1, shown: rest(s.shown).filter((x) => !(x.responseId === e.responseId && isTransient(x.ann))) };
    }
    case "correct": {
      if (s.explanation?.responseId !== e.responseId) return s;
      if (s.status === "corrected") return s;
      // Said once: an explanation that has been corrected is obsolete and watches nothing further.
      return {
        ...s, explanation: { ...s.explanation, watch: [] }, status: "corrected", segment: -1, correction: e.text,
        shown: rest(s.shown).filter((x) => !(x.responseId === e.responseId && isTransient(x.ann))),
      };
    }
    case "focus": {
      if (!s.shown.some((x) => x.ann.id === e.id)) {
        const a = s.explanation?.annotations.find((x) => x.id === e.id);
        if (!a) return s;
        return { ...s, shown: capRest([...rest(s.shown), { ann: a, responseId: s.explanation!.responseId, active: true, shownAt: now }]) };
      }
      return { ...s, shown: s.shown.map((x) => ({ ...x, active: x.ann.id === e.id })) };
    }
    case "show": {
      const ex = s.explanation;
      const seg = ex?.segments[e.segment];
      if (!ex || !seg || s.status === "explaining") return s;      // never over a live explanation
      const ids = new Set(ex.cues.filter((c) => c.segment === seg.i).map((c) => c.id));
      const have = new Set(s.shown.map((x) => x.ann.id));
      const next = s.shown.map((x) => ({ ...x, active: ids.has(x.ann.id) }));
      for (const a of ex.annotations) if (ids.has(a.id) && !have.has(a.id)) next.push({ ann: a, responseId: ex.responseId, active: true, shownAt: now });
      return { ...s, status: "showing", segment: seg.i, shown: capRest(next) };
    }
    case "rest": {
      if (s.status === "explaining") return s;                  // a live explanation is stopped, not rested
      if (s.status !== "showing" && s.status !== "corrected" && !s.shown.some((x) => x.active)) return s;
      return { ...s, status: s.explanation ? "done" : "idle", segment: -1, correction: null, shown: capRest(rest(s.shown)) };
    }
    case "remove":
      return s.shown.some((x) => x.ann.id === e.id) ? { ...s, shown: s.shown.filter((x) => x.ann.id !== e.id) } : s;
    case "prune": {
      const keep = s.shown.filter((x) => x.active || now - x.shownAt <= EXPLAIN_RULES.REST_TTL_MS);
      return keep.length === s.shown.length ? s : { ...s, shown: keep };
    }
    case "clear":
      return { ...NO_EXPLANATION, seq: s.seq };
    default:
      return s;
  }
}

/* ── when the market overtakes the explanation ─────────────────────────────────────────────────────── */

/**
 * Has gold traded through something this explanation was standing on? Deterministic: a price and a list of
 * real levels, no model. A level counts as crossed only once price is clearly through it (CROSS), so a tick
 * sitting on the level does not flip the answer back and forth.
 */
export function crossedWatch(ex: Explanation | null, price: number | null, now: number): ExplainWatch | null {
  if (!ex || price == null || !Number.isFinite(price) || now > ex.expiresAt) return null;
  for (const w of ex.watch) {
    if (w.side === "above" ? price < w.price - EXPLAIN_RULES.CROSS : price > w.price + EXPLAIN_RULES.CROSS) return w;
  }
  return null;
}

/** The correction, said once and briefly. */
export function correctionLine(w: ExplainWatch, price: number): string {
  return `Correction: gold has just traded ${w.side === "above" ? "below" : "above"} ${fmt(w.price)} (${w.label.toLowerCase()}). It is ${fmt(price)} now, so what I said about that level no longer stands.`;
}

/** The next segment of an answer that points at something, after `from` (wrapping). -1 when none does. */
export function nextShownSegment(ex: Explanation | null, from: number): number {
  if (!ex) return -1;
  const withCues = [...new Set(ex.cues.map((c) => c.segment))].sort((a, b) => a - b);
  if (!withCues.length) return -1;
  return withCues.find((i) => i > from) ?? withCues[0];
}

/** How far gold has moved since the briefing was built, in pips ($0.10) — for the caption, never for a decision. */
export function movedSince(ex: Explanation | null, price: number | null): number | null {
  if (!ex || ex.priceAt == null || price == null) return null;
  return Math.round((price - ex.priceAt) / 0.1);
}
