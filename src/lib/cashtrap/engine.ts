import { atr as atrSeries, bollinger, rsi as rsiSeries, sma, stochastic } from "./indicators";
import { closeOf, checkHistory, M5, type Candle, type DataCheck } from "./candles";
import { dmiStochastic, type DmiEvent, type DmiMode } from "./dmi";
import { autoZonesAt, contributingZone, manualBreaks, manualZonesAt, type ManualZoneInput, type Zone } from "./zones";
import { isOpen } from "./marketHours";
import { SCREENSHOT_SETTINGS, type EffectiveConfig } from "./config";
import { fmtPrice, SYMBOL_SPECS, type CashtrapSymbol } from "./symbols";

/**
 * THE CASHTRAP ENGINE — one deterministic step per completed 5-minute candle, used unchanged by the
 * live service and by historical replay. Given the same candles, zones, DMI events and configuration
 * it makes the same decision, to the bit: every decision recomputes its indicators over exactly the
 * same trailing window of candles (config.data.windowCandles), so it never depends on when the
 * process started.
 *
 * THE SETUP, exactly as specified:
 *   An EXHAUSTION candle is a completed candle where, at its close —
 *     BUY:  low below the lower Bollinger Band (or close, if configured), RSI(4) < 20, Stochastic %K < 20,
 *           its range touches/overlaps a valid support zone, and it closes at or above that zone's lower edge.
 *     SELL: high above the upper band (or close), RSI(4) > 80, %K > 80, its range touches a valid
 *           resistance zone, and it closes at or below that zone's upper edge.
 *   (These are values at the candle's close; nothing is claimed about when inside the candle each happened.)
 *   It ARMS a setup. A fresh matching DMI event — B for BUY, S for SELL — on that candle or either of the
 *   next `dmiWindowCandles` completed candles CONFIRMS it. RSI and Stochastic need not stay extreme.
 *   It is CANCELLED by: an opposite DMI event; a BUY candle closing below its support zone (SELL: above
 *   its resistance zone); an opposite exhaustion; invalid or stale data. It EXPIRES when the window ends.
 *   Both directions qualifying at once is ambiguous: WAIT, with the reason.
 *   No engulfing, no crossover, no trend filter, no close-back-inside-the-band requirement.
 *
 * DUPLICATES AND RESETS: one armed setup per symbol at a time; an exhaustion in the direction already
 * armed is part of that setup, not a new one; after a setup arms, that direction needs its conditions
 * to RESET (config.resetRule) before another exhaustion can arm; while a published signal's window is
 * open (entry deadline + expiry), a new confirmation on the symbol is recorded but not published.
 *
 * NOT PUBLISHED (recorded with the reason, and blocking nothing): a confirmation decided more than
 * `maxPublishLagMs` after its candle closed (the runner was down — a late signal is never sent), or one
 * whose publication or expiry falls while the market is closed (it could not be entered or settled).
 */
export type Direction = "BUY" | "SELL";
export const callPut = (d: Direction): "CALL" | "PUT" => (d === "BUY" ? "CALL" : "PUT");

export type Values = {
  t: number; open: number; high: number; low: number; close: number;
  bbBasis: number | null; bbUpper: number | null; bbLower: number | null;
  rsi: number | null; rsiMa: number | null;
  stochK: number | null; stochD: number | null;
  atr: number | null;
  dmiStoch: number | null; dmiStochPrev: number | null;
};

/** The five conditions for one direction. `dmi` is null when DMI events are unavailable. */
export type Checklist = { band: boolean; rsi: boolean; stoch: boolean; zone: boolean; dmi: boolean | null };
export const metCount = (c: Checklist): number => [c.band, c.rsi, c.stoch, c.zone, c.dmi === true].filter(Boolean).length;

export type CandleEval = {
  values: Values;
  dmiEvent: "B" | "S" | null;
  dmiBoth: boolean;
  zones: Zone[] | null;
  buy: { checklist: Checklist; zone: Zone | null; exhaustion: boolean };
  sell: { checklist: Checklist; zone: Zone | null; exhaustion: boolean };
};

export type ZoneSnap = { id: string; kind: Zone["kind"]; origin: Zone["origin"]; lower: number; upper: number; center: number; createdAt: number; pivotT: number | null; halfWidth: number | null; atrAtCreation: number | null };
export const snapZone = (z: Zone): ZoneSnap => ({ id: z.id, kind: z.kind, origin: z.origin, lower: z.lower, upper: z.upper, center: z.center, createdAt: z.createdAt, pivotT: z.pivotT, halfWidth: z.halfWidth, atrAtCreation: z.atrAtCreation });

export type ArmedSetup = {
  id: string;
  symbol: CashtrapSymbol;
  direction: Direction;
  exhaustionT: number;
  armedAt: number;
  /** Completed candles evaluated since the exhaustion candle (0 on the exhaustion candle). */
  seen: number;
  /** The zone that confirmed the exhaustion (null only when requireZone is switched off and none qualified). */
  zone: ZoneSnap | null;
  values: Values;
  checklist: Checklist;
};

export type EngineState = {
  v: 1;
  symbol: CashtrapSymbol;
  lastT: number | null;
  armed: ArmedSetup | null;
  needsReset: { BUY: boolean; SELL: boolean };
  /** A published signal's window: no new signal on the symbol before `until`. */
  activeSignal: { setupId: string; direction: Direction; until: number } | null;
  /** Manual zones broken by a completed close (zone id → close time and price), remembered beyond the window. */
  manualBroken?: Record<string, { at: number; close: number }>;
};

/** Manual zones with the breaks the engine remembers applied (the earlier break wins). */
export function withBreaks(manual: ManualZoneInput[], state: Pick<EngineState, "manualBroken">): ManualZoneInput[] {
  const b = state.manualBroken;
  if (!b) return manual;
  return manual.map((z) => {
    const x = b[z.id];
    if (!x || (z.invalidatedAt != null && z.invalidatedAt <= x.at)) return z;
    return { ...z, invalidatedAt: x.at, invalidatedByClose: x.close };
  });
}

/** A fed DMI event must have arrived after its candle closed (allowing this much clock difference): an alert fired mid-candle is not a completed-candle event. */
export const DMI_EVENT_EARLY_MS = 1_500;

export const initialState = (symbol: CashtrapSymbol): EngineState => ({ v: 1, symbol, lastT: null, armed: null, needsReset: { BUY: false, SELL: false }, activeSignal: null });

export type Confirmation = {
  setup: ArmedSetup;
  confirmT: number;          // open time of the candle carrying the DMI event
  confirmedAt: number;       // close of that candle — when the confirmation exists
  decidedAt: number;
  dmiType: "B" | "S";
  values: Values;            // at the confirming candle
};

export type EngineEvent =
  | { type: "armed"; setup: ArmedSetup }
  | { type: "confirmed"; confirmation: Confirmation; publish: boolean; suppressedReason: string | null }
  | { type: "cancelled"; setup: ArmedSetup; reason: string; at: number }
  | { type: "expired"; setup: ArmedSetup; reason: string; at: number };

export type DecisionStatus = "WAIT" | "ARMED" | "CONFIRMED" | "DATA_UNAVAILABLE";
export type Decision = {
  symbol: CashtrapSymbol;
  candleT: number;
  decidedAt: number;
  status: DecisionStatus;
  direction: Direction | null;
  leading: Direction | null;
  checklist: { BUY: Checklist; SELL: Checklist } | null;
  met: number;
  reasonCode: string;
  reason: string;
  values: Values | null;
  zoneId: string | null;
  setupId: string | null;
  strategyVersion: string;
  configVersion: string;
};

export type StepInput = {
  /** Completed candles, oldest → newest; the LAST one is the candle being decided. Only the trailing window is used. */
  candles: Candle[];
  manualZones: ManualZoneInput[];
  dmiMode: DmiMode;
  dmiAvailable: boolean;
  /** For "event-feed" mode: received events (only those known by `decidedAt` and on this candle are used). */
  externalEvents?: DmiEvent[];
  decidedAt: number;
  config: EffectiveConfig;
  /** Live only: the feed is stale or broken beyond this candle (forces a data cancellation). */
  dataOverride?: DataCheck;
};

export type StepOutput = { state: EngineState; decision: Decision; events: EngineEvent[]; evaluation: CandleEval | null };

/* ── evaluation of one candle ─────────────────────────────────────────────────────────────────── */

/** The trailing calculation window ending at (and including) the last candle. */
export function trailingWindow(candles: Candle[], windowCandles: number): Candle[] {
  return candles.length > windowCandles ? candles.slice(candles.length - windowCandles) : candles;
}

/**
 * Indicator values, DMI event and both directions' conditions for the LAST candle of `win`, with
 * zones known at that candle's open. `withZones` = false skips zone search when no extreme exists.
 */
export function evaluateLast(symbol: CashtrapSymbol, win: Candle[], cfg: EffectiveConfig, manual: ManualZoneInput[], dmi: { mode: DmiMode; available: boolean; external?: DmiEvent[]; knownBy: number }): CandleEval {
  const S = SCREENSHOT_SETTINGS;
  const A = cfg.assumptions;
  const e = win.length - 1;
  const close = win.map((k) => k.c), high = win.map((k) => k.h), low = win.map((k) => k.l);
  const bb = bollinger(close, S.bollinger.length, S.bollinger.stdDevMult);
  const r = rsiSeries(close, S.rsi.length);
  const rMa = sma(r, S.rsiMa.length);
  const st = stochastic(close, high, low, S.stochastic.kLength, S.stochastic.kSmoothing, S.stochastic.dSmoothing);
  const at = atrSeries(high, low, close, A.zones.atrLength);
  const k = win[e];
  let dmiStoch: number | null = null, dmiPrev: number | null = null, dmiEvent: "B" | "S" | null = null, dmiBoth = false;
  if (dmi.mode === "calculation") {
    const d = dmiStochastic(high, low, close, S.dmiStochastic.dmiLength, S.dmiStochastic.stoLength);
    dmiStoch = d.stoch[e]; dmiPrev = e > 0 ? d.stoch[e - 1] : null;
    dmiBoth = d.buy[e] && d.sell[e];
    dmiEvent = dmiBoth ? null : d.buy[e] ? "B" : d.sell[e] ? "S" : null;
  } else if (dmi.mode === "event-feed") {
    const mine = (dmi.external ?? []).filter((ev) => ev.symbol === symbol && ev.candleT === k.t && ev.knownAt <= dmi.knownBy && ev.knownAt >= closeOf(k.t) - DMI_EVENT_EARLY_MS);
    const hasB = mine.some((ev) => ev.type === "B"), hasS = mine.some((ev) => ev.type === "S");
    dmiBoth = hasB && hasS;
    dmiEvent = dmiBoth ? null : hasB ? "B" : hasS ? "S" : null;
  }
  const values: Values = {
    t: k.t, open: k.o, high: k.h, low: k.l, close: k.c,
    bbBasis: bb.basis[e], bbUpper: bb.upper[e], bbLower: bb.lower[e],
    rsi: r[e], rsiMa: rMa[e], stochK: st.k[e], stochD: st.d[e], atr: at[e],
    dmiStoch, dmiStochPrev: dmiPrev,
  };
  const bandBuy = values.bbLower != null && (A.bandExcursion === "wick" ? k.l < values.bbLower : k.c < values.bbLower);
  const bandSell = values.bbUpper != null && (A.bandExcursion === "wick" ? k.h > values.bbUpper : k.c > values.bbUpper);
  const rsiBuy = values.rsi != null && values.rsi < S.rsi.lower;
  const rsiSell = values.rsi != null && values.rsi > S.rsi.upper;
  const stBuy = values.stochK != null && values.stochK < S.stochastic.lower;
  const stSell = values.stochK != null && values.stochK > S.stochastic.upper;
  // Zones are looked for only where they could matter (an extreme on either side) — the result is the same either way.
  const wantZones = (bandBuy || rsiBuy || stBuy || bandSell || rsiSell || stSell);
  const zones = wantZones ? [...autoZonesAt(symbol, win, at, e, A.zones), ...manualZonesAt(manual, win, e, A.zones)] : null;
  const zBuy = zones ? contributingZone(zones, k, "BUY") : null;
  const zSell = zones ? contributingZone(zones, k, "SELL") : null;
  const dmiFlag = (want: "B" | "S"): boolean | null => (dmi.available ? dmiEvent === want : null);
  const buyCl: Checklist = { band: bandBuy, rsi: rsiBuy, stoch: stBuy, zone: zBuy != null, dmi: dmiFlag("B") };
  const sellCl: Checklist = { band: bandSell, rsi: rsiSell, stoch: stSell, zone: zSell != null, dmi: dmiFlag("S") };
  const ex = (c: Checklist) => c.band && c.rsi && c.stoch && (A.requireZone ? c.zone : true);
  return {
    values, dmiEvent, dmiBoth, zones,
    buy: { checklist: buyCl, zone: zBuy, exhaustion: ex(buyCl) && (A.requireZone ? zBuy != null : true) },
    sell: { checklist: sellCl, zone: zSell, exhaustion: ex(sellCl) && (A.requireZone ? zSell != null : true) },
  };
}

/** Has this direction's extension cleared on this candle (resetRule)? */
function cleared(ev: CandleEval, dir: Direction, rule: "all-cleared" | "any-cleared"): boolean {
  const c = dir === "BUY" ? ev.buy.checklist : ev.sell.checklist;
  return rule === "all-cleared" ? !c.band && !c.rsi && !c.stoch : !c.band || !c.rsi || !c.stoch;
}

/** The deterministic window during which a published signal blocks another on the same symbol. */
export function signalWindowEnd(decidedAt: number, cfg: EffectiveConfig): number {
  const A = cfg.assumptions;
  const deadline = decidedAt + A.maxEntryDelaySec * 1000;
  if (A.expiry.mode === "duration") return deadline + A.expiry.durationSec * 1000;
  const b = A.expiry.boundaryMinutes * 60_000;
  return Math.ceil((deadline + A.expiry.minSecondsToExpiry * 1000) / b) * b;
}

/* ── the step ─────────────────────────────────────────────────────────────────────────────────── */

export function setupId(symbol: CashtrapSymbol, dir: Direction, exhaustionT: number, strategyVersion: string): string {
  return `${symbol}:${dir}:${new Date(exhaustionT).toISOString()}:${strategyVersion}`;
}

export function step(prev: EngineState, input: StepInput): StepOutput {
  const cfg = input.config;
  const A = cfg.assumptions;
  const symbol = prev.symbol;
  const all = input.candles;
  const k = all[all.length - 1];
  const state: EngineState = JSON.parse(JSON.stringify(prev));
  const events: EngineEvent[] = [];
  const base = { symbol, candleT: k.t, decidedAt: input.decidedAt, strategyVersion: cfg.strategyVersion, configVersion: cfg.configVersion };

  if (state.lastT != null && k.t <= state.lastT) throw new Error(`cashtrap step: candle ${new Date(k.t).toISOString()} is not after ${new Date(state.lastT).toISOString()}`);
  state.lastT = k.t;
  if (state.activeSignal && state.activeSignal.until <= input.decidedAt) state.activeSignal = null;

  // Remember manual zones broken by a completed close (including this candle's — it applies from the next candle).
  if (A.zones.manualInvalidateOnClose && input.manualZones.length) {
    const merged = { ...(state.manualBroken ?? {}), ...manualBreaks(input.manualZones.filter((z) => !state.manualBroken?.[z.id]), all) };
    const listed = new Set(input.manualZones.map((z) => z.id));
    for (const id of Object.keys(merged)) if (!listed.has(id)) delete merged[id];
    if (Object.keys(merged).length) state.manualBroken = merged; else delete state.manualBroken;
  } else if (state.manualBroken && !input.manualZones.length) delete state.manualBroken;

  // DATA: warmup, gaps (and, live, a stale feed). Unreliable data decides nothing and ends an armed setup.
  const check = input.dataOverride && !input.dataOverride.ok ? input.dataOverride : checkHistory(symbol, all, all.length - 1, A.data.minWarmupCandles, A.data.contiguityCandles);
  if (!check.ok) {
    let reason = `Data unavailable — ${check.reason}. No decision is made on unreliable data.`;
    if (state.armed) {
      events.push({ type: "cancelled", setup: state.armed, reason: `data unavailable: ${check.reason}`, at: input.decidedAt });
      reason = `${reason} The ${state.armed.direction} setup from the ${hhmm(state.armed.exhaustionT)} candle is cancelled.`;
      state.armed = null;
    }
    return { state, events, evaluation: null, decision: { ...base, status: "DATA_UNAVAILABLE", direction: null, leading: null, checklist: null, met: 0, reasonCode: "data", reason, values: null, zoneId: null, setupId: null } };
  }

  const win = trailingWindow(all, A.data.windowCandles);
  const ev = evaluateLast(symbol, win, cfg, withBreaks(input.manualZones, state), { mode: input.dmiMode, available: input.dmiAvailable, external: input.externalEvents, knownBy: input.decidedAt });
  const checklist = { BUY: ev.buy.checklist, SELL: ev.sell.checklist };
  const leading = leadingDirection(ev);

  // Resets: a direction whose extension cleared on this candle may arm again later.
  for (const d of ["BUY", "SELL"] as Direction[]) if (state.needsReset[d] && cleared(ev, d, A.resetRule)) state.needsReset[d] = false;

  let status: DecisionStatus = "WAIT";
  let direction: Direction | null = null;
  let reasonCode = "no_setup";
  const notes: string[] = [];
  let zoneId: string | null = null;
  let setupRef: string | null = null;

  const confirm = (s: ArmedSetup): void => {
    const c: Confirmation = { setup: s, confirmT: k.t, confirmedAt: closeOf(k.t), decidedAt: input.decidedAt, dmiType: s.direction === "BUY" ? "B" : "S", values: ev.values };
    const hours = SYMBOL_SPECS[symbol].hours;
    const lag = input.decidedAt - c.confirmedAt;
    let suppressed: string | null = null;
    if (A.oneActiveSignalPerSymbol && state.activeSignal) suppressed = `a ${callPut(state.activeSignal.direction)} signal on ${symbol} is still running until ${new Date(state.activeSignal.until).toISOString().slice(11, 19)} UTC`;
    else if (lag > A.data.maxPublishLagMs) suppressed = `decided ${Math.round(lag / 1000)} s after the candle closed — too late to publish`;
    else if (!isOpen(hours, input.decidedAt)) suppressed = "the market is closed at publication";
    else if (!isOpen(hours, signalWindowEnd(input.decidedAt, cfg))) suppressed = "the market would be closed at expiry";
    events.push({ type: "confirmed", confirmation: c, publish: suppressed == null, suppressedReason: suppressed });
    if (!suppressed) state.activeSignal = { setupId: s.id, direction: s.direction, until: signalWindowEnd(input.decidedAt, cfg) };
    state.armed = null;
    status = "CONFIRMED"; direction = s.direction; zoneId = s.zone?.id ?? null; setupRef = s.id;
    reasonCode = suppressed ? "confirmed_suppressed" : "confirmed";
    notes.push(explainConfirmed(symbol, s, ev, suppressed));
  };
  const end = (s: ArmedSetup, kind: "cancelled" | "expired", why: string): void => {
    events.push({ type: kind, setup: s, reason: why, at: input.decidedAt });
    state.armed = null;
    reasonCode = kind; setupRef = s.id;
    notes.push(`${s.direction} setup from the ${hhmm(s.exhaustionT)} candle ${kind}: ${why}.`);
  };

  // 1. An armed setup meets this candle.
  if (state.armed) {
    const s = state.armed;
    s.seen += 1;
    const opp: Direction = s.direction === "BUY" ? "SELL" : "BUY";
    const want = s.direction === "BUY" ? "B" : "S";
    const oppEx = opp === "BUY" ? ev.buy.exhaustion : ev.sell.exhaustion;
    let cancel: string | null = null;
    const prevK = all.length >= 2 ? all[all.length - 2] : null;
    if (prevK && k.t - prevK.t > M5) cancel = `the market closed between ${hhmm(prevK.t)} and ${hhmm(k.t)} — a setup does not carry across a closure`;
    else if (ev.dmiBoth) cancel = "DMI printed both B and S on one candle";
    else if (ev.dmiEvent && ev.dmiEvent !== want) cancel = `opposite DMI ${ev.dmiEvent} appeared`;
    else if (s.zone && s.direction === "BUY" && k.c < s.zone.lower) cancel = `closed ${fmtPrice(symbol, k.c)}, below the support zone (${fmtPrice(symbol, s.zone.lower)})`;
    else if (s.zone && s.direction === "SELL" && k.c > s.zone.upper) cancel = `closed ${fmtPrice(symbol, k.c)}, above the resistance zone (${fmtPrice(symbol, s.zone.upper)})`;
    else if (oppEx) cancel = `an opposite ${opp} exhaustion formed`;
    if (cancel) end(s, "cancelled", cancel);
    else if (input.dmiAvailable && ev.dmiEvent === want) confirm(s);
    else if (s.seen >= A.dmiWindowCandles) end(s, "expired", input.dmiAvailable ? `no DMI ${want} within ${A.dmiWindowCandles + 1} candles` : "DMI events unavailable (DMI source required), so it could not be confirmed");
    else {
      status = "ARMED"; direction = s.direction; zoneId = s.zone?.id ?? null; setupRef = s.id; reasonCode = "armed_waiting";
      notes.push(explainArmed(symbol, s, input.dmiAvailable, A.dmiWindowCandles));
    }
  }

  // 2. A new exhaustion on this candle (not while a setup is still armed, and not after a confirmation).
  if (status === "WAIT") {
    const both = ev.buy.exhaustion && ev.sell.exhaustion;
    const dir: Direction | null = both ? null : ev.buy.exhaustion ? "BUY" : ev.sell.exhaustion ? "SELL" : null;
    if (both) {
      reasonCode = "ambiguous";
      notes.push("WAIT — both a BUY and a SELL exhaustion qualify on this candle; the direction is ambiguous.");
    } else if (dir && state.needsReset[dir]) {
      if (reasonCode === "no_setup") reasonCode = "no_reset";
      notes.push(`${dir} exhaustion again without its conditions resetting since the last ${dir} setup — not a new setup.`);
    } else if (dir) {
      const side = dir === "BUY" ? ev.buy : ev.sell;
      const s: ArmedSetup = {
        id: setupId(symbol, dir, k.t, cfg.strategyVersion), symbol, direction: dir, exhaustionT: k.t, armedAt: input.decidedAt, seen: 0,
        zone: side.zone ? snapZone(side.zone) : null, values: ev.values, checklist: side.checklist,
      };
      events.push({ type: "armed", setup: s });
      state.needsReset[dir] = true;
      state.armed = s;
      const want = dir === "BUY" ? "B" : "S";
      if (ev.dmiBoth || (ev.dmiEvent != null && ev.dmiEvent !== want)) end(s, "cancelled", ev.dmiBoth ? "DMI printed both B and S on the exhaustion candle" : `opposite DMI ${ev.dmiEvent} on the exhaustion candle`);
      else if (input.dmiAvailable && ev.dmiEvent === want) confirm(s);
      else if (A.dmiWindowCandles === 0) end(s, "expired", input.dmiAvailable ? `no DMI ${want} on the exhaustion candle` : "DMI events unavailable (DMI source required)");
      else {
        status = "ARMED"; direction = dir; zoneId = s.zone?.id ?? null; setupRef = s.id; reasonCode = "armed_new";
        notes.push(explainArmed(symbol, s, input.dmiAvailable, A.dmiWindowCandles));
      }
    }
  }

  if (!notes.length) notes.push(explainWait(symbol, ev, leading));
  // (status/direction are also set inside the closures above, which TypeScript's narrowing does not follow.)
  const st = status as DecisionStatus;
  const dirOut = direction as Direction | null;
  const lc = leading ? checklist[leading] : null;
  const met = st === "ARMED" && state.armed ? metCount({ ...state.armed.checklist, dmi: input.dmiAvailable ? false : null })
    : st === "CONFIRMED" && dirOut ? 5
    : lc ? metCount(lc) : 0;
  return {
    state, events, evaluation: ev,
    decision: { ...base, status: st, direction: dirOut, leading, checklist, met, reasonCode, reason: notes.join(" "), values: ev.values, zoneId, setupId: setupRef },
  };
}

/** Which side the market is leaning to: the direction with more of the four price conditions met (none on a tie). */
export function leadingDirection(ev: CandleEval): Direction | null {
  const n = (c: Checklist) => [c.band, c.rsi, c.stoch, c.zone].filter(Boolean).length;
  const b = n(ev.buy.checklist), s = n(ev.sell.checklist);
  if (b === s) return null;
  return b > s ? "BUY" : "SELL";
}

/* ── plain-language reasons, with the actual values ───────────────────────────────────────────── */
const hhmm = (t: number) => `${new Date(t).toISOString().slice(11, 16)} UTC`;
const n1 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(1));

function explainArmed(symbol: CashtrapSymbol, s: ArmedSetup, dmiAvailable: boolean, windowCandles: number): string {
  const v = s.values;
  const band = s.direction === "BUY" ? `low ${fmtPrice(symbol, v.low)} below the lower band ${fmtPrice(symbol, v.bbLower)}` : `high ${fmtPrice(symbol, v.high)} above the upper band ${fmtPrice(symbol, v.bbUpper)}`;
  const zone = s.zone ? `${s.zone.kind} zone ${fmtPrice(symbol, s.zone.lower)}–${fmtPrice(symbol, s.zone.upper)} (${s.zone.origin})` : "no zone required (requireZone off)";
  const until = hhmm(s.exhaustionT + (windowCandles + 1) * M5);
  const want = s.direction === "BUY" ? "B" : "S";
  const tail = dmiAvailable ? `Waiting for a DMI ${want} by the ${until} close.` : `DMI events are unavailable (DMI source required), so it cannot confirm.`;
  return `${s.direction} armed on the ${hhmm(s.exhaustionT)} candle: ${band}, RSI(4) ${n1(v.rsi)} ${s.direction === "BUY" ? "< 20" : "> 80"}, Stochastic ${n1(v.stochK)} ${s.direction === "BUY" ? "< 20" : "> 80"}, ${zone}. ${tail}`;
}

function explainConfirmed(symbol: CashtrapSymbol, s: ArmedSetup, ev: CandleEval, suppressed: string | null): string {
  const cp = callPut(s.direction);
  const dmiTxt = ev.values.dmiStoch != null ? ` (DMI-Stoch ${n1(ev.values.dmiStochPrev)} → ${n1(ev.values.dmiStoch)})` : "";
  const base = `${cp} confirmed: DMI ${s.direction === "BUY" ? "B" : "S"} on the ${hhmm(ev.values.t)} candle${dmiTxt}, ${s.seen} candle(s) after the ${hhmm(s.exhaustionT)} exhaustion (RSI ${n1(s.values.rsi)}, Stochastic ${n1(s.values.stochK)}${s.zone ? `, ${s.zone.kind} ${fmtPrice(symbol, s.zone.lower)}–${fmtPrice(symbol, s.zone.upper)}` : ""}).`;
  return suppressed ? `${base} Not published: ${suppressed}.` : base;
}

function explainWait(symbol: CashtrapSymbol, ev: CandleEval, leading: Direction | null): string {
  const v = ev.values;
  const parts = [
    `close ${fmtPrice(symbol, v.close)} between bands ${fmtPrice(symbol, v.bbLower)}–${fmtPrice(symbol, v.bbUpper)}`,
    `RSI(4) ${n1(v.rsi)}`,
    `Stochastic ${n1(v.stochK)}`,
  ];
  if (v.low < (v.bbLower ?? -Infinity)) parts[0] = `low ${fmtPrice(symbol, v.low)} below the lower band ${fmtPrice(symbol, v.bbLower)}`;
  if (v.high > (v.bbUpper ?? Infinity)) parts[0] = `high ${fmtPrice(symbol, v.high)} above the upper band ${fmtPrice(symbol, v.bbUpper)}`;
  const side = leading ? (leading === "BUY" ? ev.buy : ev.sell) : null;
  const missing = side ? (["band", "rsi", "stoch", "zone"] as const).filter((x) => !side.checklist[x]).map((x) => ({ band: "band excursion", rsi: "RSI extreme", stoch: "Stochastic extreme", zone: "support/resistance zone" })[x]) : [];
  return `WAIT — no exhaustion: ${parts.join(", ")}.${leading ? ` Leaning ${leading}; missing ${missing.join(", ")}.` : ""}`;
}
