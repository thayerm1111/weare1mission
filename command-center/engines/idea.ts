/**
 * ATLAS TRADE IDEA — "GENERATE" (owner 11-11: "When I click generate I want atlas to give me the trade idea
 * and where I should enter. I want the engine of atlas though to run the trade.")
 *
 * One function turns what ATLAS already measured into a single answer a member can act on: which way, where
 * to enter, where the stop goes, where it is aiming, why, and what would make it wrong. Nothing here is a
 * second opinion — it is the setup engine's trade when there is one, and otherwise a plan built from the
 * read's own two levels with the setup engine's own pricing rules.
 *
 * TWO SOURCES, NEVER BLURRED.
 *
 *   • SETUP ENGINE (source "setup_engine"). When engines/setup.ts has a trade READY, the idea IS that trade,
 *     number for number: the same entry band, stop and objectives the member is shown on the trade card and
 *     the server recomputes before an order is sent. When the engine has everything but its trigger, the
 *     idea is that trade with the entry it is waiting for.
 *
 *   • THE READ (source "read_plan"). When the engine has no trade, ATLAS still knows which way it leans and
 *     the two prices that lean stands on (core/read.ts — the same support and resistance the scenario cards
 *     show). With a clear or strong lean the idea is a PLAN at one of those two levels: the pullback to the
 *     level the lean stands on, or the break through the far one. It is labelled a plan, it says the setup
 *     engine has not confirmed a trade, it is off the moment the lean changes, and it is never an entry at
 *     the price gold happens to be at: a directional lean alone does not become an entry. A neutral, turning
 *     or faint read produces no plan — only where a trade would be.
 *
 * THE RULES (the setup engine's, applied to a level instead of to the current price).
 *
 *   • EVERY NUMBER IS REAL. The entry is a level ATLAS already names. The stop is that level plus the
 *     engine's own ATR pad, spread and slippage allowance. A target is a real level at least one R away;
 *     when price is in open space and no real level exists, the targets are the engine's own fallback
 *     multiples and every one of them says so.
 *   • A STYLE IS NOT STRETCHED TO FIT. The stop has to sit inside the style's own noise floor and ceiling,
 *     and the room has to belong to that style's band, or that pairing is refused — exactly as the engine
 *     refuses it.
 *   • IT ALWAYS ANSWERS (owner 11-11: "I don't want it ever to stand down. I want it forced to read the
 *     market and come up with a direction and a trade."). When the setup engine has no trade and the read
 *     has no plan — a chaotic market, a range, a turning or faint read, a level that does not survive the
 *     arithmetic — the idea is a FORCED READ (source "forced_read"): the side the evidence tilts to with the
 *     abstention threshold removed, an entry, a stop inside the style's own limits and targets. It is
 *     labelled as forced, it carries the engine's own reason for standing down, its conviction is whatever
 *     the evidence is (usually low), and executing it is always the member's call. Nothing about the setup
 *     engine or the order checks changes: the engine still stands down on its own account.
 *     The one thing that cannot be forced is a number from nothing: with no market read at all there is no
 *     price to build on, and the answer says exactly that.
 *   • CONVICTION IS NOT A WIN RATE. The score is the setup engine's confidence or the read's evidence
 *     balance, named as such. Nothing here claims a probability.
 *
 * Pure: no I/O and no clock except `now`. The same inputs always produce the same idea, which is what lets
 * the replay prove what ATLAS would have said at any moment of a recorded session.
 */
import type { Bar, Level, MarketSnapshot, Side, Timeframe } from "../core/types";
import { PIP, TF_MINUTES } from "../core/types";
import { STYLE, shortfall, type Style } from "../core/style";
import { LEAN_LABEL, levelIdOf, type AtlasRead, type EvidenceRef, type Scenario } from "../core/atlasContract";
import { edgesOfRead, fmtPx, signed } from "../core/read";
import { priceNow } from "../core/priceNow";
import { STRATEGY_LABEL, type BrainSetup, type SetupState } from "./setup";

export const ATLAS_IDEA_VERSION = "idea-2";
/** Versions a stored idea may carry and still be read back: idea-2 only added the forced read. */
export const IDEA_VERSIONS: readonly string[] = ["idea-1", "idea-2"];

export const IDEA_RULES = {
  /** The stop's pad behind a level, in ATR of the style's own timeframe — setup.ts priceTheTrade's multipliers. */
  PAD_ATR: { quick: 0.35, hold: 0.5, swing: 0.75 } as Record<Style, number>,
  /** Plus what it costs to be in the trade: the live spread and a quarter of that ATR for slippage (setup.ts 09-21). */
  FRICTION_ATR: 0.25,
  /** How deep the entry zone runs on the trade side of its level, in ATR. */
  ZONE_ATR: 0.25,
  /** An objective closer than one R is not an objective (setup.ts). */
  MIN_R: 1.0,
  /** Each further objective must be at least this much further out, in R (setup.ts). */
  NEXT_R: 0.6,
  /** A real level closer than this beyond the entry is in the way (setup.ts: "trading straight into it"). */
  OBSTRUCTION_R: 0.6,
  /** In open space, with no real level at a sensible distance: the setup engine's fallback multiples. */
  FALLBACK_R: [1.8, 3.0] as const,
  /** The room must be within this of the style's own band, or the style is refused (setup.ts shortfall rule). */
  MAX_SHORTFALL: 0.45,
  /** A zone may gather neighbouring levels, but never grow wider than this, in ATR. */
  MAX_ZONE_ATR: 1.2,
  /** A level further from price than this, in ATR of the plan's timeframe, is not a plan yet. */
  MAX_DISTANCE_ATR: 6,
  /** How long a plan from the read stays on offer — the scenarios' own horizon (core/scenarios.ts). */
  PLAN_TTL_MS: 4 * 3600_000,
  /** The engine's own rule for a market entry that is still the same trade (setup.ts stillValid). */
  DRIFT_R: 0.6,
  /** Minutes to a high-impact release inside which the idea carries a warning (setup.ts uses 20). */
  NEWS_WARN_MIN: 20,
  /** A forced read's stop when no real structure sits at a usable distance behind the price, in ATR of the style's timeframe. */
  FORCED_STOP_ATR: 1.5,
  /** A market entry's band around the price, in ATR — the setup engine's own entry band (setup.ts). */
  FORCED_BAND_ATR: 0.12,
  /** How long a forced read stays on offer: half a plan's life — it has less behind it. */
  FORCED_TTL_MS: 2 * 3600_000,
  /** …and one made while gold is closed, which waits for the reopen. */
  FORCED_CLOSED_TTL_MS: 72 * 3600_000,
} as const;

/** Which timeframe's ATR sizes a style's stop pad and entry zone. */
const STYLE_TF: Record<Style, Timeframe> = { quick: "5m", hold: "15m", swing: "1h" };
/** When that timeframe has no reading: the nearest one that has, scaled by the square root of time. */
const ATR_FALLBACK: Record<Style, [Timeframe, number][]> = {
  quick: [["1m", 2.2], ["15m", 0.58]],
  hold: [["5m", 1.7], ["1h", 0.5]],
  swing: [["4h", 0.5], ["15m", 2.0]],
};

export const IDEA_STYLE_LABEL: Record<Style, string> = { quick: "Quick", hold: "Intraday", swing: "Swing" };
export const IDEA_STYLE_HINT: Record<Style, string> = {
  quick: "1m · 5m decide. 30–100 pips, minutes.",
  hold: "15m · 1h decide. Held for the session's move, hours.",
  swing: "1h · 4h · daily decide. Sessions to days.",
};

export type IdeaStyleChoice = "auto" | Style;
export type IdeaOptions = { style: IdeaStyleChoice };
export const DEFAULT_IDEA_OPTIONS: IdeaOptions = { style: "auto" };

/** What the request may ask for. Anything else is "ATLAS decides". */
export function ideaOptionsOf(raw: unknown): IdeaOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const st = String(o.style ?? "auto");
  return { style: st === "quick" || st === "hold" || st === "swing" ? st : "auto" };
}

export type IdeaKind = "enter_now" | "on_confirmation" | "at_level" | "on_break" | "stand_aside";
/**
 * setup_engine: the setup engine's own trade. read_plan: a plan at the levels a clear lean stands on.
 * forced_read: neither exists — the side the evidence tilts to, priced anyway because the member asked.
 */
export type IdeaSource = "setup_engine" | "read_plan" | "forced_read";

export type IdeaTarget = {
  label: "TP1" | "TP2" | "TP3";
  price: number;
  /** From the reference entry. */
  pips: number;
  /** Reward over risk, from the reference entry. */
  r: number;
  /** A real level, or (in open space) a multiple of the risk. */
  basis: "level" | "measured";
  what: string;
};

export type IdeaEntry = {
  /** market = enter now; limit = at a level price comes back to; stop = on a break through a level. */
  type: "market" | "limit" | "stop";
  /** The price every pip and R figure on the idea is measured from — the WORST price in the entry zone. */
  price: number;
  low: number;
  high: number;
  /** The level the entry is built on, when it is one. */
  level: { price: number; label: string } | null;
  /** What has to happen first ("A 15-minute close above 4,399.22"), or null when the entry is simply a price. */
  trigger: string | null;
  /** How that is judged: nothing to wait for, price trading through the level, or a 15-minute candle CLOSING through it. */
  confirm: "none" | "touch" | "close_15m";
  /** One plain sentence: where and when to enter. */
  text: string;
  /** How far price is from the entry zone, in pips (0 inside it). */
  distancePips: number;
};

export type AtlasIdea = {
  version: string;
  /** Set when the idea is stored (engines/ideaDesk.ts). */
  id: string | null;
  at: number;
  snapshotAt: number | null;
  snapshotId: number | null;
  options: IdeaOptions;
  kind: IdeaKind;
  source: IdeaSource | null;
  side: Side | null;
  style: Style | null;
  /** The setup engine's strategy, or the plan's own name ("Pullback into the lean"). */
  strategy: string | null;
  headline: string;
  /** The badge: which engine this is and how far along. */
  badge: string;
  /** Gold when the idea was generated (the price the screen shows). */
  price: number | null;
  entry: IdeaEntry | null;
  stop: { price: number; pips: number; what: string } | null;
  targets: IdeaTarget[];
  /** Reward to risk to the first target and to the furthest. */
  rr: { first: number; best: number } | null;
  confidence: { score: number; label: "Low" | "Medium" | "High"; basis: string } | null;
  reasoning: string;
  bias: string | null;
  poi: string | null;
  targeting: string | null;
  invalidation: { text: string; price: number | null } | null;
  confirmations: { label: string; ok: boolean; detail: string | null }[];
  waitingFor: string[];
  /** What the setup engine itself says right now, whatever the idea is. */
  engine: { state: SetupState; headline: string; say: string };
  alternative: string | null;
  /** What would have to happen, on either side, for there to be a trade — the read's own two levels. */
  paths: { side: Side; price: number; direction: "above" | "below"; text: string }[];
  warnings: string[];
  expiresAt: number | null;
  execute: {
    /** take_setup = ATLAS's own trade, recomputed and checked by the server; manual = the member's call, prefilled. */
    via: "take_setup" | "manual" | null;
    /** True when a market entry is valid at the moment the idea was generated. */
    now: boolean;
    note: string;
    approved: { side: Side; style: Style; stop: number; invalidationPrice: number | null } | null;
    manual: { side: Side; style: Style; stop: number; takeProfit: number | null } | null;
  };
  /**
   * ENTER NOW INSTEAD. A forced read whose own entry is a level price has not reached yet also carries the
   * same side entered at the price gold is at — priced by the same rules, the member's call like the rest of
   * it — so there is always something that can be taken now. Absent on every other kind of idea, and when
   * nothing can be entered at all (gold closed, a stale or doubtful read). It is not what gets graded.
   */
  enterNow?: {
    entry: number; low: number; high: number;
    stop: { price: number; pips: number; what: string };
    targets: IdeaTarget[];
    rr: { first: number; best: number };
    /** What the member should know about taking this version (a level in the way, a measured stop). */
    note: string;
    manual: { side: Side; style: Style; stop: number; takeProfit: number | null };
  } | null;
  /** What ATLAS would watch to say "the entry is here". `say` is the instruction the watch engine parses,
   *  so its price is written plainly (4371.77, no thousands separator). */
  watch: { price: number; direction: "above" | "below"; say: string } | null;
  /** The idea in two or three spoken sentences (chat and voice say exactly this). */
  say: string;
};

export type BuildIdeaInput = {
  snapshot: MarketSnapshot | null;
  snapshotId?: number | null;
  /** What the setup engine wants under the member's options (their style choice applied as a filter). */
  setup: BrainSetup;
  /**
   * True when `setup` is exactly what the trade card shows and the server's take-setup path recomputes (the
   * style filter was off, or it did not change the engine's answer). Only then can the idea be taken as
   * ATLAS's own trade; otherwise executing it is the member's call.
   */
  takeable: boolean;
  read: AtlasRead | null;
  scenarios?: Scenario[];
  options?: Partial<IdeaOptions>;
  marketOpen: boolean;
  /** The snapshot is older than the live route allows — no trade is priced from it. */
  stale?: boolean;
  /** The member already has an ATLAS position open. */
  tradeActive?: boolean;
  /** The member's minimum confidence, to explain a trade that is waiting on it. */
  minConfidence?: number;
  /** What the setup engine wants with NO style filter, when the member's style choice changed the answer. */
  enginePick?: BrainSetup | null;
  pipSize?: number;
  now: number;
};

/* ── small pieces ──────────────────────────────────────────────────────────────────────────────────── */

const sgn = (side: Side) => (side === "buy" ? 1 : -1);
const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const cap = (x: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);
const TF_WORD: Record<Timeframe, string> = { "1m": "1-minute", "5m": "5-minute", "15m": "15-minute", "1h": "1-hour", "4h": "4-hour", "1d": "daily" };
const pipsOf = (distance: number, pipSize: number) => Math.round(Math.abs(distance) / pipSize);

type Lv = { price: number; label: string; kind: string };

/** Every real level ATLAS knows, today's session levels first, duplicates within ten cents collapsed. */
export function ideaLevels(s: MarketSnapshot): Lv[] {
  const out: Lv[] = [];
  for (const l of [...s.levels, ...(s.map ?? [])] as Level[]) {
    if (!Number.isFinite(l.price) || l.price <= 0) continue;
    if (!out.some((x) => Math.abs(x.price - l.price) < 0.1)) out.push({ price: r2(l.price), label: l.label, kind: l.kind });
  }
  return out;
}

/** The ATR that sizes this style's pad, and whether it had to be estimated from another timeframe. */
function atrFor(s: MarketSnapshot, style: Style): { atr: number; tf: Timeframe; estimated: boolean } | null {
  const own = s.timeframes[STYLE_TF[style]]?.features.atr;
  if (own != null && own > 0) return { atr: own, tf: STYLE_TF[style], estimated: false };
  for (const [tf, k] of ATR_FALLBACK[style]) {
    const a = s.timeframes[tf]?.features.atr;
    if (a != null && a > 0) return { atr: a * k, tf, estimated: true };
  }
  return null;
}

/** What a price the read names actually is. */
function labelOf(price: number, ref: EvidenceRef | undefined, levels: Lv[], fallback: string): string {
  if (ref?.kind === "level") {
    const lv = levels.find((l) => levelIdOf(l) === ref.levelId) ?? levels.find((l) => Math.abs(l.price - price) < 0.06);
    if (lv) return lv.label;
  }
  if (ref?.kind === "swing") return `the last ${TF_WORD[ref.tf]} swing ${ref.type}`;
  return levels.find((l) => Math.abs(l.price - price) < 0.06)?.label ?? fallback;
}

const confLabel = (n: number): "Low" | "Medium" | "High" => (n >= 75 ? "High" : n >= 55 ? "Medium" : "Low");

/**
 * Targets from a reference entry: real levels at least one R out, each at least 0.6 R beyond the last. When
 * there is no real level at all, the engine's fallback multiples — every one labelled as measured, never
 * mixed with real ones.
 */
function targetsFrom(entry: number, risk: number, side: Side, levels: Lv[], pipSize: number): IdeaTarget[] {
  const d = sgn(side);
  const R = IDEA_RULES;
  const ahead = levels
    .map((l) => ({ ...l, dist: d * (l.price - entry) }))
    .filter((l) => l.dist > 0)
    .sort((a, b) => a.dist - b.dist);
  const picked: typeof ahead = [];
  let floor = R.MIN_R * risk;
  for (const l of ahead) {
    if (picked.length >= 3) break;
    if (l.dist + 1e-9 < floor) continue;
    picked.push(l);
    floor = l.dist + R.NEXT_R * risk;
  }
  const label = (i: number) => (["TP1", "TP2", "TP3"] as const)[i];
  if (picked.length) {
    return picked.map((l, i) => ({
      label: label(i), price: r2(l.price), pips: pipsOf(l.dist, pipSize), r: r1(l.dist / risk), basis: "level" as const, what: l.label,
    }));
  }
  return R.FALLBACK_R.map((k, i) => ({
    label: label(i), price: r2(entry + d * risk * k), pips: pipsOf(risk * k, pipSize), r: k, basis: "measured" as const,
    what: `${k} × the risk — there is no real level out there to aim at`,
  }));
}

const rrOf = (t: IdeaTarget[]) => (t.length ? { first: t[0].r, best: t[t.length - 1].r } : null);

function newsWarning(s: MarketSnapshot): string | null {
  const ev = s.news.nextEvent, m = s.news.minutesToNext;
  if (s.news.inLockout && ev) return `${ev.name} is being released around now — spreads and slippage are at their worst.`;
  if (ev && m != null && m <= IDEA_RULES.NEWS_WARN_MIN && m >= 0) return `${ev.name} is ${Math.round(m)} minute${Math.round(m) === 1 ? "" : "s"} away.`;
  return null;
}

const engineOf = (su: BrainSetup) => ({ state: su.state, headline: su.headline, say: su.say });

/* ── the one answer that is not a trade: there is nothing to read ─────────────────────────────────── */

/**
 * NO MARKET DATA. Since 11-11 the idea never stands aside by choice — a chaotic market, a range or a faint
 * read gets a forced read. What is left is the case where there is no snapshot, or no range reading on any
 * timeframe: no price to build an entry on and nothing to size a stop from. A level invented to fill that
 * gap would be a fabrication, so the answer says what is missing. (The kind is still "stand_aside" for the
 * stored rows and screens that already know it.)
 */
function noData(i: BuildIdeaInput, why: string, waitingFor: string[]): AtlasIdea {
  const s = i.snapshot;
  const options: IdeaOptions = { ...DEFAULT_IDEA_OPTIONS, ...(i.options ?? {}) };
  const waits = waitingFor.filter(Boolean).slice(0, 4);
  return {
    version: ATLAS_IDEA_VERSION, id: null, at: i.now, snapshotAt: s?.at ?? null, snapshotId: i.snapshotId ?? null, options,
    kind: "stand_aside", source: null, side: null, style: null, strategy: null,
    headline: "I can't read gold right now", badge: "NO MARKET DATA",
    price: s ? r2(priceNow(s)) : null, entry: null, stop: null, targets: [], rr: null, confidence: null,
    reasoning: why, bias: null, poi: null, targeting: null, invalidation: null,
    confirmations: [], waitingFor: waits, engine: engineOf(i.setup), alternative: null, paths: [],
    warnings: [], expiresAt: null,
    execute: { via: null, now: false, note: "There is nothing to execute.", approved: null, manual: null },
    watch: null,
    say: `${why}${waits.length ? ` I need ${waits[0].charAt(0).toLowerCase()}${waits[0].slice(1)}.` : ""}`,
  };
}

/* ── tier A: the setup engine's own trade ──────────────────────────────────────────────────────────── */

/** The engine's "Break 4375.08" trigger, when that is what it is waiting for. */
function breakTriggerOf(su: BrainSetup): number | null {
  const c = su.conditions.find((x) => x.trigger && !x.met && /^Break\s+[\d.]+$/.test(x.text));
  if (!c) return null;
  const n = Number(c.text.replace(/^Break\s+/, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fromSetup(i: BuildIdeaInput, s: MarketSnapshot, su: BrainSetup): AtlasIdea | null {
  if (!su.side || !su.style || su.stop == null || su.initialObjective == null) return null;
  if (su.state !== "trade_ready" && su.state !== "waiting_for_trigger") return null;
  const pipSize = i.pipSize ?? PIP;
  const side = su.side, style = su.style, d = sgn(side), up = side === "buy";
  const levels = ideaLevels(s);
  const options: IdeaOptions = { ...DEFAULT_IDEA_OPTIONS, ...(i.options ?? {}) };
  const strategy = su.strategy ? STRATEGY_LABEL[su.strategy] : null;
  const pivot = su.invalidationPrice;
  const read = i.read;
  const lab = STYLE[style].label;
  const warnings = [newsWarning(s), ...s.warnings.slice(0, 2)].filter((x): x is string => !!x);
  if (i.tradeActive) warnings.push("You already have an ATLAS position open — the position limit is checked before another order is sent.");
  if (su.blockedBy) warnings.push(su.blockedBy);

  const base = {
    version: ATLAS_IDEA_VERSION, id: null, at: i.now, snapshotAt: s.at, snapshotId: i.snapshotId ?? null, options,
    source: "setup_engine" as const, side, style, strategy,
    price: r2(priceNow(s)),
    confidence: {
      score: su.confidence, label: confLabel(su.confidence),
      basis: `Setup engine confidence ${su.confidence} of 100, from the evidence and the reward on offer — not a win probability.`,
    },
    bias: read && read.lean !== "insufficient_data" ? `${read.htfTrend.text} ${read.momentum.text}`.trim() : null,
    poi: pivot != null ? `${fmtPx(pivot)} — ${levels.find((l) => Math.abs(l.price - pivot) < 0.06)?.label ?? "the level this trade is built on"}.` : null,
    invalidation: su.invalidation ? { text: su.invalidation, price: pivot } : null,
    confirmations: su.conditions.map((c) => ({ label: c.text, ok: c.met, detail: c.detail })),
    engine: engineOf(su), alternative: null as string | null, paths: [] as AtlasIdea["paths"], warnings,
  };
  const targetingOf = (t: IdeaTarget[]) => (t.length
    ? `${t.map((x) => `${fmtPx(x.price)} (${x.basis === "level" ? x.what : `${x.r}R, measured`})`).join(", then ")}.` : null);
  const approved = { side, style, stop: su.stop, invalidationPrice: su.invalidationPrice };

  /* READY — the idea is the engine's trade, number for number. */
  if (su.state === "trade_ready" && su.entryLow != null && su.entryHigh != null && su.extendedObjective != null) {
    const entry = r2(s.price);                       // what the engine priced it from
    const risk = Math.abs(entry - su.stop);
    if (!(risk > 0)) return null;
    const real = (p: number) => levels.find((l) => Math.abs(l.price - p) < 0.06) ?? null;
    const mk = (label: IdeaTarget["label"], p: number): IdeaTarget => {
      const lv = real(p), dist = Math.abs(p - entry);
      return {
        label, price: r2(p), pips: pipsOf(dist, pipSize), r: r1(dist / risk), basis: lv ? "level" : "measured",
        what: lv ? lv.label : "a multiple of the risk — no real level sits at a sensible distance",
      };
    };
    const targets: IdeaTarget[] = [mk("TP1", su.initialObjective)];
    if (d * (su.extendedObjective - su.initialObjective) > 0.005) targets.push(mk("TP2", su.extendedObjective));
    // A third objective only when a real level sits far enough beyond the engine's last one.
    const last = targets[targets.length - 1];
    const beyond = levels
      .map((l) => ({ ...l, dist: d * (l.price - entry) }))
      .filter((l) => l.dist >= d * (last.price - entry) + IDEA_RULES.NEXT_R * risk)
      .sort((a, b) => a.dist - b.dist)[0];
    if (beyond && targets.length === 2) {
      targets.push({ label: "TP3", price: r2(beyond.price), pips: pipsOf(beyond.dist, pipSize), r: r1(beyond.dist / risk), basis: "level", what: beyond.label });
    }
    const zone = `${fmtPx(su.entryLow)}–${fmtPx(su.entryHigh)}`;
    const via = i.takeable ? "take_setup" as const : "manual" as const;
    return {
      ...base,
      kind: "enter_now",
      headline: `${up ? "BUY" : "SELL"} XAUUSD — enter now`,
      badge: "SETUP ENGINE · TRADE READY",
      entry: {
        type: "market", price: entry, low: su.entryLow, high: su.entryHigh, level: null, trigger: null, confirm: "none",
        text: `Enter at market now, around ${zone}.`, distancePips: 0,
      },
      stop: { price: su.stop, pips: pipsOf(risk, pipSize), what: `Behind the structure this trade depends on, with room for the spread and slippage.` },
      targets, rr: rrOf(targets),
      reasoning: [su.thesis, su.styleWhy].filter(Boolean).join(" "),
      targeting: targetingOf(targets),
      waitingFor: [],
      expiresAt: su.expiresAt,
      execute: {
        via, now: true,
        note: via === "take_setup"
          ? "This is ATLAS's own trade. The server recomputes it from the live market before anything is sent, sizes it from your profile's risk, attaches the stop and the first target, and ATLAS manages it."
          : `ATLAS's own pick right now is a different style, so this one is your call: it opens through the same checks and ATLAS manages it once it is on.`,
        approved: via === "take_setup" ? approved : null,
        manual: { side, style, stop: su.stop, takeProfit: su.initialObjective },
      },
      watch: null,
      say: `${up ? "Buy" : "Sell"} gold now, around ${fmtPx(entry)}. Stop ${fmtPx(su.stop)}, ${pipsOf(risk, pipSize)} pips. First target ${fmtPx(targets[0].price)}, ${targets[0].r} to one. It's ${lab === "HOLD" ? "an intraday" : `a ${lab.toLowerCase()}`} trade and my setup engine has it ready.`,
    };
  }

  /* WAITING — everything but the trigger. Where the entry is depends on which trigger is missing. */
  if (su.state !== "waiting_for_trigger") return null;
  const missing = su.conditions.filter((c) => !c.met);
  const trig = breakTriggerOf(su);

  // (i) a price that has to be traded through first.
  if (trig != null) {
    const risk = Math.abs(trig - su.stop);
    if (!(risk > 0) || d * (trig - su.stop) <= 0) return null;
    const stopPips = pipsOf(risk, pipSize);
    if (stopPips > STYLE[style].maxStopPips) warnings.push(`From the trigger the stop is ${stopPips} pips — wider than ${lab} allows, so ATLAS would want tighter structure by the time it breaks.`);
    const targets = targetsFrom(trig, risk, side, levels, pipSize);
    const distance = pipsOf(Math.max(0, d * (trig - priceNow(s))), pipSize);
    return {
      ...base,
      kind: "on_break",
      headline: `${up ? "BUY" : "SELL"} the break of ${fmtPx(trig)}`,
      badge: "SETUP ENGINE · WAITING FOR TRIGGER",
      entry: {
        type: "stop", price: r2(trig), low: r2(trig), high: r2(trig),
        level: { price: r2(trig), label: levels.find((l) => Math.abs(l.price - trig) < 0.06)?.label ?? "the engine's trigger" },
        trigger: `Gold trading ${up ? "above" : "below"} ${fmtPx(trig)}`, confirm: "touch",
        text: `Not yet. The entry is when gold trades ${up ? "above" : "below"} ${fmtPx(trig)} — ${distance} pips from here. ATLAS re-prices the trade at that moment and flags it TRADE READY.`,
        distancePips: distance,
      },
      stop: { price: su.stop, pips: stopPips, what: "The engine's structural stop, measured from the trigger." },
      targets, rr: rrOf(targets),
      reasoning: [su.thesis, `Everything is in place except the trigger: ${missing.map((m) => m.text.toLowerCase()).join(", ")}.`].filter(Boolean).join(" "),
      targeting: targetingOf(targets),
      waitingFor: missing.map((m) => m.text),
      expiresAt: su.expiresAt,
      execute: { via: null, now: false, note: "Nothing to execute until the trigger breaks. When it does, ATLAS's trade card turns TRADE READY and you take it there.", approved: null, manual: { side, style, stop: su.stop, takeProfit: targets[0]?.price ?? null } },
      watch: { price: r2(trig), direction: up ? "above" : "below", say: `Watch ${trig.toFixed(2)} and tell me if it breaks ${up ? "above" : "below"}.` },
      say: `${up ? "Buy" : "Sell"} the break of ${fmtPx(trig)}, not before — that's ${distance} pips from here. Stop ${fmtPx(su.stop)}${targets[0] ? `, first target ${fmtPx(targets[0].price)}` : ""}. My setup engine has everything but that trigger.`,
    };
  }

  // (ii) price has run too far from the level: the entry is back near it.
  const stretched = missing.find((c) => c.trigger && c.id === "trigger");
  if (stretched && pivot != null && su.entryLow != null && su.entryHigh != null) {
    const band = Math.abs(su.entryHigh - su.entryLow);       // 0.12 × the ATR the engine priced it on
    const atr = band > 0 ? band / 0.12 : 0;
    const far = r2(pivot + d * atr * 1.8);                   // the engine's own "still close to the level" limit
    const risk = Math.abs(far - su.stop);
    if (atr > 0 && risk > 0 && d * (far - su.stop) > 0) {
      const targets = targetsFrom(far, risk, side, levels, pipSize);
      const distance = pipsOf(Math.max(0, d * (priceNow(s) - far)), pipSize);
      return {
        ...base,
        kind: "at_level",
        headline: `${up ? "BUY" : "SELL"} back near ${fmtPx(pivot)}`,
        badge: "SETUP ENGINE · WAITING FOR A BETTER PRICE",
        entry: {
          type: "limit", price: far, low: r2(Math.min(pivot, far)), high: r2(Math.max(pivot, far)),
          level: { price: r2(pivot), label: levels.find((l) => Math.abs(l.price - pivot) < 0.06)?.label ?? "the level this trade is built on" },
          trigger: null, confirm: "none",
          text: `Not here — gold has run ${distance} pips past the zone. The entry is back between ${fmtPx(Math.min(pivot, far))} and ${fmtPx(Math.max(pivot, far))}.`,
          distancePips: distance,
        },
        stop: { price: su.stop, pips: pipsOf(risk, pipSize), what: "The engine's structural stop, measured from the far edge of the zone." },
        targets, rr: rrOf(targets),
        reasoning: [su.thesis, stretched.detail].filter(Boolean).join(" "),
        targeting: targetingOf(targets),
        waitingFor: [`Price back inside ${fmtPx(Math.min(pivot, far))}–${fmtPx(Math.max(pivot, far))}`],
        expiresAt: su.expiresAt,
        execute: { via: null, now: false, note: "Nothing to execute until price comes back to the zone. ATLAS flags it TRADE READY when it does.", approved: null, manual: { side, style, stop: su.stop, takeProfit: targets[0]?.price ?? null } },
        watch: { price: far, direction: up ? "below" : "above", say: `Watch ${far.toFixed(2)} and tell me when price reaches it.` },
        say: `I want to ${up ? "buy" : "sell"}, but not up here. The entry is back between ${fmtPx(Math.min(pivot, far))} and ${fmtPx(Math.max(pivot, far))}, stop ${fmtPx(su.stop)}.`,
      };
    }
  }

  // (iii) every condition is met but the engine is not confident enough to call it ready.
  if (!missing.length && su.entryLow != null && su.entryHigh != null && su.extendedObjective != null) {
    const entry = r2(s.price);
    const risk = Math.abs(entry - su.stop);
    if (!(risk > 0)) return null;
    const targets = targetsFrom(entry, risk, side, levels, pipSize);
    const min = i.minConfidence ?? 55;
    return {
      ...base,
      kind: "on_confirmation",
      headline: `${up ? "BUY" : "SELL"} — not confirmed yet`,
      badge: "SETUP ENGINE · NOT CONFIDENT ENOUGH",
      entry: {
        type: "market", price: entry, low: su.entryLow, high: su.entryHigh, level: null,
        trigger: `ATLAS's confidence reaching ${min}`, confirm: "none",
        text: `The conditions are met, but ATLAS's confidence is ${su.confidence} and it calls a trade ready from ${min}. If it firms up, the entry is at market around ${fmtPx(su.entryLow)}–${fmtPx(su.entryHigh)}.`,
        distancePips: 0,
      },
      stop: { price: su.stop, pips: pipsOf(risk, pipSize), what: "The engine's structural stop." },
      targets, rr: rrOf(targets),
      reasoning: [su.thesis, su.say].filter(Boolean).join(" "),
      targeting: targetingOf(targets),
      waitingFor: [`Confidence of at least ${min} (now ${su.confidence})`],
      expiresAt: su.expiresAt,
      execute: {
        via: "manual", now: true,
        note: "ATLAS has not confirmed this one, so taking it is your call: it opens through the same checks and ATLAS manages it once it is on.",
        approved: null, manual: { side, style, stop: su.stop, takeProfit: targets[0]?.price ?? su.initialObjective },
      },
      watch: null,
      say: `I lean to a ${up ? "buy" : "sell"} around ${fmtPx(entry)} with the stop at ${fmtPx(su.stop)}, but my confidence is ${su.confidence} and I call it ready from ${min}. It's not confirmed.`,
    };
  }
  return null;
}

/* ── tier B: a plan at one of the read's two levels ────────────────────────────────────────────────── */

type PlanMode = "pullback" | "break";
type PlanSpec = { side: Side; mode: PlanMode; level: Lv; invalidation: { text: string; price: number | null } };
type Plan = {
  ok: true; spec: PlanSpec; style: Style; level: Lv; zoneLow: number; zoneHigh: number; entry: number; stop: number; risk: number;
  stopPips: number; targets: IdeaTarget[]; distance: number; inZone: boolean; atr: { atr: number; tf: Timeframe; estimated: boolean }; gathered: string[];
};
type PlanMiss = { ok: false; why: string };

const an = (label: string) => (/^[aeiou]/i.test(label) ? "an" : "a");

/**
 * Price one plan on one style, or say why it cannot be one.
 *
 * The zone starts at the level and runs a quarter of an ATR to the trade side; the stop hides behind the
 * level by the engine's pad; every figure is measured from the WORST price in the zone. Neighbouring levels
 * are gathered into the zone (a pullback) or stepped through (a break) rather than traded straight into.
 */
function pricePlan(s: MarketSnapshot, spec: PlanSpec, style: Style, levels: Lv[], pipSize: number): Plan | PlanMiss {
  const R = IDEA_RULES, pol = STYLE[style], lab = IDEA_STYLE_LABEL[style].toLowerCase();
  const d = sgn(spec.side), up = spec.side === "buy";
  const a = atrFor(s, style);
  if (!a) return { ok: false, why: `I can't measure the ${TF_WORD[STYLE_TF[style]]} range right now, so I can't size a stop for it` };
  const P = priceNow(s);
  const w = R.ZONE_ATR * a.atr;
  const spread = s.spread != null && s.spread > 0 ? s.spread : 0;
  const pad = R.PAD_ATR[style] * a.atr + spread + R.FRICTION_ATR * a.atr;
  const others = levels.filter((l) => Math.abs(l.price - spec.level.price) >= 0.1);

  let anchor = spec.level;          // the level the stop hides behind
  let entry = anchor.price + d * w; // the reference entry: the far edge of the zone from the stop
  const gathered: string[] = [];

  if (spec.mode === "break") {
    // Levels stacked just beyond the trigger are part of the same ceiling: the break is the last of them.
    for (let hop = 0; hop < 3; hop++) {
      const risk = Math.abs(entry - (anchor.price - d * pad));
      const stack = others.filter((l) => d * (l.price - anchor.price) > 0.05 && d * (l.price - entry) < R.OBSTRUCTION_R * risk);
      if (!stack.length) break;
      const last = stack.sort((x, y) => d * (y.price - x.price))[0];
      gathered.push(anchor.label);
      anchor = last;
      entry = anchor.price + d * w;
    }
    if (d * (P - entry) > 0) return { ok: false, why: `gold is already ${up ? "above" : "below"} ${fmtPx(anchor.price)}` };
  } else {
    if (d * (P - anchor.price) < 0) return { ok: false, why: `gold is already ${up ? "below" : "above"} ${fmtPx(anchor.price)} (${anchor.label})` };
    // A level sitting just beyond the entry is not something to trade into — it is part of the zone.
    for (let hop = 0; hop < 3; hop++) {
      const risk = Math.abs(entry - (anchor.price - d * pad));
      const near = others
        .filter((l) => d * (l.price - entry) > 0.005 && d * (l.price - entry) < R.OBSTRUCTION_R * risk && d * (P - l.price) >= 0)
        .sort((x, y) => d * (x.price - y.price))[0];
      if (!near) break;
      if (Math.abs(near.price - anchor.price) > R.MAX_ZONE_ATR * a.atr) {
        return { ok: false, why: `${near.label} at ${fmtPx(near.price)} sits ${pipsOf(near.price - entry, pipSize)} pips beyond the entry — that would be trading straight into it` };
      }
      gathered.push(near.label);
      entry = near.price;
    }
  }

  const stop = anchor.price - d * pad;
  const risk = Math.abs(entry - stop);
  const stopPips = risk / pipSize;
  if (stopPips < pol.noiseFloorPips * 0.5) return { ok: false, why: `the stop it needs is ${Math.round(stopPips)} pips — inside the noise of ${an(lab)} ${lab} trade` };
  if (stopPips > pol.maxStopPips) return { ok: false, why: `the stop it needs is ${Math.round(stopPips)} pips — wider than ${an(lab)} ${lab} trade allows` };

  // Anything real still in the way after gathering?
  const blocker = others
    .filter((l) => d * (l.price - entry) > 0.005 && d * (l.price - entry) < R.OBSTRUCTION_R * risk)
    .sort((x, y) => d * (x.price - y.price))[0];
  if (blocker) {
    return { ok: false, why: `${blocker.label} at ${fmtPx(blocker.price)} is only ${pipsOf(blocker.price - entry, pipSize)} pips beyond the entry and the stop is ${Math.round(stopPips)} — that is trading straight into it` };
  }

  const targets = targetsFrom(entry, risk, spec.side, others, pipSize);
  const room = targets[targets.length - 1].pips;
  if (shortfall(style, room) > R.MAX_SHORTFALL) {
    return { ok: false, why: `there is only about ${room} pips of room before the next real level, against a ${Math.round(stopPips)}-pip stop — that is not ${an(lab)} ${lab} trade` };
  }

  const zoneLow = Math.min(anchor.price, entry), zoneHigh = Math.max(anchor.price, entry);
  const inZone = spec.mode !== "break" && P >= zoneLow - 0.005 && P <= zoneHigh + 0.005;
  const distance = inZone ? 0 : spec.mode === "break" ? Math.max(0, d * (anchor.price - P)) : Math.max(0, d * (P - entry));
  if (distance > R.MAX_DISTANCE_ATR * a.atr) {
    return { ok: false, why: `${fmtPx(anchor.price)} is ${pipsOf(distance, pipSize)} pips away — too far to plan around yet` };
  }
  return {
    ok: true, spec, style, level: anchor, zoneLow: r2(zoneLow), zoneHigh: r2(zoneHigh), entry: r2(entry), stop: r2(stop), risk,
    stopPips: Math.round(stopPips), targets, distance, inZone, atr: a, gathered,
  };
}

/** The read's two levels, named, and the two things that would have to happen for there to be a trade. */
function edgesAndPaths(read: AtlasRead, levels: Lv[]): { S: Lv; Rz: Lv; paths: AtlasIdea["paths"] } | null {
  const e = edgesOfRead(read);
  if (!e.support || !e.resistance || !(e.support.price < e.resistance.price)) return null;
  const S: Lv = { price: r2(e.support.price), label: labelOf(e.support.price, e.support.ref, levels, "support"), kind: "support" };
  const Rz: Lv = { price: r2(e.resistance.price), label: labelOf(e.resistance.price, e.resistance.ref, levels, "resistance"), kind: "resistance" };
  return {
    S, Rz,
    paths: [
      { side: "buy", price: Rz.price, direction: "above", text: `A 15-minute close above ${fmtPx(Rz.price)} (${Rz.label}) — then I'd be looking for buys.` },
      { side: "sell", price: S.price, direction: "below", text: `A 15-minute close below ${fmtPx(S.price)} (${S.label}) — then I'd be looking for sells.` },
    ],
  };
}

/**
 * The plans a lean implies, at its own two levels: the pullback to the level the lean stands on, and the
 * break through the far one (or, once price is already through it, the retest of it).
 */
function specsFor(read: AtlasRead, S: Lv, Rz: Lv, P: number): PlanSpec[] {
  const below = (l: Lv) => `A 15-minute close below ${fmtPx(l.price)} (${l.label})`;
  const above = (l: Lv) => `A 15-minute close above ${fmtPx(l.price)} (${l.label})`;
  if (read.lean === "bullish_lean") {
    return [
      { side: "buy", mode: "pullback", level: S, invalidation: { text: `${below(S)} ends the bullish lean.`, price: S.price } },
      P > Rz.price
        ? { side: "buy", mode: "pullback", level: { ...Rz, label: `${Rz.label}, now support` }, invalidation: { text: `${below(Rz)} puts gold back under the level it broke.`, price: Rz.price } }
        : { side: "buy", mode: "break", level: Rz, invalidation: { text: `${below(S)} ends the bullish lean.`, price: S.price } },
    ];
  }
  if (read.lean === "bearish_lean") {
    return [
      { side: "sell", mode: "pullback", level: Rz, invalidation: { text: `${above(Rz)} ends the bearish lean.`, price: Rz.price } },
      P < S.price
        ? { side: "sell", mode: "pullback", level: { ...S, label: `${S.label}, now resistance` }, invalidation: { text: `${above(S)} puts gold back over the level it broke.`, price: S.price } }
        : { side: "sell", mode: "break", level: S, invalidation: { text: `${above(Rz)} ends the bearish lean.`, price: Rz.price } },
    ];
  }
  return [];
}

const PLAN_NAME: Record<PlanMode, string> = { pullback: "Pullback into the lean", break: "Break with the lean" };

function fromRead(i: BuildIdeaInput, s: MarketSnapshot, read: AtlasRead): AtlasIdea | null {
  const pipSize = i.pipSize ?? PIP;
  const options: IdeaOptions = { ...DEFAULT_IDEA_OPTIONS, ...(i.options ?? {}) };
  const levels = ideaLevels(s);
  const P = priceNow(s);
  const su = i.setup;
  const engineWaits = su.waitingFor.slice(0, 2);
  const edges = edgesAndPaths(read, levels);
  const paths = edges?.paths ?? [];

  /*
   * WHEN THE READ IS NOT A PLAN. A plan needs a lean, and a lean with the evidence that would open it today —
   * not one that merely has not faded far enough to close (core/read.ts holds a lean down to 15 that it would
   * only open at 30). A swing request, a neutral, turning or faint read, or a read with no pair of levels is
   * not this tier's to answer: it returns null and the FORCED READ (below) prices the side the evidence tilts
   * to, labelled as what it is.
   */
  if (options.style === "swing") return null;
  if (!edges) return null;
  const { S, Rz } = edges;
  if (read.lean !== "bullish_lean" && read.lean !== "bearish_lean") return null;
  if (read.strength !== "clear" && read.strength !== "strong") return null;

  // The read's own two levels are real prices too: a plan at one of them may aim at the other.
  for (const e of [S, Rz]) if (!levels.some((l) => Math.abs(l.price - e.price) < 0.1)) levels.push(e);

  /*
   * INTRADAY FIRST, AND NOTHING SMALLER BY DEFAULT. The read is built on 15-minute and 1-hour structure, so
   * its levels get an intraday stop. A five-minute pad behind a fifteen-minute level is a stop inside the
   * noise of the level it is hiding behind; that pairing is priced only when the member asks for Quick.
   */
  const style: Style = options.style === "quick" ? "quick" : "hold";
  const good: Plan[] = [];
  const misses: string[] = [];
  for (const spec of specsFor(read, S, Rz, P)) {
    const p = pricePlan(s, spec, style, levels, pipSize);
    if (p.ok) good.push(p);
    else misses.push(`${spec.side === "buy" ? "Buying" : "Selling"} ${spec.mode === "break" ? "the break of" : "at"} ${fmtPx(spec.level.price)}: ${p.why}`);
  }
  if (!good.length) return null;          // neither level survives the arithmetic: the forced read answers

  // The nearer entry is the idea; the other is the alternative.
  good.sort((a, b) => a.distance - b.distance);
  const p = good[0], other = good[1] ?? null;
  const { spec } = p;
  const side = spec.side, up = side === "buy";
  const zone = `${fmtPx(p.zoneLow)}–${fmtPx(p.zoneHigh)}`;
  const distancePips = pipsOf(p.distance, pipSize);
  const conviction: "Low" | "Medium" | "High" = read.strength === "strong" ? "High" : "Medium";
  const lab = IDEA_STYLE_LABEL[p.style].toLowerCase();

  // The read lists evidence for and against its own lean, and a plan here always trades with the lean.
  const evFor = read.evidenceFor, evAgainst = read.evidenceAgainst;
  const confirmations = [
    ...evFor.slice(0, 5).map((x) => ({ label: x.text, ok: true, detail: null as string | null })),
    ...evAgainst.slice(0, 3).map((x) => ({ label: x.text, ok: false, detail: null as string | null })),
  ];
  const lower = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);

  const triggerText = spec.mode === "break" ? `A 15-minute close ${up ? "above" : "below"} ${fmtPx(p.level.price)}` : null;
  const entryText = spec.mode === "break"
    ? `Not yet. Enter after a 15-minute candle closes ${up ? "above" : "below"} ${fmtPx(p.level.price)} (${p.level.label}) — ${distancePips} pips from here — and only inside ${zone}. If it closes further out than that, wait for the retest.`
    : p.inZone
      ? `Gold is inside the entry zone now: ${zone} (${p.level.label}).`
      : `Not here. The entry is ${zone} (${p.level.label}) — ${distancePips} pips ${up ? "below" : "above"} the price now.`;

  const why = evFor.slice(0, 2).map((x) => lower(x.text)).join("; ");
  const whereWords = spec.mode === "break"
    ? `Gold is pressing ${fmtPx(p.level.price)}${p.gathered.length ? ` (with ${p.gathered.join(" and ")} stacked just under it)` : ""}, so the trade is the break: a 15-minute close ${up ? "above" : "below"} it, with the stop back behind the level at ${fmtPx(p.stop)}.`
    : p.inZone
      ? `Gold is at the level that lean stands on — the entry is here, ${zone}, with the stop behind it at ${fmtPx(p.stop)}.`
      : `Gold is ${distancePips} pips ${up ? "above" : "below"} the level that lean stands on, so I'm not ${up ? "buying" : "selling"} here — the entry is ${zone}, with the stop behind it at ${fmtPx(p.stop)}.`;
  const against = evAgainst[0] ? ` Against it: ${lower(evAgainst[0].text)}.` : "";
  const reasoning = `My intraday lean is ${up ? "up" : "down"} (${read.strength}, evidence ${signed(read.score)} of 100)${why ? `: ${why}` : ""}. ${whereWords}${against}`;

  const altLine = other
    ? `${other.spec.side === "buy" ? "Buy" : "Sell"} ${other.spec.mode === "break" ? `a 15-minute close ${other.spec.side === "buy" ? "above" : "below"} ${fmtPx(other.level.price)}` : `${fmtPx(other.zoneLow)}–${fmtPx(other.zoneHigh)}`} (${other.level.label}), stop ${fmtPx(other.stop)}, first target ${fmtPx(other.targets[0].price)} — ${pipsOf(other.distance, pipSize)} pips from here.`
    : misses[0] ? `${misses[0]}.` : null;

  const warnings = [newsWarning(s), ...s.warnings.slice(0, 2)].filter((x): x is string => !!x);
  if (p.atr.estimated) warnings.push(`The ${TF_WORD[STYLE_TF[p.style]]} range could not be read, so the stop's pad is estimated from the ${TF_WORD[p.atr.tf]} range.`);
  if (p.style === "quick") warnings.push("You asked for Quick: this stop is sized on the five-minute range behind a fifteen-minute level, so ordinary movement around that level can reach it.");
  if (i.tradeActive) warnings.push("You already have an ATLAS position open — the position limit is checked before another order is sent.");
  if (su.state === "watching" || su.state === "setup_developing") warnings.push(`Setup engine: ${su.say}`);

  const sideWord = up ? "BUY" : "SELL";
  const headline = spec.mode === "break" ? `${sideWord} a 15-minute close ${up ? "above" : "below"} ${fmtPx(p.level.price)}` : `${sideWord} the pullback to ${fmtPx(p.level.price)}`;

  return {
    version: ATLAS_IDEA_VERSION, id: null, at: i.now, snapshotAt: s.at, snapshotId: i.snapshotId ?? null, options,
    kind: spec.mode === "break" ? "on_break" : "at_level",
    source: "read_plan", side, style: p.style, strategy: PLAN_NAME[spec.mode],
    headline, badge: "PLAN FROM ATLAS'S READ · NOT AN ENGINE-CONFIRMED TRADE",
    price: r2(P),
    entry: {
      type: spec.mode === "break" ? "stop" : "limit", price: p.entry, low: p.zoneLow, high: p.zoneHigh,
      level: { price: p.level.price, label: p.level.label }, trigger: triggerText, confirm: spec.mode === "break" ? "close_15m" : "none", text: entryText, distancePips,
    },
    stop: {
      price: p.stop, pips: p.stopPips,
      what: `Behind ${fmtPx(p.level.price)} by ${r2(IDEA_RULES.PAD_ATR[p.style] + IDEA_RULES.FRICTION_ATR)} × the ${TF_WORD[p.atr.tf]} ATR${s.spread ? " plus the spread" : ""} — the setup engine's own pad.`,
    },
    targets: p.targets, rr: rrOf(p.targets),
    confidence: {
      score: Math.min(100, Math.abs(Math.round(read.score))), label: conviction,
      basis: `ATLAS's read: ${LEAN_LABEL[read.lean].toLowerCase()}, ${read.strength}, evidence balance ${signed(read.score)} of 100 — how much the evidence agrees, not a win probability.`,
    },
    reasoning,
    bias: `${read.htfTrend.text} ${read.momentum.text}`.trim(),
    poi: `${fmtPx(p.level.price)} — ${p.level.label}${p.gathered.length ? `, with ${p.gathered.join(" and ")} beside it` : ""}.`,
    targeting: `${p.targets.map((x) => `${fmtPx(x.price)} (${x.basis === "level" ? x.what : `${x.r}R, measured`})`).join(", then ")}.`,
    invalidation: { text: `${spec.invalidation.text} The stop is ${fmtPx(p.stop)}.`, price: spec.invalidation.price },
    confirmations,
    waitingFor: [spec.mode === "break" ? `${triggerText}` : p.inZone ? "" : `Price to reach ${zone}`, ...engineWaits].filter(Boolean),
    engine: engineOf(su),
    alternative: altLine,
    paths,
    warnings,
    expiresAt: i.now + IDEA_RULES.PLAN_TTL_MS,
    execute: {
      via: "manual", now: p.inZone,
      note: p.inZone
        ? "Price is in the zone. This is a plan from ATLAS's read, not a trade its setup engine has confirmed, so taking it is your call: it opens through ATLAS's own checks, sized from your risk, and ATLAS manages it once it is on."
        : `Nothing to execute until price is ${spec.mode === "break" ? "through the level on a closed 15-minute candle" : "in the zone"}. Have ATLAS watch it, then press Get update when it gets there.`,
      approved: null,
      manual: { side, style: p.style, stop: p.stop, takeProfit: p.targets[0].price },
    },
    watch: p.inZone ? null : {
      price: spec.mode === "break" ? p.level.price : p.entry,
      direction: spec.mode === "break" ? (up ? "above" : "below") : (up ? "below" : "above"),
      say: spec.mode === "break"
        ? `Watch ${p.level.price.toFixed(2)} and tell me if it breaks ${up ? "above" : "below"}.`
        : `Watch ${p.entry.toFixed(2)} and tell me when price reaches it.`,
    },
    say: spec.mode === "break"
      ? `My plan is to ${up ? "buy" : "sell"} a 15-minute close ${up ? "above" : "below"} ${fmtPx(p.level.price)}, stop ${fmtPx(p.stop)}, first target ${fmtPx(p.targets[0].price)}. It's ${an(lab)} ${lab} plan from my read — my setup engine hasn't confirmed a trade.`
      : `My plan is to ${up ? "buy" : "sell"} ${p.inZone ? "here in" : "the move back to"} ${zone}, stop ${fmtPx(p.stop)}, first target ${fmtPx(p.targets[0].price)}${p.inZone ? "" : ` — that's ${distancePips} pips from here`}. It's ${an(lab)} ${lab} plan from my read — my setup engine hasn't confirmed a trade.`,
  };
}

/* ── tier C: the forced read ───────────────────────────────────────────────────────────────────────── */

/** Blockers that say the DATA cannot be trusted (as opposed to the market being hard to read). */
const DATA_BLOCKERS: readonly string[] = ["no_exec_read", "feed_stale", "feed_divergence", "exec_data_behind", "exec_data_gaps"];

export type ForcedSide = {
  side: Side;
  /** How one-sided the evidence is, 0–100: the read's own balance, or the structure vote when there is no read. */
  score: number;
  /** lean: the read holds a lean. evidence: it holds none, and the balance still tilts. structure: no usable read. */
  from: "lean" | "evidence" | "structure";
  /** The sentence that says why this side, in ATLAS's voice (no full stop). */
  basis: string;
};

/**
 * WHICH SIDE, WHEN A SIDE MUST BE NAMED. The same evidence the read weighs, with the threshold it uses to
 * abstain removed:
 *   1. the read's lean, when it holds one (however faint);
 *   2. otherwise the sign of its evidence balance (core/read.ts `score`) — a range or a turning market still
 *      has more on one side than the other;
 *   3. with no usable read (or a balance of exactly zero), a vote on the structure the snapshot measured:
 *      each timeframe's swing sequence (or its slope), then the pressure proxy; a dead heat is settled by
 *      which side of the daily open price is on, then by the 15-minute RSI.
 * Deterministic, and it says which of the three it used.
 */
export function forcedSide(read: AtlasRead | null, s: MarketSnapshot): ForcedSide {
  if (read && (read.lean === "bullish_lean" || read.lean === "bearish_lean")) {
    const up = read.lean === "bullish_lean";
    return {
      side: up ? "buy" : "sell", score: Math.min(100, Math.abs(Math.round(read.score))), from: "lean",
      basis: `My intraday lean is ${up ? "up" : "down"} (${read.strength ?? "slight"}, evidence ${signed(read.score)} of 100)`,
    };
  }
  if (read && read.lean !== "insufficient_data" && Math.abs(read.score) >= 1) {
    const up = read.score > 0;
    return {
      side: up ? "buy" : "sell", score: Math.min(100, Math.abs(Math.round(read.score))), from: "evidence",
      basis: `My read is ${LEAN_LABEL[read.lean].toLowerCase()} — the evidence is ${signed(read.score)} of 100, short of what I need to call a lean. Made to pick a side, that balance tilts ${up ? "up" : "down"}`,
    };
  }
  const votes: { pts: number; text: string }[] = [];
  const vote = (tf: Timeframe, w: number) => {
    const x = s.timeframes[tf];
    if (!x) return;
    if (x.structure.sequence === "HH_HL") votes.push({ pts: w, text: `the ${TF_WORD[tf]} is making higher highs and higher lows` });
    else if (x.structure.sequence === "LH_LL") votes.push({ pts: -w, text: `the ${TF_WORD[tf]} is making lower highs and lower lows` });
    else if (Number.isFinite(x.features.slope) && Math.abs(x.features.slope) > 0) votes.push({ pts: Math.sign(x.features.slope) * w * 0.5, text: `the ${TF_WORD[tf]} slope is ${x.features.slope > 0 ? "up" : "down"}` });
  };
  vote("4h", 2); vote("1h", 3); vote("15m", 2); vote("5m", 1);
  const net = s.pressure?.net;
  if (net != null && Number.isFinite(net) && Math.abs(net) >= 5) {
    votes.push({ pts: Math.sign(net) * Math.min(2, Math.abs(net) / 15), text: `the pressure proxy is ${signed(Math.round(net))}` });
  }
  let sum = votes.reduce((a, v) => a + v.pts, 0);
  let tie: string | null = null;
  if (Math.abs(sum) < 1e-9) {
    const P = priceNow(s);
    const open = ([...s.levels, ...(s.map ?? [])] as Level[]).find((l) => l.kind === "daily_open");
    const rsi = s.timeframes["15m"]?.features.rsi;
    if (open && Math.abs(P - open.price) >= 0.05) { sum = P > open.price ? 1 : -1; tie = `price is ${P > open.price ? "above" : "below"} the daily open at ${fmtPx(open.price)}`; }
    else if (rsi != null && Number.isFinite(rsi) && Math.abs(rsi - 50) >= 0.5) { sum = rsi > 50 ? 1 : -1; tie = `the 15-minute RSI is ${Math.round(rsi)}`; }
    else { sum = 1; tie = "nothing I can measure separates the two sides, and I default to the long side when that is so"; }
  }
  const up = sum > 0;
  const agree = votes.filter((v) => Math.sign(v.pts) === Math.sign(sum)).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)).slice(0, 2).map((v) => v.text);
  return {
    side: up ? "buy" : "sell", score: Math.min(29, Math.round(Math.abs(sum) * 3)), from: "structure",
    basis: `${read && read.lean !== "insufficient_data" ? "My read is dead even" : "I have no directional read to lean on"}, so I counted the structure I can measure: ${tie ?? agree.join(" and ")}. That tilts ${up ? "up" : "down"}`,
  };
}

/** The timeframes whose measured swings count as structure for a style: a five-minute swing is noise to an intraday stop. */
const SWING_TFS: Record<Style, Timeframe[]> = { quick: ["5m", "15m"], hold: ["15m", "1h"], swing: ["1h", "4h"] };

/** Every real price a forced read may stand on: the levels, the read's own two edges, and the swings measured on the style's own timeframes. */
function forcedLevels(s: MarketSnapshot, edges: { S: Lv; Rz: Lv } | null, base: Lv[], style: Style): Lv[] {
  const out = [...base];
  const add = (price: number | null | undefined, label: string, kind: string) => {
    if (price == null || !Number.isFinite(price) || price <= 0) return;
    if (!out.some((l) => Math.abs(l.price - price) < 0.1)) out.push({ price: r2(price), label, kind });
  };
  if (edges) { add(edges.S.price, edges.S.label, "support"); add(edges.Rz.price, edges.Rz.label, "resistance"); }
  for (const tf of SWING_TFS[style]) {
    const st = s.timeframes[tf]?.structure;
    if (!st) continue;
    add(st.swingHigh, `the last ${TF_WORD[tf]} swing high`, "swing_high");
    add(st.swingLow, `the last ${TF_WORD[tf]} swing low`, "swing_low");
  }
  return out;
}

type MarketPlan = {
  entry: number; stop: number; risk: number; stopPips: number;
  /** structure: behind a real level. measured: a multiple of the range, because no real level sits at a usable distance. */
  stopBasis: "structure" | "measured";
  anchor: Lv | null;
  targets: IdeaTarget[];
  /** A real level close enough ahead that the entry is trading into it. */
  obstruction: Lv | null;
  atr: { atr: number; tf: Timeframe; estimated: boolean };
};

/**
 * Price an entry AT THE PRICE GOLD IS AT, for one style. The stop goes behind the nearest real level that
 * leaves it inside the style's own limits (never tighter than its noise floor, never wider than its ceiling —
 * the same limits the order checks enforce); when no real level does, it is a stated multiple of the range.
 * Targets are real levels at least one R out, or the engine's fallback multiples, labelled as measured.
 */
function priceMarket(s: MarketSnapshot, side: Side, style: Style, levels: Lv[], pipSize: number): MarketPlan | null {
  const R = IDEA_RULES, pol = STYLE[style], d = sgn(side);
  const a = atrFor(s, style);
  if (!a) return null;
  const P = priceNow(s);
  const spread = s.spread != null && s.spread > 0 ? s.spread : 0;
  const pad = R.PAD_ATR[style] * a.atr + spread + R.FRICTION_ATR * a.atr;
  const floor = pol.noiseFloorPips * pipSize, ceil = pol.maxStopPips * pipSize;
  const behind = levels
    .map((l) => ({ l, risk: d * (P - l.price) + pad }))
    .filter((x) => d * (P - x.l.price) > 0.005 && x.risk >= floor && x.risk <= ceil)
    .sort((x, y) => x.risk - y.risk)[0] ?? null;
  const risk = behind ? behind.risk : Math.min(ceil, Math.max(floor, R.FORCED_STOP_ATR * a.atr + spread));
  const stop = P - d * risk;
  const ahead = levels.filter((l) => d * (l.price - P) > 0.005);
  const obstruction = ahead.filter((l) => d * (l.price - P) < R.OBSTRUCTION_R * risk).sort((x, y) => d * (x.price - y.price))[0] ?? null;
  return {
    entry: r2(P), stop: r2(stop), risk, stopPips: Math.round(risk / pipSize), stopBasis: behind ? "structure" : "measured", anchor: behind?.l ?? null,
    targets: targetsFrom(P, risk, side, ahead, pipSize), obstruction, atr: a,
  };
}

type ForcedContext = {
  /** Why the setup engine is standing down (a blocker, or its own blocked state). Null: it simply has no trade. */
  standDown: string | null;
  closed: boolean;
  /** Minutes old, when the market read is too old to enter from. */
  staleMin: number | null;
  /** A data-quality blocker: the price itself is in doubt. */
  dataProblem: string | null;
};

/**
 * THE FORCED READ. The setup engine has no trade and the read has no plan, and the member asked for a
 * direction and a trade anyway — so this prices one, in the open:
 *
 *   • the side is `forcedSide` — the evidence balance with the abstention threshold removed;
 *   • the entry is the soundest one on offer, in this order: price already sitting in the zone of a real
 *     level on the right side (enter now, at the level); otherwise the nearest level-based entry that prices —
 *     the pullback to the real level behind the price, or a 15-minute close through the one ahead — with the
 *     at-market version given beside it; otherwise, when no level prices at all, the price gold is at;
 *   • the stop and targets follow the same arithmetic every other idea uses, inside the style's limits.
 *
 * It never claims more than it has: the badge says FORCED READ, the reasoning opens with why the engine is
 * not trading, the conviction is the evidence balance (usually low), and executing it is the member's call
 * through the manual ticket and its existing checks. With gold closed, or a market read too old or too
 * doubtful to enter from, it still names the side and the levels — from the last clean read, as a plan for
 * when price is real again — and nothing can be sent from it.
 *
 * Null only when no timeframe has a range reading: nothing can size a stop.
 */
function fromForced(i: BuildIdeaInput, s: MarketSnapshot, read: AtlasRead | null, ctx: ForcedContext): AtlasIdea | null {
  const R = IDEA_RULES;
  const pipSize = i.pipSize ?? PIP;
  const options: IdeaOptions = { ...DEFAULT_IDEA_OPTIONS, ...(i.options ?? {}) };
  const su = i.setup;
  const P = priceNow(s);
  const f = forcedSide(read, s);
  const side = f.side, d = sgn(side), up = side === "buy";
  // Intraday unless the member asked for something else: the read and its levels are 15-minute and 1-hour.
  const style: Style = options.style === "auto" ? "hold" : options.style;
  const lab = IDEA_STYLE_LABEL[style].toLowerCase();
  const base = ideaLevels(s);
  const edges = read ? edgesAndPaths(read, base) : null;
  const levels = forcedLevels(s, edges, base, style);
  const canEnter = !ctx.closed && ctx.staleMin == null && !ctx.dataProblem;

  const m = priceMarket(s, side, style, levels, pipSize);
  if (!m) return null;

  /* The conditional entries on this side: the pullback to the nearest real level behind the price (and to the
     read's own edge), and the break through the nearest one ahead (and through the far edge). */
  const behindLv = levels.filter((l) => d * (P - l.price) >= 0).sort((x, y) => d * (y.price - x.price));
  const aheadLv = levels.filter((l) => d * (l.price - P) > 0.005).sort((x, y) => d * (x.price - y.price));
  const edgeBehind = edges ? (up ? edges.S : edges.Rz) : null;
  const edgeAhead = edges ? (up ? edges.Rz : edges.S) : null;
  const closeWord = (l: Lv, dir: "above" | "below") => `A 15-minute close ${dir} ${fmtPx(l.price)} (${l.label})`;
  const specs: PlanSpec[] = [];
  const pushSpec = (mode: PlanMode, level: Lv | null | undefined) => {
    if (!level || specs.some((x) => x.mode === mode && Math.abs(x.level.price - level.price) < 0.1)) return;
    if (mode === "pullback" && d * (P - level.price) < 0) return;
    if (mode === "break" && d * (level.price - P) <= 0.005) return;
    // What undoes it: for a pullback, a close back through the level it leans on; for a break, a close back through the level behind the price.
    const against = mode === "pullback" ? level : (behindLv[0] ?? null);
    specs.push({
      side, mode, level,
      invalidation: against
        ? { text: `${closeWord(against, up ? "below" : "above")} takes away what this ${mode === "break" ? "break" : "entry"} leans on.`, price: against.price }
        : { text: "The stop is the only thing behind this one.", price: null },
    });
  };
  pushSpec("pullback", behindLv[0]); pushSpec("pullback", edgeBehind);
  pushSpec("break", m.obstruction ?? aheadLv[0]); pushSpec("break", edgeAhead);
  const plans = specs.map((sp) => pricePlan(s, sp, style, levels, pipSize)).filter((x): x is Plan => x.ok).sort((a, b) => a.distance - b.distance);
  const inZone = plans.find((x) => x.spec.mode === "pullback" && x.inZone) ?? null;

  /*
   * WHICH ENTRY. A level first. A forced read has little evidence behind its side, so where it is entered is
   * most of what it has: on the one recorded session, the same sides entered at a real level (the zone behind
   * the price, or the close through the one ahead) reached a target before the stop 23 times to 20, and
   * entered at whatever price gold was at, 19 times to 26 — one day, a description and not a track record.
   * So the idea is the nearest level-based entry that prices, and the at-market version is given beside it
   * (`enterNow`) so there is always something that can be taken now. Only when no level prices at all is the
   * entry the price itself.
   */
  type Pick = { type: "plan"; p: Plan } | { type: "market" } | { type: "reference" };
  const pick: Pick = !canEnter ? (plans.length ? { type: "plan", p: plans[0] } : { type: "reference" })
    : inZone ? { type: "plan", p: inZone }
    : plans.length ? { type: "plan", p: plans[0] }
    : { type: "market" };

  /* What every shape shares. */
  const conviction: "Low" | "Medium" | "High" = f.score >= 55 ? "High" : f.score >= 30 ? "Medium" : "Low";
  const lower = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
  const forDir = read ? (read.lean === "bullish_lean" ? 1 : read.lean === "bearish_lean" ? -1 : read.score >= 0 ? 1 : -1) : 0;
  const evFor = !read ? [] : forDir === d ? read.evidenceFor : read.evidenceAgainst;
  const evAgainst = !read ? [] : forDir === d ? read.evidenceAgainst : read.evidenceFor;
  const confirmations = [
    ...evFor.slice(0, 5).map((x) => ({ label: x.text, ok: true, detail: null as string | null })),
    ...evAgainst.slice(0, 3).map((x) => ({ label: x.text, ok: false, detail: null as string | null })),
  ];
  const standDownLine = ctx.closed ? "Gold is closed, so this is a forced read from the last session's prices — a plan for the reopen, not a live entry."
    : ctx.staleMin != null ? `My last market read is ${ctx.staleMin} minutes old, so this is a forced read from that picture — check the price before acting on any of it.`
    : ctx.dataProblem ? `My market data has a problem (${lower(ctx.dataProblem)}), so this is a forced read from the last clean prices — treat every level as approximate.`
    : ctx.standDown ? `My setup engine is standing down (${lower(ctx.standDown).replace(/^i'm standing down:\s*/, "").replace(/\.$/, "")}), so this is a forced read — not a trade it would take on its own.`
    : "My setup engine has no trade here, so this is a forced read — a side and a trade because you asked for one, not one it has confirmed.";
  const against = evAgainst[0] ? ` Against it: ${lower(evAgainst[0].text)}.` : "";
  const warnings: string[] = [];
  const blockerLine = ctx.dataProblem ?? ctx.standDown;
  if (blockerLine && !ctx.closed) warnings.push(`ATLAS's automatic engine is not trading right now: ${lower(blockerLine).replace(/^i'm standing down:\s*/, "").replace(/\.$/, "")}. This idea is forced past that.`);
  for (const w of [newsWarning(s), ...s.warnings.slice(0, 2)]) if (w) warnings.push(w);
  if (conviction === "Low") warnings.push(`Low conviction: the evidence is only ${f.score} of 100 one way. That is a tilt, not an edge.`);
  if (m.atr.estimated) warnings.push(`The ${TF_WORD[STYLE_TF[style]]} range could not be read, so distances are estimated from the ${TF_WORD[m.atr.tf]} range.`);
  if (style === "swing") warnings.push("You asked for Swing: my read of gold is an intraday one, so this is its side with a swing-sized stop — not a swing thesis of its own.");
  if (style === "quick") warnings.push("You asked for Quick: this stop is sized on the five-minute range, so ordinary movement can reach it.");
  if (i.tradeActive) warnings.push("You already have an ATLAS position open — the position limit is checked before another order is sent.");
  const cantSend = ctx.closed ? "Gold is closed — nothing can be sent. Generate again when it reopens."
    : ctx.staleMin != null ? "The market read is too old to send an order from. Generate again when the feed is back."
    : ctx.dataProblem ? "The market data is in doubt, so nothing is sent from it. Generate again when the feed is clean." : null;
  const common = {
    version: ATLAS_IDEA_VERSION, id: null, at: i.now, snapshotAt: s.at, snapshotId: i.snapshotId ?? null, options,
    source: "forced_read" as const, side, style,
    badge: ctx.closed ? "FORCED READ · GOLD IS CLOSED · A PLAN FOR THE REOPEN"
      : !canEnter ? "FORCED READ · FROM THE LAST CLEAN MARKET READ"
      : `FORCED READ · ${conviction.toUpperCase()} CONVICTION · NOT AN ENGINE-CONFIRMED TRADE`,
    price: r2(P),
    confidence: {
      score: f.score, label: conviction,
      basis: f.from === "structure"
        ? `Forced read with no directional read behind it: a count of the structure ATLAS can measure, ${f.score} of 100 one way — how much it agrees, not a win probability.`
        : `Forced read: ATLAS's evidence balance is ${read ? signed(read.score) : f.score} of 100${f.from === "evidence" ? " — below what it needs to call a lean" : ""}. How much the evidence agrees, not a win probability.`,
    },
    bias: read ? `${read.htfTrend.text} ${read.momentum.text}`.trim() : null,
    confirmations,
    engine: engineOf(su),
    paths: edges?.paths ?? [],
    expiresAt: i.now + (ctx.closed ? R.FORCED_CLOSED_TTL_MS : R.FORCED_TTL_MS),
  };
  const sideWord = up ? "BUY" : "SELL", verb = up ? "buy" : "sell";
  const targetingOf = (t: IdeaTarget[]) => `${t.map((x) => `${fmtPx(x.price)} (${x.basis === "level" ? x.what : `${x.r}R, measured`})`).join(", then ")}.`;
  /* The same side entered at the price gold is at: the idea itself when no level prices, and otherwise the
     "enter now instead" beside a level entry that has not been reached. */
  const band = R.FORCED_BAND_ATR * m.atr.atr;
  const stopWhat = m.stopBasis === "structure" && m.anchor
    ? `Behind ${m.anchor.label} at ${fmtPx(m.anchor.price)}, by the setup engine's own pad${s.spread ? " plus the spread" : ""}.`
    : `Measured: ${R.FORCED_STOP_ATR} × the ${TF_WORD[m.atr.tf]} range, held inside what ${an(lab)} ${lab} trade allows — no real level sits at a usable distance behind the price.`;
  const enterNow: NonNullable<AtlasIdea["enterNow"]> | null = canEnter ? {
    entry: m.entry, low: r2(P - band), high: r2(P + band),
    stop: { price: m.stop, pips: m.stopPips, what: stopWhat },
    targets: m.targets, rr: rrOf(m.targets) ?? { first: 0, best: 0 },
    note: `${m.obstruction ? `${cap(m.obstruction.label)} at ${fmtPx(m.obstruction.price)} is only ${pipsOf(m.obstruction.price - P, pipSize)} pips ${up ? "above" : "below"} the price — expect a reaction there. ` : ""}${m.stopBasis === "measured" ? "The stop is a measured distance, not behind a real level. " : ""}Same side, entered at the price instead of at the level: you are in now, at a worse location.`,
    manual: { side, style, stop: m.stop, takeProfit: m.targets[0].price },
  } : null;
  const otherLevel = (x: Plan | null) => (x
    ? `${cap(verb)} ${x.spec.mode === "break" ? `a 15-minute close ${up ? "above" : "below"} ${fmtPx(x.level.price)}` : `${fmtPx(x.zoneLow)}–${fmtPx(x.zoneHigh)}`} (${x.level.label}), stop ${fmtPx(x.stop)}, first target ${fmtPx(x.targets[0].price)} — ${pipsOf(x.distance, pipSize)} pips from here.`
    : null);

  /* ── a level-based entry: in the zone now, the pullback, or the break ── */
  if (pick.type === "plan") {
    const p = pick.p, spec = p.spec;
    const zone = `${fmtPx(p.zoneLow)}–${fmtPx(p.zoneHigh)}`;
    const distancePips = pipsOf(p.distance, pipSize);
    const isBreak = spec.mode === "break";
    const live = canEnter && p.inZone;
    const triggerText = isBreak ? `A 15-minute close ${up ? "above" : "below"} ${fmtPx(p.level.price)}` : null;
    const entryText = isBreak
      ? `${cap(verb)} after a 15-minute candle closes ${up ? "above" : "below"} ${fmtPx(p.level.price)} (${p.level.label}) — ${distancePips} pips from here — and only inside ${zone}. If it closes further out than that, wait for the retest.`
      : live ? `Gold is inside the entry zone now: ${zone} (${p.level.label}).`
      : p.inZone ? `The entry zone is ${zone} (${p.level.label}).`
      : `${cap(verb)} at ${zone} (${p.level.label}) — ${distancePips} pips ${up ? "below" : "above"} the price now.`;
    const where = isBreak
      ? `${cap(p.level.label)} at ${fmtPx(p.level.price)} is the level in front of the price, ${distancePips} pips ${up ? "above" : "below"}, so the trade is the break: a 15-minute close ${up ? "above" : "below"} it, with the stop back behind the level at ${fmtPx(p.stop)}.`
      : p.inZone ? `Gold is at ${p.level.label} (${fmtPx(p.level.price)}), the nearest real level on that side — the entry is ${zone}, with the stop behind it at ${fmtPx(p.stop)}.`
      : `The nearest real level to lean on is ${p.level.label} at ${fmtPx(p.level.price)}, ${distancePips} pips ${up ? "below" : "above"} — the entry is ${zone}, with the stop behind it at ${fmtPx(p.stop)}.`;
    const waits = isBreak ? `${triggerText}` : live ? "" : cantSend ? (ctx.closed ? "The market to reopen" : "A clean, current market read") : `Price to reach ${zone}`;
    return {
      ...common,
      kind: isBreak ? "on_break" : "at_level",
      strategy: isBreak ? "Forced read — the break" : "Forced read — at the level",
      headline: isBreak ? `${sideWord} a 15-minute close ${up ? "above" : "below"} ${fmtPx(p.level.price)}` : live ? `${sideWord} XAUUSD — at ${fmtPx(p.level.price)} now` : `${sideWord} the pullback to ${fmtPx(p.level.price)}`,
      entry: {
        type: isBreak ? "stop" : "limit", price: p.entry, low: p.zoneLow, high: p.zoneHigh, level: { price: p.level.price, label: p.level.label },
        trigger: triggerText, confirm: isBreak ? "close_15m" : "none", text: entryText, distancePips,
      },
      stop: { price: p.stop, pips: p.stopPips, what: `Behind ${fmtPx(p.level.price)} by ${r2(R.PAD_ATR[p.style] + R.FRICTION_ATR)} × the ${TF_WORD[p.atr.tf]} ATR${s.spread ? " plus the spread" : ""} — the setup engine's own pad.` },
      targets: p.targets, rr: rrOf(p.targets),
      reasoning: `${standDownLine} ${f.basis}. ${where}${against}`,
      poi: `${fmtPx(p.level.price)} — ${p.level.label}${p.gathered.length ? `, with ${p.gathered.join(" and ")} beside it` : ""}.`,
      targeting: targetingOf(p.targets),
      invalidation: { text: `${spec.invalidation.text} The stop is ${fmtPx(p.stop)}.`, price: spec.invalidation.price },
      waitingFor: [waits].filter(Boolean),
      alternative: otherLevel(plans.find((x) => x !== p) ?? null),
      enterNow: live ? null : enterNow,
      warnings,
      execute: {
        via: cantSend ? null : "manual", now: live,
        note: cantSend ?? (live
          ? "Price is in the zone. This is a forced read, not a trade ATLAS's setup engine has confirmed, so taking it is your call: it opens through ATLAS's own order checks, sized from your risk, and ATLAS manages it once it is on."
          : `Nothing to execute until price is ${isBreak ? "through the level on a closed 15-minute candle" : "in the zone"}. Have ATLAS watch it, then press Get update when it gets there.`),
        approved: null, manual: { side, style: p.style, stop: p.stop, takeProfit: p.targets[0].price },
      },
      watch: live || cantSend ? null : {
        price: isBreak ? p.level.price : p.entry,
        direction: isBreak ? (up ? "above" : "below") : (up ? "below" : "above"),
        say: isBreak ? `Watch ${p.level.price.toFixed(2)} and tell me if it breaks ${up ? "above" : "below"}.` : `Watch ${p.entry.toFixed(2)} and tell me when price reaches it.`,
      },
      say: isBreak
        ? `Made to pick, I'd ${verb} a 15-minute close ${up ? "above" : "below"} ${fmtPx(p.level.price)}, stop ${fmtPx(p.stop)}, first target ${fmtPx(p.targets[0].price)}. It's a forced read — ${conviction.toLowerCase()} conviction, and my setup engine hasn't confirmed it.`
        : `Made to pick, I'd ${verb} ${live ? "here in" : "the move back to"} ${zone}, stop ${fmtPx(p.stop)}, first target ${fmtPx(p.targets[0].price)}. It's a forced read — ${conviction.toLowerCase()} conviction, and my setup engine hasn't confirmed it.`,
    };
  }

  /* ── at the price gold is at (or, when nothing can be entered, the same numbers as a plan for later) ── */
  const whereStop = m.stopBasis === "structure" && m.anchor
    ? `with the stop behind ${m.anchor.label} at ${fmtPx(m.stop)} (${m.stopPips} pips)`
    : `with a measured stop at ${fmtPx(m.stop)} (${m.stopPips} pips) — there is no real level at a usable distance behind the price to hide it behind`;
  const obstructed = m.obstruction ? ` ${cap(m.obstruction.label)} at ${fmtPx(m.obstruction.price)} is only ${pipsOf(m.obstruction.price - P, pipSize)} pips ${up ? "above" : "below"} — expect a reaction there before the first target.` : "";
  if (m.obstruction) warnings.push(`${cap(m.obstruction.label)} at ${fmtPx(m.obstruction.price)} sits between the entry and the first target.`);
  const measuredTargets = m.targets.every((t) => t.basis === "measured");
  if (measuredTargets) warnings.push("There is no real level to aim at on this side, so the targets are multiples of the risk.");
  const manual = { side, style, stop: m.stop, takeProfit: m.targets[0].price };

  if (pick.type === "market") {
    return {
      ...common,
      kind: "enter_now",
      strategy: "Forced read — at market",
      headline: `${sideWord} XAUUSD — enter now`,
      entry: {
        type: "market", price: m.entry, low: r2(P - band), high: r2(P + band), level: null, trigger: null, confirm: "none",
        text: `Enter at market now, around ${fmtPx(P - band)}–${fmtPx(P + band)}.`, distancePips: 0,
      },
      stop: { price: m.stop, pips: m.stopPips, what: stopWhat },
      targets: m.targets, rr: rrOf(m.targets),
      reasoning: `${standDownLine} ${f.basis}. The entry is at market around ${fmtPx(P)}, ${whereStop}.${obstructed}${against}`,
      poi: m.anchor ? `${fmtPx(m.anchor.price)} — ${m.anchor.label}, the level the stop hides behind.` : null,
      targeting: targetingOf(m.targets),
      invalidation: {
        text: `The stop at ${fmtPx(m.stop)}.${edges ? ` ${closeWord(up ? edges.S : edges.Rz, up ? "below" : "above")} would put the evidence on the other side.` : " There is no confirmed structure behind a forced read — only the stop."}`,
        price: m.stop,
      },
      waitingFor: [],
      alternative: plans[0] ? `For a better price: ${lower(otherLevel(plans[0]) ?? "")}` : null,
      enterNow: null,
      warnings,
      execute: {
        via: "manual", now: true,
        note: "This is a forced read, not a trade ATLAS's setup engine has confirmed, so taking it is your call: it opens through ATLAS's own order checks, sized from your risk, and ATLAS manages it once it is on.",
        approved: null, manual,
      },
      watch: null,
      say: `Made to pick, I'd ${verb} gold here, around ${fmtPx(m.entry)}. Stop ${fmtPx(m.stop)}, ${m.stopPips} pips. First target ${fmtPx(m.targets[0].price)}, ${m.targets[0].r} to one. It's a forced read — ${conviction.toLowerCase()} conviction, and my setup engine hasn't confirmed it.`,
    };
  }

  // Nothing can be entered (closed, stale or doubtful data) and no level-based plan priced: the same numbers,
  // as a zone around the last price, for when price is real again.
  const zLow = r2(P - R.ZONE_ATR * m.atr.atr), zHigh = r2(P + R.ZONE_ATR * m.atr.atr);
  const ref = up ? zHigh : zLow;                       // the worst price in the zone
  const refRisk = Math.abs(ref - m.stop);
  const refTargets = targetsFrom(ref, refRisk, side, levels.filter((l) => d * (l.price - ref) > 0.005), pipSize);
  return {
    ...common,
    kind: "at_level",
    strategy: "Forced read — from the last price",
    headline: ctx.closed ? `${sideWord} XAUUSD — when gold reopens near ${fmtPx(P)}` : `${sideWord} XAUUSD — near ${fmtPx(P)}, once the read is current`,
    entry: {
      type: "limit", price: ref, low: zLow, high: zHigh, level: null, trigger: ctx.closed ? "Gold reopening inside the zone" : "A current market read with price inside the zone", confirm: "none",
      text: ctx.closed
        ? `Gold is closed. If it reopens inside ${fmtPx(zLow)}–${fmtPx(zHigh)}, that is the entry; a gap beyond it changes the picture — generate again.`
        : `These levels are from my last clean read. If price is still inside ${fmtPx(zLow)}–${fmtPx(zHigh)} once the read is current, that is the entry — generate again to confirm it.`,
      distancePips: 0,
    },
    stop: { price: m.stop, pips: pipsOf(refRisk, pipSize), what: stopWhat },
    targets: refTargets, rr: rrOf(refTargets),
    reasoning: `${standDownLine} ${f.basis}. From the last price, ${fmtPx(P)}, the entry zone is ${fmtPx(zLow)}–${fmtPx(zHigh)}, ${whereStop}.${against}`,
    poi: m.anchor ? `${fmtPx(m.anchor.price)} — ${m.anchor.label}, the level the stop hides behind.` : null,
    targeting: targetingOf(refTargets),
    invalidation: { text: `The stop at ${fmtPx(m.stop)}. ${ctx.closed ? "A reopen beyond the zone" : "A current price beyond the zone"} means this was priced for a market that is no longer there.`, price: m.stop },
    waitingFor: [ctx.closed ? "The market to reopen" : "A clean, current market read"],
    alternative: null,
    warnings,
    execute: { via: null, now: false, note: cantSend ?? "Nothing can be sent from this read.", approved: null, manual: { ...manual, takeProfit: refTargets[0].price } },
    watch: null,
    say: `Made to pick, I'd be a ${up ? "buyer" : "seller"} around ${fmtPx(P)} with the stop at ${fmtPx(m.stop)} and a first target of ${fmtPx(refTargets[0].price)} — but ${ctx.closed ? "gold is closed, so that is a plan for the reopen" : "that is from my last clean read, so check the price first"}.`,
  };
}

/* ── the idea ──────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Generate ATLAS's trade idea from one market state. It ALWAYS names a side and a trade when there is a
 * market read to build on (owner 11-11).
 *
 * Order: the setup engine's trade when it has one ready or waiting only on its trigger; otherwise a plan at
 * one of the levels a clear lean stands on; otherwise — the engine blocked or standing down, a range, a
 * turning or faint read, gold closed, a stale or doubtful read — the FORCED READ, labelled as one. Only a
 * missing market read (or no range reading at all) produces no trade.
 */
export function buildIdea(i: BuildIdeaInput): AtlasIdea {
  const idea = buildIdeaInner(i);
  const pick = i.enginePick;
  if (pick?.side && pick.style && (pick.state === "trade_ready" || pick.state === "waiting_for_trigger") && pick.style !== idea.style) {
    const lab = IDEA_STYLE_LABEL[pick.style].toLowerCase();
    idea.warnings = [...idea.warnings, `With no style filter, ATLAS's setup engine is on ${/^[aeiou]/.test(lab) ? "an" : "a"} ${lab} ${pick.side} (${pick.headline.toLowerCase()}). Choose "ATLAS decides" to see it.`];
  }
  return idea;
}

function buildIdeaInner(i: BuildIdeaInput): AtlasIdea {
  const s = i.snapshot;
  const su = i.setup;
  if (!s) return noData(i, "I can't see gold right now — there is no market read to build a trade on, and I won't invent a price.", ["a market read"]);

  const dataProblem = s.blockers.find((b) => DATA_BLOCKERS.includes(b.code)) ?? null;
  const closed = !i.marketOpen || s.blockers.some((b) => b.code === "market_closed");
  const staleMin = i.stale ? Math.max(1, Math.round((i.now - s.at) / 60_000)) : null;
  const read = i.read && i.read.lean !== "insufficient_data" ? i.read : null;

  // The engine's own trade, then a plan from a clear lean — only from a market that can be entered and that
  // the engine itself is willing to trade.
  if (!closed && staleMin == null && !s.blockers.length && su.state !== "blocked") {
    const engine = fromSetup(i, s, su);
    if (engine) return engine;
    const plan = read ? fromRead(i, s, read) : null;
    if (plan) return plan;
  }

  const hard = s.blockers.find((b) => b.code !== "market_closed" && !DATA_BLOCKERS.includes(b.code)) ?? null;
  const forced = fromForced(i, s, read, {
    standDown: hard?.detail ?? (su.state === "blocked" ? su.say : null),
    closed, staleMin, dataProblem: dataProblem?.detail ?? null,
  });
  return forced ?? noData(i, "I can't measure gold's range on any timeframe right now, so there is nothing to size a stop from — and I won't invent one.", ["a range reading"]);
}

/* ── following an idea: where it stands now, and how it turned out ─────────────────────────────────── */

export type IdeaState =
  | "ready"          // a market entry is valid right now
  | "waiting"        // the entry has not been reached or confirmed
  | "in_zone"        // price is inside the entry zone now
  | "open"           // entered (on the candles), neither the stop nor a target reached yet
  | "tp1" | "tp2" | "tp3"
  | "stopped"
  | "invalidated"    // what the idea depended on failed before it was entered
  | "expired"        // it was never entered within its life
  | "missed"         // the entry has gone: price moved away or the move already happened
  | "none";          // nothing to follow

export type IdeaFollow = {
  at: number;
  state: IdeaState;
  /** Where it stands, in a sentence or two. */
  text: string;
  /** When and where the idea was entered, on the candles. Null while it has not been. */
  entered: { at: number; price: number } | null;
  /** The furthest target reached after the entry and before the stop. */
  reached: 0 | 1 | 2 | 3;
  stopped: boolean;
  /** The graded result in pips: the furthest target reached, or minus the stop. Null while undecided. */
  pips: number | null;
  /** Where price is now against the entry, in pips, once entered. */
  nowPips: number | null;
  /** A market entry is valid at this moment. */
  canExecute: boolean;
  /** What the result was graded on. */
  basis: string;
};

export type FollowInput = {
  /** The freshest price, or null when there is none. */
  price: number | null;
  /** Candles of one timeframe, oldest first. Only candles that OPENED at or after the idea are read. */
  bars: Bar[];
  tf: Timeframe;
  now: number;
  pipSize?: number;
  /**
   * ATLAS's lean over the idea's life, oldest first (one entry each time it changed). A plan from the read
   * is conditional on that read: if the lean was no longer the plan's by the time price reached the entry,
   * the plan was off, and it is graded as cancelled rather than as a trade.
   */
  leans?: { at: number; lean: string }[];
};

/**
 * Follow one idea on real candles.
 *
 * Grading is deliberately conservative and says how it was done: the candle that was forming when the idea
 * was generated is not read at all; in the candle that enters the trade only the stop is checked (its high
 * and low cannot be ordered); and when a later candle spans both the stop and a target, the stop counts.
 * A break needs a 15-minute candle to CLOSE through its level — the same rule the scenario cards use.
 */
export function followIdea(idea: AtlasIdea, f: FollowInput): IdeaFollow {
  const pipSize = f.pipSize ?? PIP;
  const none = (state: IdeaState, text: string, extra: Partial<IdeaFollow> = {}): IdeaFollow => ({
    at: f.now, state, text, entered: null, reached: 0, stopped: false, pips: null, nowPips: null, canExecute: false, basis: "", ...extra,
  });
  if (idea.kind === "stand_aside" || !idea.side || !idea.entry || !idea.stop) return none("none", "There was no trade in this idea to follow.");

  const side = idea.side, d = sgn(side), up = side === "buy";
  const E = idea.entry.price, stop = idea.stop.price, risk = Math.abs(E - stop);
  const span = TF_MINUTES[f.tf] * 60_000;
  const bars = f.bars.filter((b) => b && Number.isFinite(b.t) && b.t >= idea.at && b.t + span <= f.now).sort((a, b) => a.t - b.t);
  const basis = bars.length
    ? `Graded on ${bars.length} closed ${TF_WORD[f.tf]} candle${bars.length === 1 ? "" : "s"} since ${new Date(idea.at).toISOString().slice(11, 16)} UTC — the idea's levels against real prices, not a fill.`
    : `No ${TF_WORD[f.tf]} candle has closed since the idea was generated.`;
  const expired = idea.expiresAt != null && f.now > idea.expiresAt;
  const P = f.price;

  if (idea.kind === "on_confirmation") {
    return none(expired ? "expired" : "waiting",
      expired ? "ATLAS never confirmed this one before it expired." : "This idea is waiting on ATLAS's own confirmation, so there is no entry to grade yet.", { basis });
  }

  /* 1 — when, on the candles, was it entered? */
  let entered: { at: number; price: number; index: number } | null = null;
  let invalidated: string | null = null;
  if (idea.kind === "enter_now") {
    entered = { at: idea.at, price: E, index: -1 };
  } else if (idea.kind === "at_level") {
    for (let k = 0; k < bars.length; k++) {
      const b = bars[k];
      if (idea.expiresAt != null && b.t > idea.expiresAt) break;
      if (up ? b.l <= E : b.h >= E) { entered = { at: b.t, price: E, index: k }; break; }
    }
  } else if (idea.entry.confirm === "touch") {
    // The setup engine's own trigger: price trading through it is the entry.
    for (let k = 0; k < bars.length; k++) {
      const b = bars[k];
      if (idea.expiresAt != null && b.t > idea.expiresAt) break;
      if (up ? b.h >= E : b.l <= E) { entered = { at: b.t, price: E, index: k }; break; }
    }
  } else {
    // on_break: a closed 15-minute candle through the level, then a price inside the zone.
    const level = idea.entry.level?.price ?? E;
    const inv = idea.invalidation?.price ?? null;
    const closes15 = f.tf === "5m"
      ? bars.filter((b) => (b.t + span) % (15 * 60_000) === 0)
      : bars;
    let confirmedAt: number | null = null, confirmedIdx = -1;
    for (const b of closes15) {
      if (idea.expiresAt != null && b.t > idea.expiresAt) break;
      if (inv != null && (up ? b.c < inv : b.c > inv)) { invalidated = `A ${f.tf === "5m" ? "15-minute" : TF_WORD[f.tf]} candle closed ${up ? "below" : "above"} ${fmtPx(inv)} before the break came.`; break; }
      if (up ? b.c > level : b.c < level) {
        confirmedAt = b.t + span; confirmedIdx = bars.indexOf(b);
        if (up ? b.c <= E : b.c >= E) entered = { at: confirmedAt, price: r2(b.c), index: confirmedIdx };
        break;
      }
    }
    if (confirmedAt != null && !entered) {
      for (let k = confirmedIdx + 1; k < bars.length; k++) {
        const b = bars[k];
        if (up ? b.l <= E : b.h >= E) { entered = { at: b.t, price: E, index: k }; break; }
      }
      if (!entered) {
        return none(expired ? "expired" : "waiting",
          `The break is confirmed — a candle closed ${up ? "above" : "below"} ${fmtPx(level)} — but beyond the entry zone. The entry is the retest of ${fmtPx(idea.entry.low)}–${fmtPx(idea.entry.high)}.`, { basis });
      }
    }
  }

  // A plan from the read only stands while the read does.
  const leanAt = (t: number): string | null => {
    let cur: string | null = null;
    for (const l of f.leans ?? []) { if (l.at <= t) cur = l.lean; else break; }
    return cur;
  };
  const wantLean = up ? "bullish_lean" : "bearish_lean";
  const leanWord = (l: string) => l.replace(/_/g, " ");
  if (idea.source === "read_plan" && f.leans?.length) {
    const then = leanAt(entered ? entered.at : f.now);
    if (then && then !== wantLean) {
      return none("invalidated", entered
        ? `Price reached the entry at ${new Date(entered.at).toISOString().slice(11, 16)} UTC, but by then ATLAS's read had changed to ${leanWord(then)} — the plan was already off, so it is not counted as a trade.`
        : `ATLAS's read has changed to ${leanWord(then)} since this plan was made. It is off.`, { basis });
    }
  }

  if (!entered) {
    if (invalidated) return none("invalidated", `${invalidated} The idea is off.`, { basis });
    if (expired) return none("expired", `Price never ${idea.kind === "on_break" ? "broke the level" : "came back to the zone"} while the idea was live.`, { basis });
    // Not entered on closed candles: say where price is against the zone now.
    if (P != null && idea.kind === "at_level" && P >= idea.entry.low - 0.005 && P <= idea.entry.high + 0.005) {
      return none("in_zone", `Gold is inside the entry zone now (${fmtPx(idea.entry.low)}–${fmtPx(idea.entry.high)}).`, { basis, canExecute: true });
    }
    if (P != null && idea.kind === "at_level" && d * (stop - P) > 0) return none("invalidated", `Gold is already through the stop level at ${fmtPx(stop)}. The idea is off.`, { basis });
    const dist = P != null ? pipsOf(idea.kind === "on_break" ? (idea.entry.level?.price ?? E) - P : P - E, pipSize) : null;
    return none("waiting", idea.kind === "on_break"
      ? `Still waiting for ${idea.entry.trigger?.toLowerCase() ?? "the break"}${dist != null ? ` — gold is ${dist} pips from the level` : ""}.`
      : `Still waiting for price to reach ${fmtPx(idea.entry.low)}–${fmtPx(idea.entry.high)}${dist != null ? ` — ${dist} pips away` : ""}.`, { basis });
  }

  /* 2 — after the entry: the stop, or how far it got. */
  let reached: 0 | 1 | 2 | 3 = 0;
  let stopped = false;
  const tps = idea.targets.map((t) => t.price);
  for (let k = Math.max(0, entered.index); k < bars.length; k++) {
    const b = bars[k];
    const hitStop = up ? b.l <= stop : b.h >= stop;
    if (k === entered.index) { if (hitStop) { stopped = true; break; } continue; }   // entry candle: stop only
    if (hitStop) { stopped = true; break; }
    for (let t = reached; t < tps.length; t++) {
      if (up ? b.h >= tps[t] : b.l <= tps[t]) reached = (t + 1) as 1 | 2 | 3; else break;
    }
    if (reached >= tps.length) break;
  }
  // The live price can settle what the closed candles have not yet.
  if (!stopped && P != null) {
    if (d * (stop - P) >= 0 && reached === 0) stopped = true;
    for (let t = reached; t < tps.length; t++) { if (d * (P - tps[t]) >= 0) reached = (t + 1) as 1 | 2 | 3; else break; }
  }
  const nowPips = P != null ? Math.round((d * (P - entered.price)) / pipSize) : null;
  const ent = { at: entered.at, price: entered.price };
  const stopPips = pipsOf(entered.price - stop, pipSize);

  if (reached > 0) {
    const t = idea.targets[reached - 1];
    const pips = pipsOf(t.price - entered.price, pipSize);
    return {
      at: f.now, state: (`tp${reached}`) as IdeaState, entered: ent, reached, stopped, pips, nowPips, canExecute: false, basis,
      text: `${t.label} at ${fmtPx(t.price)} was reached — +${pips} pips from the entry at ${fmtPx(entered.price)}${stopped ? "; price later came back to the stop" : reached < idea.targets.length ? `; ${idea.targets[reached].label} at ${fmtPx(idea.targets[reached].price)} is still open` : ""}.`,
    };
  }
  if (stopped) {
    return {
      at: f.now, state: "stopped", entered: ent, reached: 0, stopped: true, pips: -stopPips, nowPips, canExecute: false, basis,
      text: `Stopped at ${fmtPx(stop)} before the first target — −${stopPips} pips from the entry at ${fmtPx(entered.price)}.`,
    };
  }

  // Entered, undecided. Can it still be taken at market?
  const drift = P != null ? Math.abs(P - entered.price) : 0;
  const stillThere = P != null && !expired && drift <= IDEA_RULES.DRIFT_R * risk && d * (P - stop) > 0.3 * risk;
  if (idea.kind === "enter_now" && bars.length === 0 && P != null) {
    return {
      at: f.now, state: stillThere ? "ready" : expired ? "expired" : "missed", entered: null, reached: 0, stopped: false, pips: null, nowPips: null, canExecute: stillThere, basis,
      text: stillThere ? `Still valid: gold is ${pipsOf(drift, pipSize)} pips from where the idea was priced.`
        : expired ? "This idea has been sitting too long — generate a fresh one."
        : `Gold has moved ${pipsOf(drift, pipSize)} pips since this was priced. The entry isn't there any more — generate a fresh one.`,
    };
  }
  return {
    at: f.now, state: "open", entered: ent, reached: 0, stopped: false, pips: null, nowPips, canExecute: stillThere, basis,
    text: `${idea.kind === "enter_now" ? `Priced at ${fmtPx(entered.price)} when it was generated` : `Entered at ${fmtPx(entered.price)} on the candles`}; neither the stop at ${fmtPx(stop)} nor ${idea.targets[0]?.label ?? "a target"}${idea.targets[0] ? ` at ${fmtPx(idea.targets[0].price)}` : ""} has been reached${nowPips != null ? ` — gold is ${nowPips >= 0 ? "+" : ""}${nowPips} pips from the entry` : ""}.${stillThere ? " The entry is still there." : ""}`,
  };
}

/** A member's record, from their graded ideas: a target before the stop is a win. */
export function ideaRecord(rows: { state: IdeaState; pips: number | null }[]): { graded: number; wins: number; losses: number; pips: number; open: number; untriggered: number } {
  let wins = 0, losses = 0, pips = 0, open = 0, untriggered = 0;
  for (const r of rows) {
    if (r.state === "tp1" || r.state === "tp2" || r.state === "tp3") { wins += 1; pips += r.pips ?? 0; }
    else if (r.state === "stopped") { losses += 1; pips += r.pips ?? 0; }
    else if (r.state === "open" || r.state === "ready" || r.state === "in_zone" || r.state === "waiting") open += 1;
    else if (r.state === "expired" || r.state === "invalidated" || r.state === "missed") untriggered += 1;
  }
  return { graded: wins + losses, wins, losses, pips, open, untriggered };
}

/** The idea as plain text, for "Copy all". */
export function ideaText(idea: AtlasIdea): string {
  if (idea.kind === "stand_aside" || !idea.entry || !idea.stop) return `ATLAS · XAUUSD — ${idea.headline}. ${idea.reasoning}`;
  const lines = [
    // A forced read says so wherever it is pasted: it is not a trade the engine confirmed.
    `ATLAS · XAUUSD ${idea.side === "buy" ? "BUY" : "SELL"} · ${idea.style ? IDEA_STYLE_LABEL[idea.style] : ""}${idea.source === "forced_read" ? ` · forced read, ${(idea.confidence?.label ?? "low").toLowerCase()} conviction` : ""}`.trim(),
    idea.entry.type === "market" ? `Entry: ${fmtPx(idea.entry.price)} (market)` : `Entry: ${fmtPx(idea.entry.low)}–${fmtPx(idea.entry.high)}${idea.entry.trigger ? ` after ${idea.entry.trigger.charAt(0).toLowerCase()}${idea.entry.trigger.slice(1)}` : ""}`,
    `Stop: ${fmtPx(idea.stop.price)} (${idea.stop.pips} pips)`,
    ...idea.targets.map((t) => `${t.label}: ${fmtPx(t.price)} (${t.pips} pips, ${t.r}R)`),
    idea.invalidation ? `Invalidation: ${idea.invalidation.text}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}
