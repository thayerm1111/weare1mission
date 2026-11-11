/**
 * ATLAS'S DIRECTIONAL READ (owner 11-11: a real-time market copilot with "a reasoned directional opinion").
 *
 * The question this file answers is the one a trader asks a colleague across the desk: "which way are you
 * leaning, why, and what would change your mind?" It answers with an AtlasRead (core/atlasContract.ts):
 * a lean, the evidence on each side with its weight, what it is watching next and the price that would
 * prove it wrong.
 *
 * FOUR RULES GOVERN EVERYTHING BELOW.
 *
 * 1. CLOSED CANDLES ONLY. Every candle this file reads has CLOSED (and had closed when it was fetched). A
 *    swing is confirmed only after READ_RULES.PIVOT_RIGHT later closed candles; the forming candle never
 *    confirms, breaks or reclaims anything. The snapshot's own live context (its timeframe states and its
 *    pressure proxy) is used as context with small weights — never as confirmation.
 *
 * 2. A SCORE IS NOT A PROBABILITY. The score is the signed sum of the evidence weights below, -100..100: how
 *    much the evidence agrees, and on which side. It is never presented as a chance of anything.
 *
 * 3. HYSTERESIS, SO NOISE CANNOT FLIP THE READ. Entering a lean takes |score| >= 30 on two consecutive
 *    readings taken on different closed 5-minute candles; dropping one takes the score in its direction
 *    falling below 15, again on two consecutive readings. Only a decisive event changes it at once: a
 *    15-minute candle closing beyond the level the lean said would invalidate it, or a 5-minute candle
 *    closing through the last confirmed 15-minute swing with the evidence agreeing (|score| >= 30). The
 *    levels a read names hold still until a 15-minute candle closes through them, and a held lean's
 *    invalidation only ever tightens.
 *
 * 4. A LEAN IS NEVER AN ENTRY. `setupStage` and `entry` are copied from the setup engine's own state and
 *    nothing else; no score, however strong, can make `entry` "confirmed". This file is display and
 *    conversation only — nothing on a trading path imports it (tests/cc-atlas-read.test.ts enforces that).
 *
 * Pure: no I/O, no clock except the `now` passed in, no locale-dependent formatting. Same input, same read.
 */
import type { Bar, Level, MarketSnapshot, StructureState, Timeframe } from "./types";
import { TF_MINUTES } from "./types";
import {
  ATLAS_READ_VERSION, levelIdOf,
  type AtlasRead, type Evidence, type EvidenceRef, type Lean,
} from "./atlasContract";
import { pivots, sequenceOf, type Pivot } from "./structure";
import { atr, efficiency, regression, rsi } from "./math";
import { isBearish, isBullish } from "./regime";
import type { SetupState } from "../engines/setup";

/* ── the rules, in one place, so they can be argued with ──────────────────────────────────────────── */

export const READ_RULES = {
  /** |score| a reading needs before it counts toward entering a lean. */
  ENTER: 30,
  /** A held lean survives while the score in its direction stays at or above this. */
  EXIT: 15,
  /** With no usable previous read (cold start), one reading must reach this to call a lean. */
  COLD_ENTER: 45,
  /** Two readings are "consecutive" only when a new 5-minute candle closed between them. */
  CONFIRM_TF: "5m" as Timeframe,
  /** A previous read older than this is history, not hysteresis: the read starts fresh. */
  PREVIOUS_MAX_AGE_MS: 30 * 60_000,
  /** A snapshot older than this (against the clock passed in) is not a current market. */
  STALE_MS: 5 * 60_000,
  /** Fractal pivots: a swing needs this many closed candles either side. The right side is the delay
   *  that makes it CONFIRMED — it cannot exist until those candles have closed. */
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,
  /** Closed candles needed per timeframe before that timeframe is read at all. */
  MIN_CLOSED: { "5m": 40, "15m": 20, "1h": 20, "4h": 20 } as Record<"5m" | "15m" | "1h" | "4h", number>,
  /** A 5-minute gap inside this many recent candles is a feed interruption that blinds the read. */
  RECENT_GAP_BARS: 12,
  /** How far back a break can be and still count as "failed" once price closes back inside. */
  FAIL_LOOKBACK: 6,
  /** How far back a wick through a swing counts as a sweep. */
  SWEEP_LOOKBACK: 3,
  /** How far back price must have been on the other side of a key level for a close to be a reclaim/loss. */
  RECLAIM_LOOKBACK: 6,
  /** A close must clear a key level by this fraction of the 5-minute ATR to count (knife-edge closes don't). */
  RECLAIM_MIN_ATR: 0.05,
  /** The HTF group must reach this for "up"/"down"; momentum must reach MOM_DIR for "rising"/"falling". */
  HTF_DIR: 8,
  MOM_DIR: 6,
  /** "Pending structure event": the deciding level sits within this many 15-minute ATRs. */
  PENDING_ATR: 1.0,
  /** The invalidation level must be at least this far away (15m ATR), so it is not a hair trigger... */
  INVALIDATION_MIN_ATR: 0.5,
  /** ...and is preferred within this distance. */
  STRUCTURAL_MAX_ATR: 3,
  /** The next level worth watching must be at least this far away (15m ATR). */
  NEXT_MIN_ATR: 0.15,
  /** 15-minute efficiency below this, in a ranging regime, is rotation rather than trend. */
  RANGE_EFFICIENCY: 0.25,
  RANGE_DAMPEN: 0.7,
  CHAOS_DAMPEN: 0.5,
  NEWS_MINUTES: 30,
  NEWS_DAMPEN: 0.85,
  LOCKOUT_DAMPEN: 0.7,
  /** Strength of a directional lean from the score in its direction. */
  STRENGTH_CLEAR: 30,
  STRENGTH_STRONG: 55,
  /** Most evidence items kept per side. */
  EVIDENCE_MAX: 6,
} as const;

/** Points each piece of evidence is worth at full strength. A fully aligned market sums to ~92. */
export const READ_WEIGHTS = {
  // Higher-timeframe trend — per timeframe (1h and 4h), from CONFIRMED swings on CLOSED candles.
  htfSequence: 10,   // HH/HL or LH/LL
  htfChoch: 6,       // a close through the last swing against that sequence (sequence counts half)
  htfBos: 2,         // a close through the last swing in the sequence's direction
  htfState: 5,       // the snapshot's own state for that timeframe (live context)
  // Immediate momentum — 5m and 15m.
  pressure: 8,       // the snapshot's pressure proxy, net / 5, capped (live context)
  pressureAccel: 2,  // the proxy moving by 10+ since the previous snapshot
  candles: 6,        // the last three closed 5-minute candles: colour balance and net progress
  slope5: 5,         // 5-minute regression slope (ATR units) x efficiency
  slope15: 7,        // 15-minute regression slope (ATR units) x efficiency
  rsi: 4,            // 15m (2.5) and 5m (1.5) RSI as momentum confirmation, not as a fade signal
  // Structure — 15m and 5m, closed candles.
  choch15: 12, bos15: 9, seq15: 6, failed15: 8, sweep15: 4,
  choch5: 7, bos5: 5, seq5: 3, failed5: 5, sweep5: 3,
  levelMajor: 7,     // reclaim/loss of yesterday's high or low
  levelSession: 5,   // reclaim/loss of an Asia / London / New York high or low
  levelOpen: 4,      // reclaim/loss of the daily open
} as const;

/* ── small helpers ───────────────────────────────────────────────────────────────────────────────── */

type Dir = 1 | -1 | 0;
const sgn = (x: number): Dir => (x > 0 ? 1 : x < 0 ? -1 : 0);
const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round1 = (x: number) => Math.round(x * 10) / 10;
const leanOf = (d: Dir): Lean => (d > 0 ? "bullish_lean" : d < 0 ? "bearish_lean" : "balanced");
const dirOfLean = (l: Lean | null | undefined): Dir => (l === "bullish_lean" ? 1 : l === "bearish_lean" ? -1 : 0);
export const signed = (n: number): string => `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(Math.round(n))}`;

/** Prices the way ATLAS says them: 4,396.79. Hand-rolled so the text never depends on the host's locale. */
export function fmtPx(n: number): string {
  const neg = n < 0;
  const [i, d] = Math.abs(n).toFixed(2).split(".");
  return `${neg ? "-" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${d}`;
}

const TF_WORD: Record<Timeframe, string> = { "1m": "1-minute", "5m": "5-minute", "15m": "15-minute", "1h": "1-hour", "4h": "4-hour", "1d": "daily" };
const stateWords = (s: string) => s.replace(/_/g, " ");
const utcHm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/**
 * The candles of one timeframe that had CLOSED by `asOf`, oldest first, de-duplicated by open time.
 * Pass the time the series was fetched as `asOf`: a candle whose end lies after the fetch is a partial
 * picture of that candle even if the clock has since passed its end, so it does not count as closed.
 */
export function closedOnly(bars: Bar[] | undefined, tf: Timeframe, asOf: number): Bar[] {
  if (!bars?.length) return [];
  const span = TF_MINUTES[tf] * 60_000;
  const byT = new Map<number, Bar>();
  for (const b of bars) {
    if (!b || ![b.t, b.o, b.h, b.l, b.c].every((x) => typeof x === "number" && Number.isFinite(x))) continue;
    if (b.t + span <= asOf) byT.set(b.t, b);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/* ── swings and structure on closed candles ──────────────────────────────────────────────────────── */

export type SwingRead = {
  tf: Timeframe;
  sequence: StructureState["sequence"];
  lastHigh: Pivot | null;
  lastLow: Pivot | null;
  /** The latest closed candle closed beyond the last confirmed swing high ("up") or low ("down"). */
  bos: "up" | "down" | null;
  /** ...and the candle before it had not: the break happened on the latest closed candle. */
  freshBos: "up" | "down" | null;
  /** The break goes against the confirmed swing sequence: a change of character. */
  choch: boolean;
  /** A close beyond a recent swing that has since closed back inside: the market tried and was refused. */
  failed: { dir: "up" | "down"; pivot: Pivot } | null;
  /** A wick beyond a recent swing with every close staying inside: liquidity taken, then rejected. */
  sweep: { dir: "up" | "down"; pivot: Pivot } | null;
  last: Bar | null;
  prev: Bar | null;
};

/**
 * Swings, breaks, failed breaks and sweeps — read from CLOSED candles only. `pivots()` cannot confirm a
 * swing until PIVOT_RIGHT later candles exist, and every candle passed here has closed, so a swing here is
 * one that a trader watching live would already have been able to see.
 */
export function swingRead(closed: Bar[], tf: Timeframe): SwingRead {
  const ps = pivots(closed, READ_RULES.PIVOT_LEFT, READ_RULES.PIVOT_RIGHT);
  const highs = ps.filter((p) => p.kind === "high");
  const lows = ps.filter((p) => p.kind === "low");
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;
  const sequence = sequenceOf(ps);
  const n = closed.length;
  const last = n ? closed[n - 1] : null;
  const prev = n > 1 ? closed[n - 2] : null;

  let bos: SwingRead["bos"] = null;
  if (last && lastHigh && last.c > lastHigh.price) bos = "up";
  else if (last && lastLow && last.c < lastLow.price) bos = "down";
  const freshBos: SwingRead["freshBos"] =
    bos === "up" && prev && lastHigh && prev.c <= lastHigh.price ? "up"
    : bos === "down" && prev && lastLow && prev.c >= lastLow.price ? "down"
    : null;
  const choch = (bos === "up" && sequence === "LH_LL") || (bos === "down" && sequence === "HH_HL");

  // Failed breaks and sweeps look at the last TWO confirmed swings on each side, because the candle that
  // broke a swing and then failed often becomes the newest swing itself two candles later.
  let failed: SwingRead["failed"] = null;
  let sweep: SwingRead["sweep"] = null;
  if (last) {
    const recent = (p: Pivot, k: number) => closed.slice(Math.max(p.i + 1, n - 1 - k), n - 1);
    for (const h of highs.slice(-2).reverse()) {
      if (last.c > h.price) continue;
      if (!failed && recent(h, READ_RULES.FAIL_LOOKBACK).some((b) => b.c > h.price)) failed = { dir: "up", pivot: h };
      const after = closed.slice(h.i + 1);
      if (!sweep && !after.some((b) => b.c > h.price) && closed.slice(Math.max(h.i + 1, n - READ_RULES.SWEEP_LOOKBACK)).some((b) => b.h > h.price)) {
        sweep = { dir: "up", pivot: h };
      }
    }
    for (const l of lows.slice(-2).reverse()) {
      if (last.c < l.price) continue;
      if (!failed && recent(l, READ_RULES.FAIL_LOOKBACK).some((b) => b.c < l.price)) failed = { dir: "down", pivot: l };
      const after = closed.slice(l.i + 1);
      if (!sweep && !after.some((b) => b.c < l.price) && closed.slice(Math.max(l.i + 1, n - READ_RULES.SWEEP_LOOKBACK)).some((b) => b.l < l.price)) {
        sweep = { dir: "down", pivot: l };
      }
    }
  }
  return { tf, sequence, lastHigh, lastLow, bos, freshBos, choch, failed, sweep, last, prev };
}

const swingRef = (tf: Timeframe, p: Pivot): EvidenceRef => ({ kind: "swing", tf, t: p.t, price: p.price, type: p.kind });
const candleRef = (tf: Timeframe, b: Bar): EvidenceRef => ({ kind: "candle", tf, t: b.t });
const levelRef = (l: { kind: string; price: number }): EvidenceRef => ({ kind: "level", levelId: levelIdOf(l), price: l.price });

/* ── the setup engine's state, mapped read-only ──────────────────────────────────────────────────── */

const STAGE: Record<SetupState, { setupStage: AtlasRead["setupStage"]; entry: AtlasRead["entry"] }> = {
  blocked: { setupStage: "none", entry: "none" },
  no_setup: { setupStage: "none", entry: "none" },
  setup_invalidated: { setupStage: "none", entry: "none" },
  setup_expired: { setupStage: "none", entry: "none" },
  watching: { setupStage: "watching", entry: "none" },
  setup_developing: { setupStage: "developing", entry: "none" },
  waiting_for_trigger: { setupStage: "developing", entry: "awaiting_confirmation" },
  // The ONLY way `entry` becomes "confirmed": the setup engine itself says the trade is ready.
  trade_ready: { setupStage: "ready", entry: "confirmed" },
};

/** Map the setup engine's state onto the read. A lean never feeds this; only the setup engine does. */
export function setupStageOf(setupState: SetupState | null | undefined, tradeActive = false): { setupStage: AtlasRead["setupStage"]; entry: AtlasRead["entry"] } {
  if (tradeActive) return { setupStage: "in_trade", entry: "none" };
  return (setupState && STAGE[setupState]) ? { ...STAGE[setupState] } : { setupStage: "none", entry: "none" };
}

/** The same read with the setup stage of a particular member's setup (the read is shared; setups are not). */
export function withSetupStage(read: AtlasRead, setupState: SetupState | null | undefined, tradeActive = false): AtlasRead {
  return { ...read, ...setupStageOf(setupState, tradeActive) };
}

/* ── inputs and outputs ──────────────────────────────────────────────────────────────────────────── */

export type ReadInput = {
  snapshot: MarketSnapshot | null;
  snapshotId?: number | null;
  /** Bars per timeframe as fetched. The forming candle may be included; it is never read. */
  bars: Partial<Record<Timeframe, Bar[]>>;
  /** When each series was fetched. Defaults to `now`. */
  barsAsOf?: Partial<Record<Timeframe, number>>;
  /** The previous read — the hysteresis state. Null (or too old) means a cold start. */
  previous?: AtlasRead | null;
  /** The setup engine's current state, read-only. */
  setup?: { state: SetupState } | null;
  tradeActive?: boolean;
  /** The clock. Defaults to the snapshot's time. */
  now?: number;
};

/** A price the read names, with what it is and a reference the chart can draw. */
export type Anchor = { price: number; label: string; ref: EvidenceRef; source: "swing15" | "swing5" | "level" | "map" };

export type ReadDetail = {
  read: AtlasRead;
  /** The support and resistance the read's invalidation / next-watch were chosen from (scenarios use them). */
  edges: { support: Anchor | null; resistance: Anchor | null };
  /** The closed candles the read was computed from. */
  closed: Partial<Record<Timeframe, Bar[]>>;
  /** The raw groups, for tests and "show me the math". */
  groups: { htf: number; momentum: number; structure: number; raw: number };
};

type Item = { group: "htf" | "momentum" | "structure" | "context"; text: string; pts: number; ref?: EvidenceRef };

/* ── the read ────────────────────────────────────────────────────────────────────────────────────── */

export function computeRead(i: ReadInput): AtlasRead {
  return computeReadDetailed(i).read;
}

export function computeReadDetailed(i: ReadInput): ReadDetail {
  const s = i.snapshot;
  const now = i.now ?? s?.at ?? 0;
  const at = s?.at ?? now;
  const R = READ_RULES;
  const W = READ_WEIGHTS;
  const stage = setupStageOf(i.setup?.state, i.tradeActive);

  // The previous read is hysteresis only while it is recent and genuinely earlier than this reading. One
  // stamped after this snapshot (an older snapshot being re-read) is not this read's past at all.
  const prevRaw = i.previous && i.previous.at <= at ? i.previous : null;
  const prevUsable = !!prevRaw && at - prevRaw.at <= R.PREVIOUS_MAX_AGE_MS;
  const prev = prevUsable ? prevRaw : null;
  const bucket = (ms: number) => Math.floor(ms / (TF_MINUTES[R.CONFIRM_TF] * 60_000));
  // A reading only CONFIRMS the previous one when a new 5-minute candle has closed in between.
  const newCandle = !!prev && bucket(at) > bucket(prev.at);

  // A read is AS OF its snapshot: only candles closed by the snapshot's time (and by the time each series
  // was fetched) are read, even when the clock passed in is later. `now` only decides staleness.
  const asOf = (tf: Timeframe) => Math.min(at, i.barsAsOf?.[tf] ?? at);
  const closed: Partial<Record<Timeframe, Bar[]>> = {};
  for (const tf of ["5m", "15m", "1h", "4h"] as Timeframe[]) closed[tf] = closedOnly(i.bars[tf], tf, asOf(tf));
  const c5 = closed["5m"] ?? [], c15 = closed["15m"] ?? [], c1h = closed["1h"] ?? [], c4h = closed["4h"] ?? [];

  /* 1 — is there enough current data to hold a lean at all? */
  const insufficient = ((): string | null => {
    if (!s) return "there is no market snapshot";
    if (s.blockers.some((b) => b.code === "market_closed") || s.session === "closed") return "gold is closed";
    if (now - s.at > R.STALE_MS) return `the latest market snapshot is ${Math.round((now - s.at) / 60_000)} minutes old`;
    const hard = s.blockers.find((b) => b.code === "feed_stale" || b.code === "feed_divergence" || b.code === "no_exec_read" || b.code === "exec_data_behind");
    if (hard) return hard.detail.charAt(0).toLowerCase() + hard.detail.slice(1);
    if (c5.length < R.MIN_CLOSED["5m"]) return "there are not enough closed 5-minute candles yet";
    const step5 = 5 * 60_000;
    const tail = c5.slice(-(R.RECENT_GAP_BARS + 1));
    for (let k = 1; k < tail.length; k++) {
      if (tail[k].t - tail[k - 1].t > step5 * 3) return "the 5-minute series has a recent gap — a feed interruption, not a quiet market";
    }
    // Three candles behind, the same allowance the snapshot builder gives the execution timeframes: a
    // series fetched a few seconds before a candle closed is normal, a quarter of an hour is not.
    if (now - (c5[c5.length - 1].t + step5) > step5 * 3) return "the newest closed 5-minute candle is more than fifteen minutes old";
    if (c15.length < R.MIN_CLOSED["15m"]) return "there are not enough closed 15-minute candles yet";
    const htfKnown = c1h.length >= R.MIN_CLOSED["1h"] || c4h.length >= R.MIN_CLOSED["4h"] || !!s.timeframes["1h"] || !!s.timeframes["4h"];
    if (!htfKnown) return "there is no higher-timeframe history to read";
    return null;
  })();

  if (insufficient) {
    const keep = prev && prev.lean === "insufficient_data";
    const read: AtlasRead = {
      version: ATLAS_READ_VERSION,
      at, snapshotId: i.snapshotId ?? null,
      horizon: "intraday", horizonTf: "15m",
      lean: "insufficient_data", strength: null, score: 0,
      htfTrend: { tf: "1h", state: "unknown", text: `No higher-timeframe read: ${insufficient}.` },
      momentum: { tf: "5m", state: "unknown", text: `No momentum read: ${insufficient}.` },
      ...stage,
      evidenceFor: [], evidenceAgainst: [],
      nextWatch: { text: insufficient === "gold is closed" ? "The reopen — the read resumes on fresh closed candles." : "Fresh market data — the read resumes when the feed does." },
      invalidation: null,
      since: keep ? prev!.since : at,
      previous: keep ? prev!.previous
        : prevRaw ? { lean: prevRaw.lean, until: prevUsable ? at : prevRaw.at, reason: `Not enough current data: ${insufficient}.` }
        : null,
      summary: insufficientSummary(insufficient, prevRaw),
    };
    return { read, edges: { support: null, resistance: null }, closed, groups: { htf: 0, momentum: 0, structure: 0, raw: 0 } };
  }
  const snap = s as MarketSnapshot;

  const items: Item[] = [];
  const add = (group: Item["group"], text: string, pts: number, ref?: EvidenceRef) => {
    if (!Number.isFinite(pts) || Math.abs(pts) < 0.05) return;
    items.push({ group, text, pts: round1(pts), ...(ref ? { ref } : {}) });
  };
  /** Group totals come from the evidence items themselves, so the score is exactly the sum of what is shown. */
  const groupSum = (g: Item["group"]) => round1(items.filter((x) => x.group === g).reduce((a, x) => a + x.pts, 0));

  const atr5 = atr(c5, 14) ?? snap.timeframes["5m"]?.features.atr ?? 0;
  const atr15 = atr(c15, 14) ?? snap.timeframes["15m"]?.features.atr ?? (atr5 > 0 ? atr5 * Math.sqrt(3) : 0);
  const last5 = c5[c5.length - 1];
  const prev5 = c5.length > 1 ? c5[c5.length - 2] : null;
  const refPx = last5.c;        // levels are chosen against the last CLOSED price, so they hold still inside a candle

  /* 2 — higher-timeframe trend: confirmed swings on closed 1h/4h candles, plus the snapshot's states. */
  const htfDetail: { tf: "1h" | "4h"; pts: number; words: string; ref?: EvidenceRef }[] = [];
  for (const tf of ["1h", "4h"] as const) {
    const cb = tf === "1h" ? c1h : c4h;
    let pts = 0;
    let words = "";
    let anchorRef: EvidenceRef | undefined;
    if (cb.length >= R.MIN_CLOSED[tf]) {
      const sw = swingRead(cb, tf);
      const seqDir: Dir = sw.sequence === "HH_HL" ? 1 : sw.sequence === "LH_LL" ? -1 : 0;
      const defining = seqDir > 0 ? sw.lastLow : seqDir < 0 ? sw.lastHigh : null;
      anchorRef = defining ? swingRef(tf, defining) : undefined;
      if (sw.choch && sw.bos) {
        const d: Dir = sw.bos === "up" ? 1 : -1;
        const broken = d > 0 ? sw.lastHigh! : sw.lastLow!;
        add("htf", `${TF_WORD[tf]} change of character: a close ${d > 0 ? "above" : "below"} the last swing ${d > 0 ? "high" : "low"} ${fmtPx(broken.price)} against its ${d > 0 ? "lower highs" : "higher highs"}`, d * W.htfChoch, swingRef(tf, broken));
        add("htf", `${TF_WORD[tf]} swings were ${seqDir > 0 ? "higher highs and higher lows" : "lower highs and lower lows"} before that break`, seqDir * W.htfSequence * 0.5, anchorRef);
        pts += d * W.htfChoch + seqDir * W.htfSequence * 0.5;
        words = `${d > 0 ? "turning up" : "turning down"} (change of character at ${fmtPx(broken.price)})`;
      } else if (seqDir !== 0) {
        add("htf", `${TF_WORD[tf]} swings are ${seqDir > 0 ? "higher highs and higher lows" : "lower highs and lower lows"}${defining ? ` (last confirmed swing ${seqDir > 0 ? "low" : "high"} ${fmtPx(defining.price)})` : ""}`, seqDir * W.htfSequence, anchorRef);
        pts += seqDir * W.htfSequence;
        words = seqDir > 0 ? "making higher highs and higher lows" : "making lower highs and lower lows";
        if (sw.bos === (seqDir > 0 ? "up" : "down")) {
          const broken = seqDir > 0 ? sw.lastHigh! : sw.lastLow!;
          add("htf", `${TF_WORD[tf]} closed ${seqDir > 0 ? "above" : "below"} its last swing ${seqDir > 0 ? "high" : "low"} ${fmtPx(broken.price)}`, seqDir * W.htfBos, swingRef(tf, broken));
          pts += seqDir * W.htfBos;
        }
      } else {
        words = sw.sequence === "mixed" ? "mixed — no clean swing sequence" : "without enough confirmed swings";
      }
    }
    const st = snap.timeframes[tf]?.state;
    if (st) {
      const d: Dir = isBullish(st) ? 1 : isBearish(st) ? -1 : 0;
      if (d !== 0) add("htf", `${TF_WORD[tf]} state is ${stateWords(st)}`, d * W.htfState);
      pts += d * W.htfState;
      if (!words) words = stateWords(st);
    }
    if (words) htfDetail.push({ tf, pts, words, ref: anchorRef });
  }
  const htf = groupSum("htf");
  const htfDir: Dir = htf >= R.HTF_DIR ? 1 : htf <= -R.HTF_DIR ? -1 : 0;
  const htfTf: "1h" | "4h" = (() => {
    const four = htfDetail.find((x) => x.tf === "4h");
    return four && htfDir !== 0 && sgn(four.pts) === htfDir && Math.abs(four.pts) >= Math.abs(htfDetail.find((x) => x.tf === "1h")?.pts ?? 0) ? "4h" : "1h";
  })();
  const htfState: AtlasRead["htfTrend"]["state"] = !htfDetail.length ? "unknown" : htfDir > 0 ? "up" : htfDir < 0 ? "down" : "range";
  const htfText = !htfDetail.length
    ? "Not enough closed higher-timeframe candles to confirm swings."
    : `${htfDetail.map((x) => `${TF_WORD[x.tf]}: ${x.words}`).join("; ")}.`.replace(/^./, (c) => c.toUpperCase());

  /* 3 — immediate momentum: the pressure proxy, the last closed candles, slope x efficiency, RSI. */
  const momBits: { pts: number; text: string }[] = [];
  const addMom = (text: string, pts: number, ref?: EvidenceRef, short?: string) => {
    add("momentum", text, pts, ref);
    if (Math.abs(pts) >= 0.5) momBits.push({ pts, text: short ?? text });
  };
  {
    const net = snap.pressure.net;
    if (Math.abs(net) >= 5) addMom(`Pressure proxy ${signed(net)} (${net > 0 ? "buyers" : "sellers"} in front)`, clampN(net / 5, -W.pressure, W.pressure), undefined, `pressure ${signed(net)}`);
    const acc = snap.pressure.acceleration;
    if (Math.abs(acc) >= 10) addMom(`Pressure ${acc > 0 ? "rising" : "falling"} (${signed(acc)} since the previous snapshot)`, sgn(acc) * W.pressureAccel, undefined, `pressure ${acc > 0 ? "rising" : "falling"}`);

    const three = c5.slice(-3);
    if (three.length === 3 && atr5 > 0 && c5.length >= 4) {
      const green = three.filter((b) => b.c > b.o).length;
      const red = three.filter((b) => b.c < b.o).length;
      const moveAtr = (three[2].c - c5[c5.length - 4].c) / atr5;
      const progress = clampN(moveAtr, -1.5, 1.5) / 1.5;
      const pts = (W.candles / 2) * ((green - red) / 3) + (W.candles / 2) * progress;
      addMom(`Last three closed 5-minute candles: ${green} up, ${red} down, net ${moveAtr >= 0 ? "+" : ""}${moveAtr.toFixed(1)} ATR`, pts, candleRef("5m", three[2]), `the last three candles pushed ${pts > 0 ? "higher" : "lower"}`);
    }
    const reg5 = regression(c5, 20), e5 = efficiency(c5, 20);
    if (reg5 && e5 != null && atr5 > 0) {
      const slopeAtr = (reg5.slope * 20) / atr5;
      addMom(`5-minute slope ${slopeAtr.toFixed(1)} ATR over 20 candles at ${e5.toFixed(2)} efficiency`, clampN(slopeAtr * e5 * 2, -W.slope5, W.slope5), undefined, `5-minute slope ${slopeAtr > 0 ? "up" : "down"}`);
    }
    const reg15 = regression(c15, 20), e15 = efficiency(c15, 20);
    if (reg15 && e15 != null && atr15 > 0) {
      const slopeAtr = (reg15.slope * 20) / atr15;
      addMom(`15-minute slope ${slopeAtr.toFixed(1)} ATR over 20 candles at ${e15.toFixed(2)} efficiency`, clampN(slopeAtr * e15 * 2.5, -W.slope15, W.slope15), undefined, `15-minute slope ${slopeAtr > 0 ? "up" : "down"}`);
    }
    const f = (r: number | null) => (r == null ? 0 : r >= 70 ? 1 : r >= 58 ? 0.6 : r <= 30 ? -1 : r <= 42 ? -0.6 : 0);
    const r15 = rsi(c15, 14), r5 = rsi(c5, 14);
    const rp = 2.5 * f(r15) + 1.5 * f(r5);
    if (Math.abs(rp) >= 0.5) addMom(`RSI ${r15 != null ? `15m ${Math.round(r15)}` : ""}${r15 != null && r5 != null ? ", " : ""}${r5 != null ? `5m ${Math.round(r5)}` : ""}`, rp, undefined, `RSI ${rp > 0 ? "firm" : "soft"}`);
  }
  const mom = groupSum("momentum");
  const momDir: Dir = mom >= R.MOM_DIR ? 1 : mom <= -R.MOM_DIR ? -1 : 0;
  const momState: AtlasRead["momentum"]["state"] = momDir > 0 ? "rising" : momDir < 0 ? "falling" : "flat";
  const momText = (() => {
    const top = [...momBits].sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)).filter((b) => momDir === 0 || sgn(b.pts) === momDir).slice(0, 2).map((b) => b.text);
    const head = `Five-minute momentum is ${momState}`;
    return top.length ? `${head}: ${top.join(", ")}.` : `${head}.`;
  })();

  /* 4 — intraday structure: breaks, changes of character, failed breaks and sweeps; key-level reclaims. */
  const addSt = (text: string, pts: number, ref?: EvidenceRef) => add("structure", text, pts, ref);
  const sw15 = swingRead(c15, "15m");
  const sw5 = swingRead(c5, "5m");
  const readTf = (sw: SwingRead, w: { choch: number; bos: number; seq: number; failed: number; sweep: number }) => {
    const tf = sw.tf;
    if (sw.bos) {
      const d: Dir = sw.bos === "up" ? 1 : -1;
      const broken = d > 0 ? sw.lastHigh! : sw.lastLow!;
      if (sw.choch) addSt(`${TF_WORD[tf]} change of character: closed ${d > 0 ? "above the last lower high" : "below the last higher low"} ${fmtPx(broken.price)}`, d * w.choch, swingRef(tf, broken));
      else addSt(`${TF_WORD[tf]} structure broke ${d > 0 ? "above" : "below"} ${fmtPx(broken.price)} on a closed candle`, d * w.bos, swingRef(tf, broken));
    } else if (sw.sequence === "HH_HL" && sw.lastLow) {
      addSt(`${TF_WORD[tf]} is holding higher lows (last ${fmtPx(sw.lastLow.price)})`, w.seq, swingRef(tf, sw.lastLow));
    } else if (sw.sequence === "LH_LL" && sw.lastHigh) {
      addSt(`${TF_WORD[tf]} is holding lower highs (last ${fmtPx(sw.lastHigh.price)})`, -w.seq, swingRef(tf, sw.lastHigh));
    }
    if (sw.failed) {
      const up = sw.failed.dir === "up";
      addSt(`${TF_WORD[tf]} break ${up ? "above" : "below"} ${fmtPx(sw.failed.pivot.price)} failed — price closed back ${up ? "below" : "above"} it`, (up ? -1 : 1) * w.failed, swingRef(tf, sw.failed.pivot));
    } else if (sw.sweep) {
      const up = sw.sweep.dir === "up";
      addSt(`${TF_WORD[tf]} swept ${up ? "above" : "below"} ${fmtPx(sw.sweep.pivot.price)} and closed back ${up ? "below" : "above"} it`, (up ? -1 : 1) * w.sweep, swingRef(tf, sw.sweep.pivot));
    }
  };
  if (c15.length >= R.MIN_CLOSED["15m"]) readTf(sw15, { choch: W.choch15, bos: W.bos15, seq: W.seq15, failed: W.failed15, sweep: W.sweep15 });
  readTf(sw5, { choch: W.choch5, bos: W.bos5, seq: W.seq5, failed: W.failed5, sweep: W.sweep5 });

  // Key levels: a closed 5-minute candle back above a level price had been under (a reclaim), or below one
  // it had been over (a loss). Today's running high/low are excluded — a close cannot reclaim a level the
  // same candles are still drawing.
  {
    const KIND_W: Partial<Record<Level["kind"], number>> = {
      pdh: W.levelMajor, pdl: W.levelMajor,
      asia_high: W.levelSession, asia_low: W.levelSession, london_high: W.levelSession, london_low: W.levelSession,
      ny_high: W.levelSession, ny_low: W.levelSession, daily_open: W.levelOpen,
    };
    const lookback = c5.slice(-(R.RECLAIM_LOOKBACK + 1), -1);
    const buffer = atr5 * R.RECLAIM_MIN_ATR;
    let best: { level: Level; d: Dir; w: number } | null = null;
    for (const l of snap.levels) {
      const w = KIND_W[l.kind];
      if (!w || !Number.isFinite(l.price)) continue;
      let d: Dir = 0;
      if (last5.c > l.price + buffer && lookback.some((b) => b.c < l.price)) d = 1;
      else if (last5.c < l.price - buffer && lookback.some((b) => b.c > l.price)) d = -1;
      if (d === 0) continue;
      if (!best || w > best.w || (w === best.w && Math.abs(l.price - refPx) < Math.abs(best.level.price - refPx))) best = { level: l, d, w };
    }
    if (best) {
      addSt(`${best.d > 0 ? "Reclaimed" : "Lost"} ${best.level.label} ${fmtPx(best.level.price)} on a closed 5-minute candle`, best.d * best.w, levelRef(best.level));
    }
  }

  const structure = groupSum("structure");

  /* 5 — context that changes conviction but never direction: ranges, chaos, news. Recorded as evidence
   *     against the side the score leans to, so the arithmetic stays visible: score = sum of the weights. */
  const sumNow = () => items.reduce((a, x) => a + x.pts, 0);
  const dampen = (factor: number, text: string) => {
    const total = sumNow();
    if (Math.abs(total) < 0.5) return;
    add("context", text, -total * (1 - factor));
  };
  const e15 = efficiency(c15, 20);
  const ranging = /sideways_range|tight_range|compression|volatility_squeeze|mean_reversion/.test(snap.regime);
  if (e15 != null && ((ranging && e15 < R.RANGE_EFFICIENCY) || e15 < 0.15)) {
    dampen(R.RANGE_DAMPEN, `Price is rotating rather than trending (15-minute efficiency ${e15.toFixed(2)})`);
  }
  if (snap.regime === "chaotic") dampen(R.CHAOS_DAMPEN, "Price action is chaotic — no clean read survives it");
  const n = snap.news;
  if (n.inLockout) dampen(R.LOCKOUT_DAMPEN, `Inside the news window${n.nextEvent ? ` around ${n.nextEvent.name}` : ""}`);
  else if (n.nextEvent && n.nextEvent.importance === "high" && n.minutesToNext != null && n.minutesToNext >= 0 && n.minutesToNext <= R.NEWS_MINUTES) {
    dampen(R.NEWS_DAMPEN, `${n.nextEvent.name} in ${Math.round(n.minutesToNext)} minutes can override any read`);
  }

  const raw = clampN(Math.round(sumNow()), -100, 100);

  /* 6 — the levels that matter: what would prove a lean wrong, and what comes next. */
  const anchors: Anchor[] = [];
  const pushA = (a: Anchor) => { if (Number.isFinite(a.price) && a.price > 0) anchors.push(a); };
  for (const [sw, src] of [[sw15, "swing15"], [sw5, "swing5"]] as const) {
    if (sw.lastHigh) pushA({ price: sw.lastHigh.price, label: `the last ${TF_WORD[sw.tf]} swing high`, ref: swingRef(sw.tf, sw.lastHigh), source: src });
    if (sw.lastLow) pushA({ price: sw.lastLow.price, label: `the last ${TF_WORD[sw.tf]} swing low`, ref: swingRef(sw.tf, sw.lastLow), source: src });
  }
  for (const l of snap.levels) pushA({ price: l.price, label: l.label, ref: levelRef(l), source: "level" });
  for (const l of snap.map ?? []) pushA({ price: l.price, label: l.label, ref: levelRef(l), source: "map" });
  const unit = atr15 > 0 ? atr15 : Math.max(atr5, 0.5);
  const side = (d: Dir) => anchors
    .filter((a) => (d > 0 ? a.price > refPx : a.price < refPx))
    .sort((a, b) => Math.abs(a.price - refPx) - Math.abs(b.price - refPx));
  /** Structural: the level whose break means the market has changed, not a hair trigger. */
  const structural = (d: Dir): Anchor | null => {
    const c = side(d).filter((a) => Math.abs(a.price - refPx) >= unit * R.INVALIDATION_MIN_ATR);
    const within = c.filter((a) => Math.abs(a.price - refPx) <= unit * R.STRUCTURAL_MAX_ATR);
    return within.find((a) => a.source === "swing15") ?? within.find((a) => a.source === "level")
      ?? within.find((a) => a.source === "swing5") ?? within[0] ?? c[0] ?? side(d)[0] ?? null;
  };
  /** Next: the nearest level ahead that is not right on top of price. */
  const nextAhead = (d: Dir): Anchor | null => {
    const c = side(d).filter((a) => a.source !== "map" || side(d).every((x) => x.source === "map"));
    return c.find((a) => Math.abs(a.price - refPx) >= unit * R.NEXT_MIN_ATR) ?? c[0] ?? null;
  };
  /*
   * LEVELS HOLD STILL. A level the previous read named is kept while the last closed candle is still on
   * its side of it. Without this, a level chosen "at least half an ATR away" would step further away every
   * time price approached it — moving the goalposts, and re-opening every scenario built on it.
   */
  const prevEdges = edgesOfRead(prev);
  const known = (price: number, ref: EvidenceRef | undefined, d: Dir): Anchor =>
    anchors.find((a) => Math.abs(a.price - price) < 0.005)
    ?? { price, label: `the ${d > 0 ? "resistance" : "support"} already in play`, ref: ref ?? { kind: "zone", from: price, to: price, label: "level from the previous read" }, source: "level" };
  // A named level stays named until a 15-minute candle — the read's horizon — CLOSES through it.
  const close15 = c15.length ? c15[c15.length - 1].c : refPx;
  const held = (d: Dir): Anchor | null => {
    const e = d > 0 ? prevEdges.resistance : prevEdges.support;
    if (!e || !(d > 0 ? e.price > close15 : e.price < close15)) return null;
    return known(e.price, e.ref, d);
  };
  /**
   * Support/resistance for a read with no side: the previous RANGE edges while unbroken and still within
   * reach (a directional lean's far "next" level is not a range edge), else structural ones.
   */
  const rangeEdge = (d: Dir): Anchor | null => {
    const fromRange = prev?.lean === "balanced" || prev?.lean === "transitioning";
    const h = fromRange ? held(d) : null;
    return h && Math.abs(h.price - refPx) <= unit * R.STRUCTURAL_MAX_ATR ? h : structural(d);
  };

  /* 7 — the lean, with hysteresis. */
  /*
   * TRANSITIONING: the higher-timeframe trend and five-minute momentum disagree, AND a structure event is
   * pending — the level that would complete momentum's turn is within PENDING_ATR, or the 5-minute has
   * already broken structure that way while the 15-minute has not. Once in it, the read stays transitioning
   * until momentum sides with the trend again or the evidence becomes decisive; momentum merely pausing
   * (flat for a reading) does not end it.
   */
  const transition = (() => {
    const none = { cond: false, stay: false, pending: null as Anchor | null, other: null as Anchor | null };
    if (htfDir === 0) return none;
    const turn = -htfDir as Dir;                     // momentum is trying to turn the structure against the trend
    const disagree = momDir === turn;
    const stay = prev?.lean === "transitioning" && momDir !== htfDir && Math.abs(raw) < R.ENTER;
    if (!disagree && !stay) return none;
    const pending = rangeEdge(turn);
    const near = !!pending && Math.abs(pending.price - refPx) <= unit * R.PENDING_ATR;
    const fiveBroke = sw5.bos === (turn > 0 ? "up" : "down") && sw15.bos !== sw5.bos;
    return { cond: disagree && (near || fiveBroke) && Math.abs(raw) < R.ENTER, stay, pending, other: rangeEdge(htfDir) };
  })();

  // Decisive event 2: the latest closed 5-minute candle closed through the last confirmed 15-minute swing.
  const d2: Dir = (() => {
    if (!prev5) return 0;
    if (sw15.lastHigh && last5.c > sw15.lastHigh.price && prev5.c <= sw15.lastHigh.price) return 1;
    if (sw15.lastLow && last5.c < sw15.lastLow.price && prev5.c >= sw15.lastLow.price) return -1;
    return 0;
  })();
  const d2Text = (d: Dir) => {
    const p = d > 0 ? sw15.lastHigh! : sw15.lastLow!;
    return `a 5-minute candle closed ${d > 0 ? "above" : "below"} the last 15-minute swing ${d > 0 ? "high" : "low"} at ${fmtPx(p.price)}`;
  };

  const { ENTER, EXIT, COLD_ENTER } = R;
  const prevDir = dirOfLean(prev?.lean);
  let lean: Lean;
  let why: string | null = null;
  let pressured = false;          // a held lean whose evidence has slipped below the hold threshold once
  if (prev && prevDir !== 0) {
    const d = prevDir;
    const inv = prev.invalidation?.price ?? null;
    // Decisive event 1: a 15-minute candle that closed after the lean began closed through the level the
    // lean itself named as its invalidation. (15 minutes is the read's horizon; a 5-minute poke is not.)
    const last15 = c15.length ? c15[c15.length - 1] : null;
    const brokeInv = inv != null && !!last15 && last15.t + 15 * 60_000 > prev.since && (d > 0 ? last15.c < inv : last15.c > inv);
    if (brokeInv) {
      lean = raw * -d >= ENTER ? leanOf(-d as Dir) : transition.cond ? "transitioning" : "balanced";
      why = `A 15-minute candle closed ${d > 0 ? "below" : "above"} ${fmtPx(inv!)} at ${fmtPx(last15!.c)}, the level the ${d > 0 ? "bullish" : "bearish"} lean depended on.`;
    } else if (d2 === -d && raw * -d >= ENTER) {
      lean = leanOf(-d as Dir);
      why = `Structure turned: ${d2Text(-d as Dir)}, and the evidence agrees (${signed(raw)}).`;
    } else if (raw * d >= EXIT) {
      lean = prev.lean;
    } else if (newCandle && prev.score * d < EXIT) {
      lean = raw * -d >= ENTER && prev.score * -d >= ENTER ? leanOf(-d as Dir) : transition.cond ? "transitioning" : "balanced";
      why = `The case for the ${d > 0 ? "bullish" : "bearish"} lean faded: the evidence was ${signed(prev.score)} and is now ${signed(raw)}, below the ${EXIT} it needs to hold, on two readings.`;
    } else {
      lean = prev.lean;          // one reading below the hold threshold is noise until the next candle confirms it
      pressured = true;
    }
  } else {
    const d: Dir = raw >= ENTER ? 1 : raw <= -ENTER ? -1 : 0;
    // The reading on which a lean ENDED cannot also be the first of the two readings that bring the same
    // lean back: a lean its own rules just retired needs two fresh readings (or a new structure break).
    const justEnded = !!prev && prev.since === prev.at && prev.previous?.lean === leanOf(d);
    if (d !== 0 && d2 === d) {
      lean = leanOf(d);
      why = `Structure confirmed it: ${d2Text(d)}, with the evidence at ${signed(raw)}.`;
    } else if (d !== 0 && prev && newCandle && prev.score * d >= ENTER && !justEnded) {
      lean = leanOf(d);
      why = `The evidence held ${d > 0 ? "above +" : "below -"}${ENTER} on two closed candles (${signed(prev.score)}, then ${signed(raw)}).`;
    } else if (d !== 0 && !prev && Math.abs(raw) >= COLD_ENTER) {
      lean = leanOf(d);
      why = `With no earlier read to confirm it, the evidence is one-sided enough on its own (${signed(raw)}).`;
    } else if (transition.cond || transition.stay) {
      lean = "transitioning";
    } else {
      lean = "balanced";
    }
  }
  if (prev && lean !== prev.lean && !why) {
    why = prev.lean === "insufficient_data" ? "The data is usable again."
      : lean === "transitioning" ? `The ${TF_WORD[htfTf]} trend and five-minute momentum now disagree${transition.pending ? `, and ${fmtPx(transition.pending.price)} decides it` : ""}.`
      : Math.abs(raw) >= ENTER ? `The evidence tilted ${raw > 0 ? "up" : "down"} (${signed(raw)}); it needs one more closed candle to count as a lean.`
      : `Neither side has enough evidence (${signed(raw)}).`;
  }
  if (prev && prev.lean === "insufficient_data" && lean !== prev.lean && why && !why.startsWith("The data")) why = `The data is usable again. ${why}`;

  const leanDir = dirOfLean(lean);
  const strength: AtlasRead["strength"] = leanDir === 0 ? null
    : raw * leanDir >= R.STRENGTH_STRONG ? "strong" : raw * leanDir >= R.STRENGTH_CLEAR ? "clear" : "slight";

  /* 8 — invalidation, next watch, and the edges the scenarios are built on. */
  let invalidation: AtlasRead["invalidation"] = null;
  let nextWatch: AtlasRead["nextWatch"] = null;
  let support: Anchor | null = null, resistance: Anchor | null = null;
  if (leanDir !== 0) {
    // A HELD lean's invalidation only ever tightens: it trails toward price as structure confirms behind
    // it, and never steps away as price approaches it. A NEW lean picks a structural level afresh.
    const fresh = structural(-leanDir as Dir);
    const isHeld = !!prev && prev.lean === lean;
    const kept = isHeld ? held(-leanDir as Dir) : null;
    const inv = kept && (!fresh || (leanDir > 0 ? fresh.price <= kept.price : fresh.price >= kept.price)) ? kept : fresh;
    // What it is watching next also holds still until price closes through it.
    const nxt = (isHeld ? held(leanDir) : null) ?? nextAhead(leanDir);
    if (inv) invalidation = { text: `A 15-minute close ${leanDir > 0 ? "below" : "above"} ${fmtPx(inv.price)} (${inv.label}) ends the ${leanDir > 0 ? "bullish" : "bearish"} lean.`, price: inv.price, ref: inv.ref };
    if (nxt) nextWatch = { text: `${leanDir > 0 ? "Acceptance above" : "Acceptance below"} ${fmtPx(nxt.price)} (${nxt.label}) would extend it.`, ref: nxt.ref };
    support = leanDir > 0 ? inv : nxt;
    resistance = leanDir > 0 ? nxt : inv;
  } else if (lean === "transitioning" && transition.pending) {
    const p = transition.pending, q = transition.other;
    const up = p.price > refPx;
    nextWatch = { text: `A 15-minute close ${up ? "above" : "below"} ${fmtPx(p.price)} (${p.label}) would complete the turn ${up ? "up" : "down"}.`, ref: p.ref };
    if (q) invalidation = { text: `A 15-minute close ${up ? "below" : "above"} ${fmtPx(q.price)} (${q.label}) puts the ${TF_WORD[htfTf]} trend back in charge.`, price: q.price, ref: q.ref };
    support = up ? q : p;
    resistance = up ? p : q;
  } else {
    support = rangeEdge(-1);
    resistance = rangeEdge(1);
    if (support && resistance) {
      nextWatch = {
        text: `A 15-minute close above ${fmtPx(resistance.price)} (${resistance.label}) or below ${fmtPx(support.price)} (${support.label}) settles it.`,
        ref: { kind: "zone", from: support.price, to: resistance.price, label: "the range ATLAS is watching" },
      };
    } else if (support || resistance) {
      const a = (support ?? resistance)!;
      nextWatch = { text: `A 15-minute close ${a === resistance ? "above" : "below"} ${fmtPx(a.price)} (${a.label}).`, ref: a.ref };
    }
  }

  /* 9 — evidence lists, relative to the lean (for balanced/transitioning: relative to the side the score tilts to). */
  const forDir: Dir = leanDir !== 0 ? leanDir : raw >= 0 ? 1 : -1;
  const toEvidence = (x: Item): Evidence => ({ text: x.text, weight: Math.round(Math.abs(x.pts) * 10) / 10, ...(x.ref ? { ref: x.ref } : {}) });
  const ranked = [...items].sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts));
  /** The biggest items, and the rest folded into one line — so the weights shown always add up to the score. */
  const listOf = (d: Dir): Evidence[] => {
    const all = ranked.filter((x) => sgn(x.pts) === d);
    if (all.length <= R.EVIDENCE_MAX) return all.map(toEvidence);
    const rest = all.slice(R.EVIDENCE_MAX - 1);
    const w = Math.round(rest.reduce((a, x) => a + Math.abs(x.pts), 0) * 10) / 10;
    return [...all.slice(0, R.EVIDENCE_MAX - 1).map(toEvidence), { text: `${rest.length} smaller signals on this side`, weight: w }];
  };
  const evidenceFor = listOf(forDir);
  const evidenceAgainst = listOf(-forDir as Dir);

  /* 10 — continuity: when this lean began, and what it replaced. */
  const unchanged = !!prev && lean === prev.lean;
  const since = unchanged ? prev!.since : at;
  const previous: AtlasRead["previous"] = unchanged ? prev!.previous
    : prev ? { lean: prev.lean, until: at, reason: why ?? "The read changed." }
    : prevRaw ? { lean: prevRaw.lean, until: prevRaw.at, reason: `The last read was ${Math.round((at - prevRaw.at) / 60_000)} minutes old, so this one started fresh.` }
    : null;

  const contextItem = items.filter((x) => x.group === "context").sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))[0];
  const context = contextItem && Math.abs(contextItem.pts) >= 5
    ? contextItem.text.replace(/ \(15-minute efficiency [\d.]+\)$/, "").replace(/ — no clean read survives it$/, "").replace(/ can override any read$/, " can override this")
    : null;
  const summary = summarize({
    lean, leanDir, raw, htfState, momState, pressured,
    invalidation, support, resistance, pending: transition.pending, other: transition.other, context,
  });

  const read: AtlasRead = {
    version: ATLAS_READ_VERSION,
    at,
    snapshotId: i.snapshotId ?? null,
    horizon: "intraday",
    horizonTf: "15m",
    lean,
    strength,
    score: raw,
    htfTrend: { tf: htfTf, state: htfState, text: htfText },
    momentum: { tf: "5m", state: momState, text: momText },
    ...stage,
    evidenceFor,
    evidenceAgainst,
    nextWatch,
    invalidation,
    since,
    previous,
    summary,
  };
  return { read, edges: { support, resistance }, closed, groups: { htf: round1(htf), momentum: round1(mom), structure: round1(structure), raw } };
}

/* ── ATLAS's sentence ────────────────────────────────────────────────────────────────────────────── */

function insufficientSummary(reason: string, prev: AtlasRead | null): string {
  // Through a long outage or a weekend, the last real lean is carried in `previous`: still say it.
  const d = dirOfLean(prev?.lean) || (prev?.lean === "insufficient_data" ? dirOfLean(prev.previous?.lean) : 0);
  const before = d !== 0 ? ` Before that, my intraday lean was ${d > 0 ? "up" : "down"}.` : "";
  if (reason === "gold is closed") return `Gold is closed, so I'm not holding a live intraday lean.${d !== 0 ? ` Going into the close it was ${d > 0 ? "up" : "down"}.` : ""}`;
  return `I don't have enough current data to hold a lean: ${reason}.${before}`;
}

/**
 * read → reason → what matters next, from a fixed template. Deterministic on purpose: the words are part of
 * the read, so the same market must produce the same sentence.
 */
function summarize(x: {
  lean: Lean; leanDir: Dir; raw: number;
  htfState: AtlasRead["htfTrend"]["state"]; momState: AtlasRead["momentum"]["state"]; pressured: boolean;
  invalidation: AtlasRead["invalidation"]; support: Anchor | null; resistance: Anchor | null;
  pending: Anchor | null; other: Anchor | null;
  /** The biggest conviction-reducing condition (rotation, chaos, news), already phrased, when it matters. */
  context: string | null;
}): string {
  const htfD: Dir = x.htfState === "up" ? 1 : x.htfState === "down" ? -1 : 0;
  const momD: Dir = x.momState === "rising" ? 1 : x.momState === "falling" ? -1 : 0;
  // The five-minute clause answers the clause before it: it agrees with, or pushes against, the broader
  // structure when that has a direction; otherwise it simply says what the five-minute chart is doing.
  const refD: Dir = htfD;
  const htfWord = htfD > 0 ? "bullish" : "bearish";

  let first: string;
  if (htfD !== 0) {
    first = x.leanDir !== 0 && x.leanDir === htfD ? `The broader structure remains ${htfWord}`
      : x.leanDir !== 0 ? `The broader structure is still ${htfWord}`
      : `The broader structure is ${htfWord}`;
  } else if (x.htfState === "range") first = "Higher timeframes are ranging";
  else first = "Higher-timeframe swings aren't confirmed yet";

  let mom = "";
  if (x.momState !== "unknown") {
    if (refD !== 0) {
      mom = momD === refD ? ", and the five-minute chart agrees"
        : momD === -refD ? `, but the five-minute chart is ${momD > 0 ? "recovering" : "slipping"}`
        : ", and the five-minute chart is quiet";
    } else {
      mom = momD > 0 ? ", and the five-minute chart is pushing higher" : momD < 0 ? ", and the five-minute chart is drifting lower" : ", and the five-minute chart is quiet";
    }
  }
  const s1 = `${first}${mom}.`;

  const inv = x.invalidation?.price != null ? fmtPx(x.invalidation.price) : null;
  let s2: string;
  if (x.lean === "bullish_lean" || x.lean === "bearish_lean") {
    const up = x.lean === "bullish_lean";
    const against = momD === -x.leanDir;
    if (x.pressured) {
      s2 = `My intraday lean is still ${up ? "up" : "down"}, but the evidence has turned against it — one more closed candle like this and it changes${inv ? `; ${inv} is the line` : ""}.`;
    } else if (against) {
      s2 = inv ? `My intraday lean is still ${up ? "up" : "down"} unless ${inv} ${up ? "gives way" : "is reclaimed"}.` : `My intraday lean is still ${up ? "up" : "down"}.`;
    } else if (htfD === -x.leanDir) {
      s2 = inv ? `My intraday lean is ${up ? "up" : "down"} against the bigger trend, while ${up ? `${inv} holds` : `price stays below ${inv}`}.` : `My intraday lean is ${up ? "up" : "down"} against the bigger trend.`;
    } else {
      const next = up ? x.resistance : x.support;
      s2 = inv
        ? `My intraday lean is ${up ? "up" : "down"} while ${up ? `${inv} holds` : `price stays below ${inv}`}${next ? `; next I'm watching ${fmtPx(next.price)}` : ""}.`
        : `My intraday lean is ${up ? "up" : "down"}.`;
    }
  } else if (x.lean === "transitioning" && x.pending) {
    // The pending level sits on momentum's side: momentum is what is trying to turn the structure.
    const up = momD !== 0 ? momD > 0 : x.pending.price > (x.other?.price ?? x.pending.price - 1);
    const turn = `a close ${up ? "above" : "below"} ${fmtPx(x.pending.price)} would turn my lean ${up ? "up" : "down"}`;
    const back = x.other ? `, a close ${up ? "below" : "above"} ${fmtPx(x.other.price)} keeps it ${up ? "down" : "up"}` : "";
    s2 = `That's a transition, not a trend yet: ${turn}${back}.`;
  } else {
    const tilt: Dir = x.raw >= READ_RULES.ENTER ? 1 : x.raw <= -READ_RULES.ENTER ? -1 : 0;
    const zone = x.support && x.resistance ? `${fmtPx(x.support.price)}–${fmtPx(x.resistance.price)}` : null;
    if (tilt !== 0) s2 = `The evidence has just tilted ${tilt > 0 ? "up" : "down"}, but I want one more closed candle before I call it a lean.`;
    else if (x.context && zone) s2 = `${x.context}, so I'm neutral until a close outside ${zone}.`;
    else if (zone) s2 = `I'm neutral between ${fmtPx(x.support!.price)} and ${fmtPx(x.resistance!.price)} until a close outside that range.`;
    else s2 = x.context ? `${x.context}, so I'm not taking a side yet.` : "I'm not taking a side yet.";
  }
  return `${s1} ${s2}`;
}

/**
 * The support and resistance a read stands on, recovered from its own references (prices only — nothing
 * is invented). Bullish: invalidation below, next watch above. Bearish: the reverse. Balanced: the zone it
 * is watching. Transitioning: the deciding level and the trend's level, ordered by price.
 */
export function edgesOfRead(r: AtlasRead | null | undefined): {
  support: { price: number; ref?: EvidenceRef } | null;
  resistance: { price: number; ref?: EvidenceRef } | null;
} {
  const none = { support: null, resistance: null };
  if (!r) return none;
  const px = (ref?: EvidenceRef): number | null => (ref && (ref.kind === "level" || ref.kind === "swing") ? ref.price : null);
  const inv = r.invalidation?.price != null && Number.isFinite(r.invalidation.price) ? { price: r.invalidation.price, ...(r.invalidation.ref ? { ref: r.invalidation.ref } : {}) } : null;
  const nwPx = px(r.nextWatch?.ref);
  const nw = nwPx != null ? { price: nwPx, ref: r.nextWatch!.ref } : null;
  switch (r.lean) {
    case "bullish_lean": return { support: inv, resistance: nw };
    case "bearish_lean": return { support: nw, resistance: inv };
    case "balanced": {
      const z = r.nextWatch?.ref;
      return z?.kind === "zone" && z.from < z.to ? { support: { price: z.from }, resistance: { price: z.to } } : none;
    }
    case "transitioning":
      if (!inv || !nw) return none;
      return nw.price > inv.price ? { support: inv, resistance: nw } : { support: nw, resistance: inv };
    default: return none;
  }
}

/**
 * A stored read, checked before it is trusted as hysteresis state. Anything that does not look like a read
 * of this version is treated as absent — a cold start is safe, a malformed previous read is not.
 */
export function readFromStored(raw: unknown): AtlasRead | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AtlasRead>;
  const leans: Lean[] = ["bullish_lean", "bearish_lean", "balanced", "transitioning", "insufficient_data"];
  if (r.version !== ATLAS_READ_VERSION || !leans.includes(r.lean as Lean)) return null;
  if (typeof r.at !== "number" || typeof r.since !== "number" || typeof r.score !== "number" || typeof r.summary !== "string") return null;
  if (!Array.isArray(r.evidenceFor) || !Array.isArray(r.evidenceAgainst)) return null;
  return r as AtlasRead;
}

/** For the conversation: the time a candle closed, said plainly. */
export const closeTimeWords = (tf: Timeframe, t: number): string => `${utcHm(t + TF_MINUTES[tf] * 60_000)} UTC`;
