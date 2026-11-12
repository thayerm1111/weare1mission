/**
 * ATLAS TRADE IDEA — "GENERATE" (owner 11-11: "When I click generate I want atlas to give me the trade idea
 * and where I should enter. I want the engine of atlas though to run the trade.")
 *
 * One function turns what ATLAS already measured into ONE answer in its own voice: which way, where to
 * enter, where the stop goes, where it is aiming, why, and what would make it wrong. There is nothing to
 * choose first (owner 11-12: "not so many options just want an atlas option that goes off what atlas sees.
 * Needs to feel like it's come right from the AI. I don't want the quick, intraday, or swing versions").
 *
 * WHERE THE ANSWER COMES FROM.
 *
 *   • A CONFIRMED SETUP (source "setup_engine"). When engines/setup.ts has a trade READY, the idea IS that
 *     trade, number for number: the same entry band, stop and objectives the member is shown on the trade
 *     card and the server recomputes before an order is sent. When the engine has everything but its
 *     trigger, the idea is that trade with the entry it is waiting for. Nothing about that engine changes
 *     here — its stop is its own.
 *
 *   • ATLAS'S CALL (sources "read_plan" and "forced_read"). Otherwise ATLAS still names a side and a trade
 *     (owner 11-11: "I don't want it ever to stand down. I want it forced to read the market and come up
 *     with a direction and a trade."): the side its read leans to — or, when it holds no lean, the side the
 *     evidence tilts to with the abstention threshold removed — entered at the price, with the stop behind
 *     market structure. "read_plan" means a clear or strong lean stood behind it; "forced_read" means
 *     anything fainter. The member is shown one thing either way: ATLAS's call, and how convinced it is.
 *
 * THE RULES OF A CALL.
 *
 *   • THE STOP FOLLOWS MARKET STRUCTURE (owner 11-12: "needs to go with market structure for the stop loss.
 *     It can be less then 30 pips stop"). It goes behind the last confirmed swing still standing on the
 *     losing side — the last higher low under a buy, the last lower high over a sell — read from the closed
 *     5- and 15-minute candles. No fixed pad and no style floor: only a stop inside the noise is passed over.
 *   • EVERY NUMBER IS REAL. The entry is the price. The stop is a real candle's low or high plus the spread.
 *     A target is a real level or a standing swing at least one R away; in open space the targets are
 *     multiples of the risk and every one of them says so.
 *   • IT NEVER CLAIMS MORE THAN IT HAS. A call says it is ATLAS's read and not one of its confirmed setups,
 *     shows its conviction (usually low when the read is faint), and executing it is always the member's
 *     decision through the order ticket and its existing checks — never ATLAS's own take-setup trade. Where
 *     those checks would refuse (the market is flagged chaotic), it says so instead of offering a ticket.
 *     Nothing about the setup engine or the order checks changes.
 *     The one thing that cannot be produced is a number from nothing: with no market read at all there is
 *     no price to build on, and the answer says exactly that.
 *   • CONVICTION IS NOT A WIN RATE. The score is the setup engine's confidence or the read's evidence
 *     balance, named as such. Nothing here claims a probability.
 *
 * Pure: no I/O and no clock except `now`. The same inputs always produce the same idea, which is what lets
 * the replay prove what ATLAS would have said at any moment of a recorded session.
 */
import type { Bar, Level, MarketSnapshot, Side, Timeframe } from "../core/types";
import { PIP, TF_MINUTES } from "../core/types";
import { STYLE, type Style } from "../core/style";
import { levelIdOf, type AtlasRead, type EvidenceRef, type Scenario } from "../core/atlasContract";
import { READ_RULES, edgesOfRead, fmtPx, signed } from "../core/read";
import { priceNow } from "../core/priceNow";
import { swings } from "../core/levelMap";
import { resample } from "../core/bars";
import { STRATEGY_LABEL, type BrainSetup, type SetupState } from "./setup";

export const ATLAS_IDEA_VERSION = "idea-2";
/** Versions a stored idea may carry and still be read back: idea-2 only added the forced read. */
export const IDEA_VERSIONS: readonly string[] = ["idea-1", "idea-2"];

export const IDEA_RULES = {
  /** A zone around the last price, in 15-minute ATR, when nothing can be entered yet (gold closed, a stale read). */
  ZONE_ATR: 0.25,
  /** An objective closer than one R is not an objective (setup.ts). */
  MIN_R: 1.0,
  /** Each further objective must be at least this much further out, in R (setup.ts). */
  NEXT_R: 0.6,
  /** A real level closer than this beyond the entry is in the way (setup.ts: "trading straight into it"). */
  OBSTRUCTION_R: 0.6,
  /** In open space, with no real level at a sensible distance: the setup engine's fallback multiples. */
  FALLBACK_R: [1.8, 3.0] as const,
  /** How long a call made from a clear lean stays on offer — the scenarios' own horizon (core/scenarios.ts). */
  PLAN_TTL_MS: 4 * 3600_000,
  /** The engine's own rule for a market entry that is still the same trade (setup.ts stillValid). */
  DRIFT_R: 0.6,
  /** Minutes to a high-impact release inside which the idea carries a warning (setup.ts uses 20). */
  NEWS_WARN_MIN: 20,
  /*
   * STOPS FOLLOW MARKET STRUCTURE (owner 11-12: "needs to go with market structure for the stop loss. It can
   * be less then 30 pips stop"). On ATLAS's own calls the stop goes behind the last swing still standing on
   * the losing side — not a fixed pad, and with no style floor under it.
   */
  /** A swing is a candle with this many lower highs (higher lows) on each side. */
  SWING_K: 2,
  /** How far back the 5-minute swings are read: eight hours of candles. */
  SWING_BARS_5M: 96,
  /** What the stop gives the swing it hides behind: the spread plus this much of the 5-minute ATR … */
  STOP_BUFFER_ATR: 0.1,
  /** … and never less than this, in price (three pips). */
  STOP_BUFFER_MIN: 0.3,
  /** Swings and levels packed within this much of the 5-minute ATR beyond the chosen one are cleared together. */
  STOP_CLUSTER_ATR: 0.25,
  /** The tightest stop a call may carry, in pips … */
  MIN_STOP_PIPS: 10,
  /** … and never closer than this much of the 5-minute ATR: half an average candle is noise, not structure. */
  MIN_STOP_ATR: 0.5,
  /** A swing further than this from the entry is not what the entry leans on. */
  MAX_STOP_PIPS: 200,
  /** With no structure at a usable distance: this much of the 15-minute ATR, said to be measured. */
  MEASURED_STOP_ATR: 1.2,
  /** Under this a stop is called tight where the member reads the call. */
  TIGHT_STOP_PIPS: 25,
  /** A market entry's band around the price, in ATR — the setup engine's own entry band (setup.ts). */
  FORCED_BAND_ATR: 0.12,
  /** How long a call from a tilt of the evidence stays on offer: half a clear lean's — it has less behind it. */
  FORCED_TTL_MS: 2 * 3600_000,
  /** …and one made while gold is closed, which waits for the reopen. */
  FORCED_CLOSED_TTL_MS: 72 * 3600_000,
} as const;

/** The 15-minute ATR sizes a call's entry band; when it has no reading, the nearest timeframe that has, scaled by the square root of time. */
const ATR_FALLBACK: [Timeframe, number][] = [["5m", 1.7], ["1h", 0.5]];

export type IdeaStyleChoice = "auto" | Style;
export type IdeaOptions = { style: IdeaStyleChoice };
export const DEFAULT_IDEA_OPTIONS: IdeaOptions = { style: "auto" };

/**
 * What a request may ask for. Since 11-12 that is nothing: the Quick / Intraday / Swing choice is gone (owner:
 * "I don't want the quick, intraday, or swing versions … just want an atlas option that goes off what atlas
 * sees"), so whatever arrives — including a style from a page that has not refreshed — is ATLAS's own call.
 * The field stays on stored ideas, which were generated with one.
 */
export function ideaOptionsOf(_raw?: unknown): IdeaOptions {
  return { style: "auto" };
}

export type IdeaKind = "enter_now" | "on_confirmation" | "at_level" | "on_break" | "stand_aside";
/**
 * setup_engine: the setup engine's own confirmed trade. read_plan: ATLAS's call with a clear or strong lean
 * behind it (and, on ideas stored before 11-12, a plan at one of that lean's two levels). forced_read: its
 * call from anything fainter — the side the evidence tilts to. The member is shown the last two as one thing.
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
  /** What ATLAS would watch to say "the entry is here". `say` is the instruction the watch engine parses,
   *  so its price is written plainly (4371.77, no thousands separator). */
  watch: { price: number; direction: "above" | "below"; say: string } | null;
  /** The idea in two or three spoken sentences (chat and voice say exactly this). */
  say: string;
};

export type BuildIdeaInput = {
  snapshot: MarketSnapshot | null;
  snapshotId?: number | null;
  /** What the setup engine wants right now — exactly what the trade card shows. */
  setup: BrainSetup;
  /**
   * True when `setup` is what the server's take-setup path recomputes before an order is sent. Only then can
   * a confirmed setup be taken as ATLAS's own trade; otherwise executing it is the member's call.
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
  /**
   * The 5-minute candles on hand, oldest first. Swings are read from the closed ones; the one still forming
   * only tells whether a swing has been traded through. Without candles only each timeframe's last swing is
   * known.
   */
  bars5m?: Bar[] | null;
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

/** The 15-minute ATR, and whether it had to be estimated from another timeframe. */
function atr15Of(s: MarketSnapshot): { atr: number; tf: Timeframe; estimated: boolean } | null {
  const own = s.timeframes["15m"]?.features.atr;
  if (own != null && own > 0) return { atr: own, tf: "15m", estimated: false };
  for (const [tf, k] of ATR_FALLBACK) {
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
/** A call is read as short paragraphs (the card shows them one under another); an empty one is dropped. */
const paragraphs = (...parts: (string | null | undefined)[]) => parts.map((x) => (x ?? "").trim()).filter(Boolean).join("\n\n");

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
  const warnings = [newsWarning(s), ...s.warnings.slice(0, 2)].filter((x): x is string => !!x);
  if (i.tradeActive) warnings.push("You already have an ATLAS position open — the position limit is checked before another order is sent.");
  if (su.blockedBy) warnings.push(su.blockedBy);

  const base = {
    version: ATLAS_IDEA_VERSION, id: null, at: i.now, snapshotAt: s.at, snapshotId: i.snapshotId ?? null, options,
    source: "setup_engine" as const, side, style, strategy,
    price: r2(priceNow(s)),
    confidence: {
      score: su.confidence, label: confLabel(su.confidence),
      basis: `My confidence in this setup is ${su.confidence} of 100, from the evidence and the reward on offer — not a win probability.`,
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
      badge: "ATLAS'S CALL · CONFIRMED SETUP",
      entry: {
        type: "market", price: entry, low: su.entryLow, high: su.entryHigh, level: null, trigger: null, confirm: "none",
        text: `Enter at market now, around ${zone}.`, distancePips: 0,
      },
      stop: { price: su.stop, pips: pipsOf(risk, pipSize), what: `Behind the structure this trade depends on, with room for the spread and slippage.` },
      targets, rr: rrOf(targets),
      reasoning: paragraphs(su.thesis, `This is one of my confirmed setups — every condition I need is met — so it's a trade I'd take myself. I'd ${up ? "buy" : "sell"} here, around ${zone}, with the stop at ${fmtPx(su.stop)} (${pipsOf(risk, pipSize)} pips), behind the structure the trade depends on. First target ${fmtPx(targets[0].price)}, ${targets[0].r} times the risk.`),
      targeting: targetingOf(targets),
      waitingFor: [],
      expiresAt: su.expiresAt,
      execute: {
        via, now: true,
        note: via === "take_setup"
          ? "This is my own trade. I recompute it from the live market before anything is sent, size it from your profile's risk, attach the stop and the first target, and manage it once it's on."
          : "Taking it is your call. It opens through my order checks, sized from your risk, and I manage it once it's on.",
        approved: via === "take_setup" ? approved : null,
        manual: { side, style, stop: su.stop, takeProfit: su.initialObjective },
      },
      watch: null,
      say: `${up ? "Buy" : "Sell"} gold now, around ${fmtPx(entry)}. Stop ${fmtPx(su.stop)}, ${pipsOf(risk, pipSize)} pips. First target ${fmtPx(targets[0].price)}, ${targets[0].r} to one. It's one of my confirmed setups — I'd take this one myself.`,
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
    if (stopPips > STYLE[style].maxStopPips) warnings.push(`From the trigger the stop is ${stopPips} pips — wider than I allow on this kind of trade, so I'd want tighter structure by the time it breaks.`);
    const targets = targetsFrom(trig, risk, side, levels, pipSize);
    const distance = pipsOf(Math.max(0, d * (trig - priceNow(s))), pipSize);
    return {
      ...base,
      kind: "on_break",
      headline: `${up ? "BUY" : "SELL"} the break of ${fmtPx(trig)}`,
      badge: "ATLAS'S CALL · WAITING ON THE BREAK",
      entry: {
        type: "stop", price: r2(trig), low: r2(trig), high: r2(trig),
        level: { price: r2(trig), label: levels.find((l) => Math.abs(l.price - trig) < 0.06)?.label ?? "the engine's trigger" },
        trigger: `Gold trading ${up ? "above" : "below"} ${fmtPx(trig)}`, confirm: "touch",
        text: `Not yet. The entry is when gold trades ${up ? "above" : "below"} ${fmtPx(trig)} — ${distance} pips from here. I re-price the trade at that moment and flag it TRADE READY.`,
        distancePips: distance,
      },
      stop: { price: su.stop, pips: stopPips, what: "Behind the structure this trade depends on, measured from the trigger." },
      targets, rr: rrOf(targets),
      reasoning: paragraphs(su.thesis, `Everything I need is in place except the trigger: ${missing.map((m) => m.text.toLowerCase()).join(", ")}. So I'm not ${up ? "buying" : "selling"} yet — the entry is the break of ${fmtPx(trig)}, ${distance} pips from here, with the stop at ${fmtPx(su.stop)}.`),
      targeting: targetingOf(targets),
      waitingFor: missing.map((m) => m.text),
      expiresAt: su.expiresAt,
      execute: { via: null, now: false, note: "Nothing to execute until the trigger breaks. When it does, my trade card turns TRADE READY and you take it there.", approved: null, manual: { side, style, stop: su.stop, takeProfit: targets[0]?.price ?? null } },
      watch: { price: r2(trig), direction: up ? "above" : "below", say: `Watch ${trig.toFixed(2)} and tell me if it breaks ${up ? "above" : "below"}.` },
      say: `${up ? "Buy" : "Sell"} the break of ${fmtPx(trig)}, not before — that's ${distance} pips from here. Stop ${fmtPx(su.stop)}${targets[0] ? `, first target ${fmtPx(targets[0].price)}` : ""}. Everything else I need is in place — I'm only waiting on that break.`,
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
        badge: "ATLAS'S CALL · WAITING FOR A BETTER PRICE",
        entry: {
          type: "limit", price: far, low: r2(Math.min(pivot, far)), high: r2(Math.max(pivot, far)),
          level: { price: r2(pivot), label: levels.find((l) => Math.abs(l.price - pivot) < 0.06)?.label ?? "the level this trade is built on" },
          trigger: null, confirm: "none",
          text: `Not here — gold has run ${distance} pips past the zone. The entry is back between ${fmtPx(Math.min(pivot, far))} and ${fmtPx(Math.max(pivot, far))}.`,
          distancePips: distance,
        },
        stop: { price: su.stop, pips: pipsOf(risk, pipSize), what: "Behind the structure this trade depends on, measured from the far edge of the zone." },
        targets, rr: rrOf(targets),
        reasoning: paragraphs([su.thesis, stretched.detail].filter(Boolean).join(" "), `I want this ${up ? "buy" : "sell"}, but not at this price — gold has run ${distance} pips past where the trade makes sense. The entry is back between ${fmtPx(Math.min(pivot, far))} and ${fmtPx(Math.max(pivot, far))}, with the stop at ${fmtPx(su.stop)}.`),
        targeting: targetingOf(targets),
        waitingFor: [`Price back inside ${fmtPx(Math.min(pivot, far))}–${fmtPx(Math.max(pivot, far))}`],
        expiresAt: su.expiresAt,
        execute: { via: null, now: false, note: "Nothing to execute until price comes back to the zone. I flag it TRADE READY when it does.", approved: null, manual: { side, style, stop: su.stop, takeProfit: targets[0]?.price ?? null } },
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
      badge: "ATLAS'S CALL · NOT CONFIRMED YET",
      entry: {
        type: "market", price: entry, low: su.entryLow, high: su.entryHigh, level: null,
        trigger: `My confidence reaching ${min}`, confirm: "none",
        text: `The conditions are met, but my confidence is ${su.confidence} and I call a trade ready from ${min}. If it firms up, the entry is at market around ${fmtPx(su.entryLow)}–${fmtPx(su.entryHigh)}.`,
        distancePips: 0,
      },
      stop: { price: su.stop, pips: pipsOf(risk, pipSize), what: "Behind the structure this trade depends on." },
      targets, rr: rrOf(targets),
      reasoning: paragraphs([su.thesis, su.say].filter(Boolean).join(" "), `So this is a lean, not a confirmed setup: I'd be a ${up ? "buyer" : "seller"} around ${fmtPx(entry)} with the stop at ${fmtPx(su.stop)}, and I'm not taking it myself until my confidence reaches ${min}.`),
      targeting: targetingOf(targets),
      waitingFor: [`Confidence of at least ${min} (now ${su.confidence})`],
      expiresAt: su.expiresAt,
      execute: {
        via: "manual", now: true,
        note: "I haven't confirmed this one, so taking it is your call. It opens through my order checks, and I manage it once it's on.",
        approved: null, manual: { side, style, stop: su.stop, takeProfit: targets[0]?.price ?? su.initialObjective },
      },
      watch: null,
      say: `I lean to a ${up ? "buy" : "sell"} around ${fmtPx(entry)} with the stop at ${fmtPx(su.stop)}, but my confidence is ${su.confidence} and I call it ready from ${min}. It's not confirmed.`,
    };
  }
  return null;
}

/* ── market structure: where a stop belongs ────────────────────────────────────────────────────────── */

export type StructurePoint = {
  price: number; type: "high" | "low"; tf: Timeframe;
  /** The 5-minute candle that made it (its open time), when it came from the candles. */
  t: number | null;
  label: string;
};

const M5_MS = 5 * 60_000;

/**
 * THE SWINGS THE MARKET IS STANDING ON (owner 11-12: "needs to go with market structure for the stop loss").
 *
 * Confirmed swing highs and lows — a high with two lower highs on each side, and the mirror for lows — read
 * from the CLOSED 5-minute candles and from the 15-minute candles folded from them; and of those, only the
 * ones price has NOT traded through since. A swing low that was taken out later is not structure any more,
 * it is a price where structure used to be. What is left under the price is therefore a staircase: the
 * nearest swing low is the last one made, and each older one is lower. (The mirror above the price.)
 *
 * Every point is a real candle's high or low; nothing is estimated. A swing the 15-minute chart shows is
 * named as that, the rest are 5-minute swings. Newest first. With no candles on hand, each timeframe's last
 * swing from the snapshot's own structure read stands in.
 */
export function structureOf(s: MarketSnapshot, bars5m: Bar[] | null | undefined, now: number): StructurePoint[] {
  const K = IDEA_RULES.SWING_K;
  const all = (bars5m ?? [])
    .filter((b) => b && Number.isFinite(b.t) && Number.isFinite(b.h) && Number.isFinite(b.l) && b.h > 0 && b.l > 0)
    .sort((a, b) => a.t - b.t);
  const closed = all.filter((b) => b.t + M5_MS <= now);

  if (closed.length < 2 * K + 1) {
    const out: StructurePoint[] = [];
    const add = (p: StructurePoint) => {
      if (!Number.isFinite(p.price) || p.price <= 0) return;
      if (!out.some((x) => x.type === p.type && Math.abs(x.price - p.price) < 0.05)) out.push({ ...p, price: r2(p.price) });
    };
    for (const tf of ["15m", "5m", "1h"] as Timeframe[]) {
      const st = s.timeframes[tf]?.structure;
      if (!st) continue;
      if (st.swingHigh != null) add({ price: st.swingHigh, type: "high", tf, t: null, label: `the last ${TF_WORD[tf]} swing high` });
      if (st.swingLow != null) add({ price: st.swingLow, type: "low", tf, t: null, label: `the last ${TF_WORD[tf]} swing low` });
    }
    return out;
  }

  type Raw = { price: number; type: "high" | "low"; tf: Timeframe; t: number; end: number };
  const raw: Raw[] = [];
  const m15 = 15 * 60_000;
  const sw15 = swings(resample(closed, "5m", "15m"), K);
  // A 15-minute swing is timed by the 5-minute candle inside it that made the extreme.
  const within = (t15: number, pick: (b: Bar) => number, best: (a: number, b: number) => boolean) => {
    let hit: Bar | null = null;
    for (const b of closed) if (b.t >= t15 && b.t < t15 + m15 && (!hit || best(pick(b), pick(hit)))) hit = b;
    return hit;
  };
  for (const b of sw15.highs) raw.push({ price: b.h, type: "high", tf: "15m", t: within(b.t, (x) => x.h, (a, c) => a > c)?.t ?? b.t, end: b.t + m15 });
  for (const b of sw15.lows) raw.push({ price: b.l, type: "low", tf: "15m", t: within(b.t, (x) => x.l, (a, c) => a < c)?.t ?? b.t, end: b.t + m15 });
  const sw5 = swings(closed.slice(-IDEA_RULES.SWING_BARS_5M), K);
  for (const b of sw5.highs) raw.push({ price: b.h, type: "high", tf: "5m", t: b.t, end: b.t + M5_MS });
  for (const b of sw5.lows) raw.push({ price: b.l, type: "low", tf: "5m", t: b.t, end: b.t + M5_MS });

  // Still standing: nothing since — the candle still forming included — has traded through it.
  const standing = raw.filter((p) => !all.some((b) => b.t >= p.end && (p.type === "high" ? b.h > p.price : b.l < p.price)));
  // Where both charts mark the same price, the 15-minute chart names it.
  const kept: Raw[] = [];
  for (const p of standing) if (!kept.some((x) => x.type === p.type && Math.abs(x.price - p.price) < 0.05)) kept.push(p);
  kept.sort((a, b) => b.t - a.t);

  const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
  const seen = { high: 0, low: 0 };
  return kept.map((p) => ({
    price: r2(p.price), type: p.type, tf: p.tf, t: p.t,
    label: seen[p.type]++ === 0 ? `the last ${TF_WORD[p.tf]} swing ${p.type}` : `the ${TF_WORD[p.tf]} swing ${p.type} from ${hhmm(p.t)} UTC`,
  }));
}

/** A level's name as it reads in a sentence: "the London low", "today's low", "the 4-hour swing high from Thu 09/17". */
export function sayLevel(label: string): string {
  let x = (label.split(" · ")[0] ?? label).trim();
  const sw = /^(\d+)\s*([hd]) swing (high|low) \(([^)]+)\)$/i.exec(x);
  if (sw) return `the ${sw[1]}-${sw[2].toLowerCase() === "h" ? "hour" : "day"} swing ${sw[3].toLowerCase()} from ${sw[4].replace(",", "")}`;
  if (/^(support|resistance)$/i.test(x)) return `the ${x.toLowerCase()} I'm watching`;
  x = x.replace(/\bnew york\b/gi, "New York").replace(/\blondon\b/gi, "London").replace(/\basia\b/gi, "Asia").replace(/\btokyo\b/gi, "Tokyo");
  return /^(the|today's|yesterday's|this|last)\b/i.test(x) ? x : `the ${x}`;
}

const atr5Of = (s: MarketSnapshot): number => {
  const a5 = s.timeframes["5m"]?.features.atr;
  if (a5 != null && a5 > 0) return a5;
  const a15 = s.timeframes["15m"]?.features.atr;
  return a15 != null && a15 > 0 ? a15 * 0.58 : 0;
};

/** What a stop gives the swing it hides behind: the spread, and a tenth of the 5-minute range (never under three pips). */
function stopBuffer(s: MarketSnapshot): number {
  const R = IDEA_RULES;
  const spread = s.spread != null && s.spread > 0 ? s.spread : 0;
  return spread + Math.max(R.STOP_BUFFER_MIN, R.STOP_BUFFER_ATR * atr5Of(s));
}

type StopPlan = {
  stop: number; risk: number; pips: number;
  /** swing: behind a swing still standing. level: behind a real level. measured: no structure at a usable distance. */
  basis: "swing" | "level" | "measured";
  /** The swing or level the stop sits just beyond. */
  point: { price: number; label: string } | null;
  /** The nearer swing or level the stop also clears, when others were packed right behind the first one. */
  cleared: { price: number; label: string } | null;
  /** A nearer swing that was passed over because a stop behind it would sit inside the noise. */
  tooTight: { price: number; label: string; pips: number } | null;
  /** Why the stop is not behind a swing, as a clause in ATLAS's voice ("there's no swing low under the price …"). */
  noSwing: string | null;
};

/**
 * THE STOP FOR AN ENTRY: BEHIND THE LAST SWING.
 *
 * Under a buy, the nearest swing low still standing (the last higher low); over a sell, the nearest swing
 * high — plus the spread and a small buffer, so the stop is beyond the swing rather than on it. There is no
 * style floor under it and it may be tight (owner 11-12: "It can be less then 30 pips stop"); the only floor
 * is noise: a stop closer than MIN_STOP_PIPS, or than half an average 5-minute candle, is passed over for the
 * swing before it. Swings or levels packed right behind the chosen one are cleared with it — the stop goes
 * beyond the last of them — so it never sits between two.
 *
 * When no swing stands at a usable distance — gold is at the extreme of its move, or the last swing is
 * further than MAX_STOP_PIPS — the stop goes behind the nearest real level instead, and failing that it is a
 * stated multiple of the 15-minute range, called measured. The reason is carried in `noSwing` and said.
 */
function structureStop(side: Side, entry: number, struct: StructurePoint[], levels: Lv[], s: MarketSnapshot, pipSize: number): StopPlan {
  const R = IDEA_RULES, d = sgn(side);
  const a5 = atr5Of(s);
  const buffer = stopBuffer(s);
  const min = Math.max(R.MIN_STOP_PIPS * pipSize, R.MIN_STOP_ATR * a5), max = R.MAX_STOP_PIPS * pipSize;
  const riskAt = (price: number) => d * (entry - price) + buffer;
  const behind = <T extends { price: number }>(xs: T[]) => xs.filter((x) => d * (entry - x.price) > 0).sort((a, b) => riskAt(a.price) - riskAt(b.price));
  const fits = (x: { price: number }) => riskAt(x.price) >= min && riskAt(x.price) <= max;
  const word = side === "buy" ? "low" : "high", where = side === "buy" ? "under" : "over";
  const sw = behind(struct.filter((x) => x.type === word));
  const lv = behind(levels);
  const swing = sw.find(fits) ?? null;
  const level = swing ? null : lv.find(fits) ?? null;
  const near = sw[0] ?? null;
  const tooTight = swing && near && near !== swing && riskAt(near.price) < min
    ? { price: near.price, label: near.label, pips: pipsOf(entry - near.price, pipSize) } : null;
  const noSwing = swing ? null
    : !near ? `there's no swing ${word} ${where} the price to lean on, because gold is at the ${word} of this move`
    : riskAt(near.price) > max ? `the last swing ${word} is ${pipsOf(entry - near.price, pipSize)} pips away, too far to be the stop for this trade`
    : `the last swing ${word} is only ${pipsOf(entry - near.price, pipSize)} pips ${where} the price, inside the noise, and the one before it is too far away`;

  const first = swing ? { p: swing as { price: number; label: string }, basis: "swing" as const } : level ? { p: level as { price: number; label: string }, basis: "level" as const } : null;
  if (first) {
    const cluster = Math.max(R.STOP_BUFFER_MIN, R.STOP_CLUSTER_ATR * a5);
    let far: { price: number; label: string } = first.p;
    for (const x of [...sw, ...lv].sort((a, b) => riskAt(a.price) - riskAt(b.price))) {
      const gap = d * (far.price - x.price);
      if (gap > 0.005 && gap <= cluster && riskAt(x.price) <= max) far = x;
    }
    const stop = r2(entry - d * riskAt(far.price)), risk = Math.abs(entry - stop);
    return {
      stop, risk, pips: Math.round(risk / pipSize), basis: first.basis,
      point: { price: far.price, label: far.label }, cleared: far === first.p ? null : { price: first.p.price, label: first.p.label }, tooTight, noSwing,
    };
  }
  const a15 = s.timeframes["15m"]?.features.atr ?? (a5 > 0 ? a5 * 1.7 : 0);
  const stop = r2(entry - d * Math.min(max, Math.max(min, R.MEASURED_STOP_ATR * a15 + buffer))), risk = Math.abs(entry - stop);
  return { stop, risk, pips: Math.round(risk / pipSize), basis: "measured", point: null, cleared: null, tooTight: null, noSwing };
}

/**
 * How ATLAS would manage a trade with this stop, for the order ticket — never a choice the member is shown.
 * A stop the order checks would call "inside the noise" of an intraday trade is a quick one by definition.
 */
function styleFor(stopPips: number, firstTargetPips: number): Style {
  if (stopPips < STYLE.hold.noiseFloorPips * 0.5) return "quick";
  if (stopPips <= STYLE.quick.maxStopPips && firstTargetPips <= (STYLE.quick.opportunityPips[1] ?? 100)) return "quick";
  return stopPips <= STYLE.hold.maxStopPips ? "hold" : "swing";
}

/* ── ATLAS's call ──────────────────────────────────────────────────────────────────────────────────── */

/** The read's two levels, named, and the two things that would have to happen for the picture to be decided. */
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

export type ForcedSide = {
  side: Side;
  /** How much of the evidence is on this side, 0–100: the read's own balance, or the structure vote when there is no read. */
  score: number;
  /**
   * lean: the read holds a lean. setup: it holds none, and the setup engine is already building a trade on
   * one side. evidence: neither, and the balance still tilts. structure: no usable read.
   */
  from: "lean" | "setup" | "evidence" | "structure";
  /** Why this side, in ATLAS's voice (a sentence without its full stop). */
  basis: string;
};

/**
 * WHICH SIDE, WHEN A SIDE MUST BE NAMED. What ATLAS already sees, with the thresholds it uses to abstain
 * removed:
 *   1. the read's lean, when it holds one (however faint);
 *   2. otherwise the side its setup engine is already building or watching a trade on — one ATLAS, one
 *      side: a call that sold while its own trade card was building a long would be two answers;
 *   3. otherwise the sign of the read's evidence balance (core/read.ts `score`) — a range or a turning
 *      market still has more on one side than the other;
 *   4. with no usable read (or a balance of exactly zero), a vote on the structure the snapshot measured:
 *      each timeframe's swing sequence (or its slope), then the pressure proxy; a dead heat is settled by
 *      which side of the daily open price is on, then by the 15-minute RSI.
 * Deterministic, and it says which of the four it used.
 */
export function forcedSide(read: AtlasRead | null, s: MarketSnapshot, engine?: { side: Side | null; state: SetupState } | null): ForcedSide {
  if (read && (read.lean === "bullish_lean" || read.lean === "bearish_lean")) {
    const up = read.lean === "bullish_lean";
    const faint = read.strength !== "clear" && read.strength !== "strong";
    return {
      side: up ? "buy" : "sell", score: Math.min(100, Math.abs(Math.round(read.score))), from: "lean",
      basis: faint
        ? `It's only a slight lean — ${signed(read.score)} of 100 on my evidence balance — but it's ${up ? "up" : "down"}, so I'm a ${up ? "buyer" : "seller"}`
        : `That's a ${read.strength} lean — ${signed(read.score)} of 100 on my evidence balance — so I'm a ${up ? "buyer" : "seller"}`,
    };
  }
  if (engine?.side && (engine.state === "setup_developing" || engine.state === "watching" || engine.state === "waiting_for_trigger" || engine.state === "trade_ready")) {
    const up = engine.side === "buy";
    const mine = read && read.lean !== "insufficient_data" ? Math.round((up ? 1 : -1) * read.score) : 0;
    return {
      side: engine.side, score: Math.min(100, Math.max(0, mine)), from: "setup",
      basis: `I don't hold a lean right now, but I'm already ${engine.state === "watching" ? "watching" : "building"} a ${up ? "long" : "short"} here — it isn't confirmed yet — so that's my side: I'm a ${up ? "buyer" : "seller"}`,
    };
  }
  if (read && read.lean !== "insufficient_data" && Math.abs(read.score) >= 1) {
    const up = read.score > 0;
    // Big enough to be a lean, but not yet held over a second closed candle (core/read.ts): said as exactly that.
    const fresh = Math.abs(read.score) >= READ_RULES.ENTER;
    return {
      side: up ? "buy" : "sell", score: Math.min(100, Math.abs(Math.round(read.score))), from: "evidence",
      basis: fresh
        ? `The balance of what I see has just tilted ${up ? "up" : "down"} — ${signed(read.score)} of 100 — and I'd normally want one more closed candle before I call that a lean, but right now I'm a ${up ? "buyer" : "seller"}`
        : `The balance of what I see tilts ${up ? "up" : "down"} — ${signed(read.score)} of 100, short of what I'd call a lean — so right now I'm a ${up ? "buyer" : "seller"}`,
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
    basis: `${read && read.lean !== "insufficient_data" ? "My read is dead even" : "I don't have a clean directional read right now"}, so I'm going off the structure I can measure: ${tie ?? agree.join(" and ")}. That tilts ${up ? "up" : "down"}, so I'm a ${up ? "buyer" : "seller"}`,
  };
}

type MarketPlan = {
  entry: number; stop: number; risk: number; stopPips: number; st: StopPlan;
  style: Style;
  targets: IdeaTarget[];
  /** A real level close enough ahead that the entry is trading into it. */
  obstruction: Lv | null;
  atr: { atr: number; tf: Timeframe; estimated: boolean };
};

/**
 * Price an entry at one price: the stop behind the last swing (`structureStop`), targets at the real levels
 * and standing swings at least one R out. `majors` are the session, daily and higher-timeframe levels: one of
 * those close ahead of the entry is something the trade is trading into; a five-minute swing is not.
 */
function priceEntry(s: MarketSnapshot, side: Side, entry: number, majors: Lv[], struct: StructurePoint[], pipSize: number): MarketPlan | null {
  const R = IDEA_RULES, d = sgn(side);
  const a = atr15Of(s);
  if (!a) return null;
  const st = structureStop(side, entry, struct, majors, s, pipSize);
  const aims: Lv[] = [...majors];
  for (const p of struct) {
    if (p.type !== (side === "buy" ? "high" : "low")) continue;
    if (!aims.some((l) => Math.abs(l.price - p.price) < 0.1)) aims.push({ price: p.price, label: p.label, kind: p.type === "high" ? "swing_high" : "swing_low" });
  }
  const obstruction = majors.filter((l) => d * (l.price - entry) > 0.005 && d * (l.price - entry) < R.OBSTRUCTION_R * st.risk).sort((x, y) => d * (x.price - y.price))[0] ?? null;
  const targets = targetsFrom(entry, st.risk, side, aims, pipSize);
  return { entry: r2(entry), stop: st.stop, risk: st.risk, stopPips: st.pips, st, style: styleFor(st.pips, targets[0].pips), targets, obstruction, atr: a };
}

type CallContext = {
  /** The setup engine's own reason for not trading (its blocked state). Null: it simply has no confirmed setup. */
  standDown: string | null;
  /** A market blocker the order checks refuse on (the market is flagged chaotic): no ticket can open while it stands. */
  refused: { code: string; detail: string } | null;
  closed: boolean;
  /** Minutes old, when the market read is too old to enter from. */
  staleMin: number | null;
  /** A data-quality blocker: the price itself is in doubt. */
  dataProblem: string | null;
};

/** Blockers that say the DATA cannot be trusted (as opposed to the market being hard to read). */
const DATA_BLOCKERS: readonly string[] = ["no_exec_read", "feed_stale", "feed_divergence", "exec_data_behind", "exec_data_gaps"];

/**
 * ATLAS'S CALL — what it would do with gold right now, when its setup engine has no confirmed trade.
 *
 * One answer, in its own voice (owner 11-12: "just want an atlas option that goes off what atlas sees. Needs
 * to feel like it's come right from the AI"):
 *
 *   • the side is `forcedSide` — its lean, or the way the evidence tilts with the abstention threshold removed;
 *   • the entry is the price gold is at, now. (Entries at a level were tried against the recorded session
 *     and did far worse: a level entry only fills when price is moving against it.)
 *   • the STOP IS BEHIND THE LAST SWING — `structureStop` — and may be tight; targets are real levels and
 *     standing swings at least one R out, or labelled as measured.
 *
 * It never claims more than it has. The conviction is the evidence balance and is shown; it says in the same
 * breath that this is its read and not one of its confirmed setups; and taking the call is always the
 * member's own decision through the order ticket and its existing checks — it is never ATLAS's take-setup
 * trade, and while the market carries a blocker those checks refuse on (chaotic), it says no ticket can open.
 * A call made from a clear or strong lean is source "read_plan"; anything fainter is "forced_read". With gold
 * closed, or a market read too old or too doubtful to enter from, it still names the side and the levels as
 * a plan around the last price, for when price is real again.
 *
 * Null only when no timeframe has a range reading: nothing can size an entry.
 */
function fromRead(i: BuildIdeaInput, s: MarketSnapshot, read: AtlasRead | null, ctx: CallContext): AtlasIdea | null {
  const R = IDEA_RULES;
  const pipSize = i.pipSize ?? PIP;
  const options: IdeaOptions = { ...DEFAULT_IDEA_OPTIONS, ...(i.options ?? {}) };
  const su = i.setup;
  const P = priceNow(s);
  const f = forcedSide(read, s, su);
  const side = f.side, d = sgn(side), up = side === "buy";
  const base = ideaLevels(s);
  const edges = read ? edgesAndPaths(read, base) : null;
  const struct = structureOf(s, i.bars5m, i.now);
  // The session, daily and higher-timeframe levels, and the read's own two edges.
  const majors = [...base];
  if (edges) for (const e of [edges.S, edges.Rz]) if (!majors.some((l) => Math.abs(l.price - e.price) < 0.1)) majors.push(e);
  const canEnter = !ctx.closed && ctx.staleMin == null && !ctx.dataProblem;

  const a = atr15Of(s);
  if (!a) return null;
  // Enterable: at the price. Otherwise: the same call from the worst price of a zone around the last price.
  const zLow = r2(P - R.ZONE_ATR * a.atr), zHigh = r2(P + R.ZONE_ATR * a.atr);
  const m = priceEntry(s, side, canEnter ? P : (up ? zHigh : zLow), majors, struct, pipSize);
  if (!m) return null;
  const st = m.st;

  const conviction: "Low" | "Medium" | "High" = f.score >= 55 ? "High" : f.score >= 30 ? "Medium" : "Low";
  const planned = !!read && f.from === "lean" && (read.strength === "clear" || read.strength === "strong") && canEnter && !ctx.standDown && !ctx.refused;
  const source: IdeaSource = planned ? "read_plan" : "forced_read";
  // Mid-sentence: an ordinary capitalised word loses its capital; "I", "I'm" and acronyms (RSI, ATR) keep theirs.
  const lower = (x: string) => (/^[A-Z][a-z]/.test(x) ? x.charAt(0).toLowerCase() + x.slice(1) : x);
  const strip = (x: string) => lower(x).replace(/^i'm standing down:\s*/, "").replace(/\.$/, "");
  // Which way the read's "evidence for" list points: its lean, or with no lean the sign of its balance.
  const forDir = read ? (read.lean === "bullish_lean" ? 1 : read.lean === "bearish_lean" ? -1 : read.score >= 0 ? 1 : -1) : 0;
  const evFor = !read ? [] : forDir === d ? read.evidenceFor : read.evidenceAgainst;
  const evAgainst = !read ? [] : forDir === d ? read.evidenceAgainst : read.evidenceFor;
  const confirmations = [
    ...evFor.slice(0, 5).map((x) => ({ label: x.text, ok: true, detail: null as string | null })),
    ...evAgainst.slice(0, 3).map((x) => ({ label: x.text, ok: false, detail: null as string | null })),
  ];
  const sideWord = up ? "BUY" : "SELL", verb = up ? "buy" : "sell";
  const below = up ? "below" : "above", lowWord = up ? "low" : "high";

  /* 1 — what I see, and which side that puts me on. */
  const summary = read ? read.summary.trim().replace(/\s+/g, " ") : "";
  const picture = summary.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? "";
  const boxed = edges && P > edges.S.price && P < edges.Rz.price;
  const seeing = !read || f.from === "structure" ? `${f.basis}.`
    : f.from === "lean" ? `${summary} ${f.basis}.`
    : read.lean === "transitioning" ? `${summary} Until that happens: ${lower(f.basis)}.`
    : `${picture} ${boxed ? `Price is boxed between ${fmtPx(edges!.S.price)} and ${fmtPx(edges!.Rz.price)}, so it isn't a clean trend.` : "It isn't a clean trend right now."} ${f.from === "setup" ? f.basis : `Still, ${lower(f.basis)}`}.`;

  /* 2 — the trade: entry, the stop behind structure, the first target. */
  const behindSays = st.point ? `just ${below} ${sayLevel(st.point.label)} at ${fmtPx(st.point.price)}${st.cleared ? `, which also clears ${sayLevel(st.cleared.label)} at ${fmtPx(st.cleared.price)}` : ""}` : "";
  const stopSays = st.basis === "swing" && st.point
    ? `${st.tooTight
      ? `${cap(st.tooTight.label)} is only ${st.tooTight.pips} pips ${up ? "under" : "over"} the price — inside the noise — so I'm using the one before it: my stop is ${fmtPx(st.stop)}, ${st.pips} pips away, ${behindSays}.`
      : `My stop is ${fmtPx(st.stop)}, ${st.pips} pips away — ${behindSays}.`} If that ${lowWord} breaks, the structure I'm leaning on is gone and I'm wrong.`
    : st.basis === "level" && st.point
      ? `${cap(st.noSwing ?? `no swing ${lowWord} stands behind the entry`)}, so I'm using the nearest real level instead: my stop is ${fmtPx(st.stop)}, ${st.pips} pips away, ${behindSays}.`
      : `${cap(st.noSwing ?? `no swing ${lowWord} stands behind the entry`)}, and there's no real level at a usable distance either, so my stop is measured from the range: ${fmtPx(st.stop)}, ${st.pips} pips away.`;
  const t0 = m.targets[0], t1 = m.targets[1];
  const aimOf = (t: IdeaTarget) => (/^the (last )?\d/.test(t.what) ? t.what : sayLevel(t.what));
  const rSays = (r: number) => (r === 1 ? "the same distance as the risk" : `${r} times the risk`);
  const tpSays = t0.basis === "level"
    ? `First target is ${aimOf(t0)} at ${fmtPx(t0.price)}, ${rSays(t0.r)}${t1 ? `; after that, ${aimOf(t1)} at ${fmtPx(t1.price)}` : ""}.`
    : `There's no real level to aim at on this side, so my targets are multiples of the risk: the first is ${fmtPx(t0.price)}, ${rSays(t0.r)}.`;
  const obstructed = m.obstruction ? ` ${cap(sayLevel(m.obstruction.label))} at ${fmtPx(m.obstruction.price)} is only ${pipsOf(m.obstruction.price - m.entry, pipSize)} pips ${up ? "above" : "below"}, so expect a reaction there first.` : "";

  /* 3 — how sure, whose decision, and what argues against it. Said in the same breath as the call. */
  const yours = ctx.closed ? "Gold is closed, so this is my plan for the reopen, built on the last session's prices — there's nothing to enter yet."
    : ctx.staleMin != null ? `My last look at the market was ${ctx.staleMin} minutes ago, so check the price before you act on any of this.`
    : ctx.dataProblem ? `My price data has a problem right now (${strip(ctx.dataProblem)}), so treat these levels as approximate.`
    : ctx.refused ? `${ctx.refused.code === "chaotic" ? "I have the market flagged as chaotic right now, and while that flag is up my order checks won't open a trade" : `My order checks are refusing new trades right now (${strip(ctx.refused.detail)})`} — mine or yours. So this is my read for you to weigh, not something I can put on.`
    : ctx.standDown ? `My own trading is standing down right now (${strip(ctx.standDown)}), so I'm not taking this one myself — it's my read, and taking it is your call.`
    : planned ? "It isn't one of my confirmed setups yet, so I'm not taking it myself — taking it is your call."
    : "It isn't one of my confirmed setups, so I'm not taking it myself — taking it is your call.";
  const engineOther = su.side && su.side !== side && (su.state === "setup_developing" || su.state === "watching" || su.state === "waiting_for_trigger" || su.state === "trade_ready");
  const against = `${evAgainst[0] ? ` What argues against it: ${lower(evAgainst[0].text)}.` : ""}${engineOther ? ` And on the five-minute chart I'm ${su.state === "watching" ? "watching" : "building"} a ${up ? "short" : "long"} at the same time, so the short-term picture disagrees with this lean.` : ""}`;
  const closing = `Conviction is ${conviction.toLowerCase()} — that's how one-sided my evidence is, not a win rate. ${yours}${against}`;

  const warnings: string[] = [];
  const spoken = new Set(s.blockers.map((b) => b.detail));     // already said in the call's own words
  for (const w of [newsWarning(s), ...s.warnings.filter((x) => !spoken.has(x)).slice(0, 2)]) if (w && !warnings.includes(w)) warnings.push(w);
  if (i.tradeActive) warnings.push("You already have an ATLAS position open — the position limit is checked before another order is sent.");
  if (m.obstruction) warnings.push(`${cap(sayLevel(m.obstruction.label))} at ${fmtPx(m.obstruction.price)} sits between the entry and the first target.`);
  if (m.targets.every((t) => t.basis === "measured")) warnings.push("There is no real level to aim at on this side, so the targets are multiples of the risk.");
  if (st.pips < R.TIGHT_STOP_PIPS) warnings.push(`That's a tight stop — ${st.pips} pips. A spread spike or one quick wick can reach it, so size it that way.`);
  const cantSend = ctx.closed ? "Gold is closed — nothing can be sent. Generate again when it reopens."
    : ctx.staleMin != null ? "My market read is too old to send an order from. Generate again when the feed is back."
    : ctx.dataProblem ? "My market data is in doubt, so nothing is sent from it. Generate again when the feed is clean."
    : ctx.refused ? `No ticket for this one: ${ctx.refused.code === "chaotic" ? "while I have the market flagged as chaotic, my order checks don't open trades" : `my order checks are refusing new trades (${strip(ctx.refused.detail)})`}. Generate again when it clears.` : null;

  const stopWhat = st.basis === "measured" || !st.point
    ? `Measured: ${R.MEASURED_STOP_ATR} × the 15-minute range — no swing or level stands at a usable distance behind the entry.`
    : `${cap(below)} ${sayLevel(st.point.label)} (${fmtPx(st.point.price)})${st.cleared ? `, clearing ${sayLevel(st.cleared.label)} (${fmtPx(st.cleared.price)})` : ""}, plus the spread — ${st.basis === "swing" ? "market structure, not a fixed distance" : `no swing ${lowWord} stands at a usable distance behind the entry`}.`;
  const targetingOf = (t: IdeaTarget[]) => `${t.map((x) => `${fmtPx(x.price)} (${x.basis === "level" ? aimOf(x) : `${x.r}R, measured`})`).join(", then ")}.`;
  const band = R.FORCED_BAND_ATR * a.atr;
  const stopTail = `Stop ${fmtPx(st.stop)}, ${st.pips} pips${st.point ? `, ${below} ${sayLevel(st.point.label)}` : ""}.`;

  const common = {
    version: ATLAS_IDEA_VERSION, id: null, at: i.now, snapshotAt: s.at, snapshotId: i.snapshotId ?? null, options,
    source, side, style: m.style,
    badge: ctx.closed ? "ATLAS'S CALL · GOLD IS CLOSED · FOR THE REOPEN"
      : !canEnter ? "ATLAS'S CALL · FROM MY LAST CLEAN READ"
      : `ATLAS'S CALL · ${conviction.toUpperCase()} CONVICTION`,
    price: r2(P),
    stop: { price: st.stop, pips: st.pips, what: stopWhat },
    targets: m.targets, rr: rrOf(m.targets),
    confidence: {
      score: f.score, label: conviction,
      basis: f.from === "structure"
        ? `No directional read behind this one: a count of the structure I can measure, ${f.score} of 100 one way — how much it agrees, not a win probability.`
        : f.from === "setup"
          ? `This call rests on the setup I'm building, which isn't confirmed. My evidence balance is ${read ? signed(read.score) : 0} of 100 — ${f.score} of it on this side. How much the evidence agrees, not a win probability.`
          : `My evidence balance is ${read ? signed(read.score) : f.score} of 100${f.from !== "evidence" ? "" : f.score >= READ_RULES.ENTER ? " — not yet held for a second candle, so I don't call it a lean" : " — below what I need to call a lean"}. How much the evidence agrees, not a win probability.`,
    },
    bias: read ? `${read.htfTrend.text} ${read.momentum.text}`.trim() : null,
    poi: st.point ? `${fmtPx(st.point.price)} — ${sayLevel(st.point.label)}, the structure the stop is behind.` : null,
    targeting: targetingOf(m.targets),
    confirmations,
    engine: engineOf(su),
    alternative: null as string | null,
    paths: edges?.paths ?? [],
    warnings,
    expiresAt: i.now + (ctx.closed ? R.FORCED_CLOSED_TTL_MS : planned ? R.PLAN_TTL_MS : R.FORCED_TTL_MS),
  };

  /* ── at the price gold is at ── */
  if (canEnter) {
    return {
      ...common,
      kind: "enter_now",
      strategy: "At the price, stop behind the last swing",
      headline: `${sideWord} XAUUSD — enter now`,
      entry: {
        type: "market", price: m.entry, low: r2(P - band), high: r2(P + band), level: null, trigger: null, confirm: "none",
        text: `Enter at market now, around ${fmtPx(P - band)}–${fmtPx(P + band)}.`, distancePips: 0,
      },
      reasoning: paragraphs(seeing, `I'd ${verb} here, around ${fmtPx(P)}. ${stopSays} ${tpSays}${obstructed}`, closing),
      invalidation: {
        text: st.point
          ? `Price through ${sayLevel(st.point.label)} at ${fmtPx(st.point.price)} — the stop is ${fmtPx(st.stop)}.`
          : `The stop at ${fmtPx(st.stop)}. No structure stands close behind this entry — only the stop.`,
        price: st.stop,
      },
      waitingFor: [],
      execute: {
        via: cantSend ? null : "manual", now: !cantSend,
        note: cantSend ?? "Taking it is your call. It opens through my order checks, sized from your risk, with the stop and the first target attached — and I manage it once it's on.",
        approved: null, manual: { side, style: m.style, stop: st.stop, takeProfit: t0.price },
      },
      watch: null,
      say: `I'd ${verb} gold here, around ${fmtPx(m.entry)}. ${stopTail} First target ${fmtPx(t0.price)}, ${t0.r} to one. ${conviction} conviction — my read, your call.`,
    };
  }

  /* ── nothing can be entered (closed, stale or doubtful data): the same call, around the last price ── */
  return {
    ...common,
    kind: "at_level",
    strategy: "From the last price",
    headline: ctx.closed ? `${sideWord} XAUUSD — when gold reopens near ${fmtPx(P)}` : `${sideWord} XAUUSD — near ${fmtPx(P)}, once my read is current`,
    entry: {
      type: "limit", price: m.entry, low: zLow, high: zHigh, level: null, trigger: ctx.closed ? "Gold reopening inside the zone" : "A current market read with price inside the zone", confirm: "none",
      text: ctx.closed
        ? `Gold is closed. If it reopens inside ${fmtPx(zLow)}–${fmtPx(zHigh)}, that is the entry; a gap beyond it changes the picture — generate again.`
        : `These levels are from my last clean read. If price is still inside ${fmtPx(zLow)}–${fmtPx(zHigh)} once the read is current, that is the entry — generate again to confirm it.`,
      distancePips: 0,
    },
    reasoning: paragraphs(seeing, `From the last price, ${fmtPx(P)}, I'd ${verb} inside ${fmtPx(zLow)}–${fmtPx(zHigh)}. ${stopSays} ${tpSays}${obstructed}`, closing),
    invalidation: { text: `The stop at ${fmtPx(st.stop)}. ${ctx.closed ? "A reopen beyond the zone" : "A current price beyond the zone"} means this was priced for a market that is no longer there.`, price: st.stop },
    waitingFor: [ctx.closed ? "The market to reopen" : "A clean, current market read"],
    execute: { via: null, now: false, note: cantSend ?? "Nothing can be sent from this read.", approved: null, manual: { side, style: m.style, stop: st.stop, takeProfit: t0.price } },
    watch: null,
    say: `I'd be a ${up ? "buyer" : "seller"} around ${fmtPx(P)} with the stop at ${fmtPx(st.stop)} and a first target of ${fmtPx(t0.price)} — but ${ctx.closed ? "gold is closed, so that is my plan for the reopen" : "that is from my last clean read, so check the price first"}.`,
  };
}

/* ── the idea ──────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Generate ATLAS's trade idea from one market state. It ALWAYS names a side and a trade when there is a
 * market read to build on (owner 11-11).
 *
 * Order: the setup engine's trade when it has one ready or waiting only on its trigger; otherwise ATLAS'S
 * CALL — its lean or the tilt of its evidence, entered at the price with the stop behind the last swing. The
 * engine blocked or standing down, a range, a turning or faint read, gold closed, a stale or doubtful read:
 * all of them get a call that says where it stands. Only a missing market read (or no range reading at all)
 * produces no trade.
 */
export function buildIdea(i: BuildIdeaInput): AtlasIdea {
  const s = i.snapshot;
  const su = i.setup;
  if (!s) return noData(i, "I can't see gold right now — there is no market read to build a trade on, and I won't invent a price.", ["a market read"]);

  const dataProblem = s.blockers.find((b) => DATA_BLOCKERS.includes(b.code)) ?? null;
  const closed = !i.marketOpen || s.blockers.some((b) => b.code === "market_closed");
  const staleMin = i.stale ? Math.max(1, Math.round((i.now - s.at) / 60_000)) : null;
  const read = i.read && i.read.lean !== "insufficient_data" ? i.read : null;

  // A confirmed setup comes first — only from a market that can be entered and that the engine itself is
  // willing to trade.
  if (!closed && staleMin == null && !s.blockers.length && su.state !== "blocked") {
    const engine = fromSetup(i, s, su);
    if (engine) return engine;
  }

  // Otherwise ATLAS's own call from what it sees. A blocker that is neither the calendar nor the data (the
  // market flagged chaotic) is one the order checks refuse on (engines/validator.ts → tradeable).
  const hard = s.blockers.find((b) => b.code !== "market_closed" && !DATA_BLOCKERS.includes(b.code)) ?? null;
  const call = fromRead(i, s, read, {
    standDown: hard ? null : su.state === "blocked" ? su.say : null,
    refused: hard ? { code: hard.code, detail: hard.detail } : null,
    closed, staleMin, dataProblem: dataProblem?.detail ?? null,
  });
  return call ?? noData(i, "I can't measure gold's range on any timeframe right now, so there is nothing to size an entry or a stop from — and I won't invent one.", ["a range reading"]);
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
    // Where it is pasted, it still says what it is: a confirmed setup, or ATLAS's read and how convinced it is.
    `ATLAS · XAUUSD ${idea.side === "buy" ? "BUY" : "SELL"} · ${idea.source === "setup_engine" ? "confirmed setup" : `ATLAS's call, ${(idea.confidence?.label ?? "low").toLowerCase()} conviction — a read, not a confirmed setup`}`,
    idea.entry.type === "market" ? `Entry: ${fmtPx(idea.entry.price)} (market)` : `Entry: ${fmtPx(idea.entry.low)}–${fmtPx(idea.entry.high)}${idea.entry.trigger ? ` after ${idea.entry.trigger.charAt(0).toLowerCase()}${idea.entry.trigger.slice(1)}` : ""}`,
    `Stop: ${fmtPx(idea.stop.price)} (${idea.stop.pips} pips)`,
    ...idea.targets.map((t) => `${t.label}: ${fmtPx(t.price)} (${t.pips} pips, ${t.r}R)`),
    idea.invalidation ? `Invalidation: ${idea.invalidation.text}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}
