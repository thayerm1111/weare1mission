/**
 * PDH_PDL_BREAK_RETEST_CONTINUATION — GENX 3.2.2 setup module (XAUUSD only).
 *
 *   BREAK → ACCEPT → RETEST → DEFEND → CONTINUE
 *
 * One state machine per level (PDH → BUY, PDL → SELL; the bearish machine is the exact mirror via d = −1).
 * Phases: IDLE → APPROACHING → LEVEL_BROKEN → WAITING_FOR_ACCEPTANCE → BREAKOUT_ACCEPTED → WAITING_FOR_RETEST
 *         → RETEST_IN_PROGRESS → RETEST_DEFENDED → ENTRY_ARMED → ENTRY → (outcome tracked by the shadow resolver)
 *         with FAILED (sweep / weak breakout / failed retest / extended) and EXPIRED exits.
 *
 * STATE PERSISTENCE: the machine is a pure function of the CLOSED 1m bars of the current trading day. It is
 * advanced bar-by-bar (incrementally in production and replay), and a fresh state (worker restart) rebuilds the
 * exact same state by replaying today's bars from the session open. So context is never forgotten between
 * updates or lost on restart, and there is no look-ahead. Every transition is kept (and persisted to
 * genx3_pd_setups by the runtime) so each setup can be reviewed.
 *
 * TIMEFRAMES: 1H = structural context (bias/levels from ctx), 15M = acceptance / sweep / failure decisions,
 * 5M = retest defense, 1M = earliest continuation trigger. Evidence is WEIGHTED, not a rigid checklist.
 *
 * Trading day = the broker day: New York 17:00 → 17:00 (the same daily candle TradeLocker/MT-style gold charts show).
 * All thresholds scale with XAUUSD volatility (ATR5 / ATR15) and were fixed before any replay (docs/genx3/GENX-3.2.2.md).
 */
import type { Bar } from "../candles";
import { type Series, lastClosed } from "../v31/series";
import type { Ctx } from "../v31/context";
import { finish, type Cand32, type EngineOut, type Side } from "./engines";

export const PD_SETUP = "PDH_PDL_BREAK_RETEST_CONTINUATION" as const;

/** Pre-registered thresholds (multiples of current ATR unless stated). */
export const PD = {
  approachAtr15: 1.0,          // within 1×ATR15 of the level = APPROACHING
  breakAtr5: 0.1,              // trades ≥0.1×ATR5 through the level = LEVEL_BROKEN
  acceptWindowMin: 60,         // acceptance must be established within 60 min of the break
  acceptScore: 3,              // weighted acceptance evidence needed
  sweepWickFrac: 0.5,          // 15m bar: wick beyond ≥50% of range and close back inside = SWEEP
  sweepCloseAtr5: 0.3,         // two 5m closes back inside by ≥0.3×ATR5 = SWEEP
  oppDispAtr5: 1.2,            // opposing 5m displacement body back through the level = SWEEP
  minExtensionAtr15: 1.0,      // price must travel ≥1×ATR15 beyond the level before a pullback counts as a retest
  zoneInsideAtr15: 0.35,       // retest zone: level − 0.35×ATR15 … level + 0.5×ATR15 (adaptive, front-run/penetration allowed)
  zoneOutsideAtr15: 0.5,
  retestWaitMin: 360,          // no retest within 6h of acceptance → EXPIRED
  retestMaxMin: 180,           // retest not defended within 3h → EXPIRED
  fail15CloseAtr15: 0.35,      // 15m close back inside by ≥0.35×ATR15 = breakout failed
  fail5CloseAtr15: 0.6,        // 5m close back inside by ≥0.6×ATR15 = breakout failed
  maxPenetrationAtr15: 1.0,    // retest penetrating >1×ATR15 inside = structure destroyed
  defenseScore: 2.5,           // weighted defense evidence needed (and a 5m close back beyond the level)
  armMaxMin: 45,               // continuation must begin within 45 min of the defended retest, else back to retest
  maxRearms: 3,
  chaseLevelAtr15: 1.5,        // skip if entry is >1.5×ATR15 beyond the level …
  chaseTriggerAtr15: 0.6,      // … or >0.6×ATR15 beyond the trigger (continuation already extended)
  stopLevelAtr15: 0.25,        // stop at least 0.25×ATR15 inside the level (never ON the level) …
  stopRetestAtr15: 0.1,        // … and 0.1×ATR15 beyond the defended retest extreme (finish() adds 0.1×ATR5 + $0.30)
  minTargetR: 1.5, maxTargetR: 4,
  maxCyclesPerDay: 3,          // a failed/expired break may re-form later the same day; ONE entry per level per day
  whipsawCrossesHard: 8,       // ≥8 5m close-crosses of the level in the last 3h = erratic → no trade
} as const;

export type PdPhase = "IDLE" | "APPROACHING" | "LEVEL_BROKEN" | "WAITING_FOR_ACCEPTANCE" | "BREAKOUT_ACCEPTED" | "WAITING_FOR_RETEST" | "RETEST_IN_PROGRESS" | "RETEST_DEFENDED" | "ENTRY_ARMED" | "ENTRY" | "FAILED" | "EXPIRED";
export type PdTransition = { t: number; from: PdPhase; to: PdPhase; why: string };
export type PdMachine = {
  level: "PDH" | "PDL"; side: Side; d: 1 | -1; px: number; dayKey: string; cycle: number;
  phase: PdPhase; closedInside: boolean; entered: boolean;
  approachAt: number | null; tests: number; higherLows: boolean;
  breakAt: number | null; breakBarBody: number; breakDisp: number; extreme: number; acc: number; accEvidence: string[]; acceptedAt: number | null; consec: number;
  retestAt: number | null; retestExt: number; zone: [number, number] | null; defense: number; defEvidence: string[]; reclaimed: boolean; trigger: number | null; armedAt: number | null; rearms: number;
  entry: { t: number; px: number; trig: string } | null; failReason: string | null;
  transitions: PdTransition[]; version: number;       // version increments on every transition (runtime persists on change)
};
export type PdState = { dayKey: string | null; cursor: number; pdh: number; pdl: number; dayHigh: number; dayLow: number; machines: PdMachine[]; crossH: number[]; crossL: number[]; ended: PdMachine[] };
export const newPdState = (): PdState => ({ dayKey: null, cursor: -1, pdh: NaN, pdl: NaN, dayHigh: -Infinity, dayLow: Infinity, machines: [], crossH: [], crossL: [], ended: [] });

// ── broker trading day (NY 17:00 → 17:00) ─────────────────────────────────────────────────────────
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const dayCache = new Map<number, string>();
/** Trading-day key: NY calendar date of (t + 7h) — bars from 17:00/18:00 NY belong to the next date. */
export function tradingDayKey(t: number): string {
  const hk = Math.floor(t / 3_600_000); let v = dayCache.get(hk);
  if (!v) { v = fmt.format(new Date(hk * 3_600_000 + 7 * 3_600_000 + 1)); if (dayCache.size > 100_000) dayCache.clear(); dayCache.set(hk, v); }
  return v;
}
// cached per series object (production builds a new series every minute; replay reuses one) — never across data sets
const levelCache = new WeakMap<Bar[], Map<string, { startIdx: number; pdh: number; pdl: number } | null>>();
function dayInfo(s: Series, i1: number): { startIdx: number; pdh: number; pdl: number } | null {
  const bars = s.m1.bars, key = tradingDayKey(bars[i1].t);
  let cache = levelCache.get(bars); if (!cache) { cache = new Map(); levelCache.set(bars, cache); }
  const ck = key;
  if (cache.has(ck)) { const c = cache.get(ck)!; if (!c || c.startIdx <= i1) return c; }
  let k = i1; while (k > 0 && tradingDayKey(bars[k - 1].t) === key) k--;
  const startIdx = k; if (startIdx === 0) { cache.set(ck, null); return null; }
  const pk = tradingDayKey(bars[startIdx - 1].t); let h = -Infinity, l = Infinity, j = startIdx - 1, n = 0;
  while (j >= 0 && tradingDayKey(bars[j].t) === pk) { if (bars[j].h > h) h = bars[j].h; if (bars[j].l < l) l = bars[j].l; j--; n++; }
  const v = n >= 60 && j >= 0 ? { startIdx, pdh: h, pdl: l } : null;     // needs a real prior session (and data before it)
  cache.set(ck, v); return v;
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────
const clamp = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const cloc = (b: Bar) => (b.h > b.l ? (b.c - b.l) / (b.h - b.l) : 0.5);
const r2 = (x: number) => +x.toFixed(2);
function atrAt(tf: Series["m5"], closeT: number): number { const i = lastClosed(tf, closeT); return i >= 0 ? tf.atr[i] : NaN; }
function bucket(tf: Series["m5"], t: number): Bar | null { const i = lastClosed(tf, t); return i >= 0 && tf.t[i] + tf.size === t ? tf.bars[i] : null; }

function newMachine(level: "PDH" | "PDL", px: number, dayKey: string, cycle: number, closedInside: boolean): PdMachine {
  const d = level === "PDH" ? 1 : -1;
  return { level, side: d > 0 ? "BUY" : "SELL", d, px, dayKey, cycle, phase: "IDLE", closedInside, entered: false, approachAt: null, tests: 0, higherLows: false,
    breakAt: null, breakBarBody: 0, breakDisp: 0, extreme: px, acc: 0, accEvidence: [], acceptedAt: null, consec: 0,
    retestAt: null, retestExt: d > 0 ? Infinity : -Infinity, zone: null, defense: 0, defEvidence: [], reclaimed: false, trigger: null, armedAt: null, rearms: 0, entry: null, failReason: null, transitions: [], version: 0 };
}
function go(m: PdMachine, t: number, to: PdPhase, why: string) { m.transitions.push({ t, from: m.phase, to, why }); if (m.transitions.length > 60) m.transitions.splice(0, m.transitions.length - 60); m.phase = to; m.version++; }
export const anchorOf = (m: PdMachine) => `PD32:${m.level}:${m.side}:${m.dayKey}:c${m.cycle}`;

/** Advance one machine by one CLOSED 1m bar (closeT = bar.t + 60s). Returns true when an ENTRY fired on this bar. */
function advance(s: Series, m: PdMachine, b: Bar, closeT: number, st: PdState): boolean {
  const d = m.d, L = m.px, a15 = atrAt(s.m15, closeT), a5 = atrAt(s.m5, closeT);
  if (!(a15 > 0) || !(a5 > 0)) return false;
  const beyond = (x: number) => d * (x - L);
  const far = (x: Bar) => (d > 0 ? x.h : x.l), near = (x: Bar) => (d > 0 ? x.l : x.h);
  const b5 = closeT % 300_000 === 0 ? bucket(s.m5, closeT) : null, b15 = closeT % 900_000 === 0 ? bucket(s.m15, closeT) : null;
  const p5 = b5 ? s.m5.bars[lastClosed(s.m5, closeT) - 1] : null;
  const failInside = (): string | null => {
    if (b15 && beyond(b15.c) < -PD.fail15CloseAtr15 * a15) return `15M closed back ${d > 0 ? "below" : "above"} ${m.level} by ${(-beyond(b15.c) / a15).toFixed(2)}×ATR15`;
    if (b5 && beyond(b5.c) < -PD.fail5CloseAtr15 * a15) return `5M closed back ${d > 0 ? "below" : "above"} ${m.level} by ${(-beyond(b5.c) / a15).toFixed(2)}×ATR15`;
    return null;
  };
  if (b5) m.closedInside = m.closedInside || beyond(b5.c) < 0;

  switch (m.phase) {
    case "IDLE": {
      if (!m.closedInside) return false;                          // opened beyond the level: no intraday break to trade until price closes back inside
      if (b5 && beyond(b5.c) <= 0 && beyond(b5.c) >= -PD.approachAtr15 * a15) { m.approachAt = closeT; go(m, closeT, "APPROACHING", `5M close ${(-beyond(b5.c) / a15).toFixed(2)}×ATR15 from ${m.level} ${L.toFixed(2)}`); }
      else if (beyond(far(b)) > PD.breakAtr5 * a5 && beyond(b.o) <= 0) { m.approachAt = closeT; go(m, closeT, "APPROACHING", "impulsive move straight into the level (no approach phase)"); }
      if ((m.phase as PdPhase) !== "APPROACHING") return false;
    }
    // falls through
    case "APPROACHING": {
      if (b15) {                                                   // compression: repeated tests of the level with rising lows (bull) / falling highs (bear)
        const i15 = lastClosed(s.m15, closeT); let tests = 0; const pts: number[] = [];
        for (let k = Math.max(0, i15 - 7); k <= i15; k++) { const x = s.m15.bars[k]; if (beyond(far(x)) >= -0.25 * a15 && beyond(x.c) <= 0) { tests++; pts.push(near(x)); } }
        m.tests = tests; m.higherLows = pts.length >= 2 && pts.every((v, k) => k === 0 || d * (v - pts[k - 1]) >= 0);
      }
      if (beyond(far(b)) > PD.breakAtr5 * a5) {
        m.breakAt = closeT; m.extreme = far(b); m.acc = 0; m.accEvidence = []; m.consec = 0;
        go(m, closeT, "LEVEL_BROKEN", `traded ${(beyond(far(b))).toFixed(2)} through ${m.level} ${L.toFixed(2)}${m.tests >= 2 ? ` after ${m.tests} tests${m.higherLows ? (d > 0 ? " with higher lows" : " with lower highs") : ""}` : ""}`);
        go(m, closeT, "WAITING_FOR_ACCEPTANCE", "break is not a buy/sell by itself — sweep or real breakout?");
        return false;
      }
      if (b5 && beyond(b5.c) < -2.5 * a15) { go(m, closeT, "IDLE", "price left the approach area"); }
      return false;
    }
    case "WAITING_FOR_ACCEPTANCE": {
      if (d * (far(b) - m.extreme) > 0) m.extreme = far(b);
      if (b15 && beyond(far(b15)) > 0 && beyond(b15.c) < 0 && beyond(far(b15)) >= PD.sweepWickFrac * (b15.h - b15.l)) return fail(m, closeT, `SWEEP: 15M wick ${d > 0 ? "above PDH" : "below PDL"} closed back ${d > 0 ? "below" : "above"} (liquidity run)`);
      if (b5) {
        const body = Math.abs(b5.c - b5.o);
        if (m.breakBarBody === 0) { m.breakBarBody = body; m.breakDisp = body / a5; if (body >= 1.0 * a5 && beyond(b5.c) > 0 && (d > 0 ? cloc(b5) : 1 - cloc(b5)) >= 0.7) { m.acc += 1.5; m.accEvidence.push(`displacement: break candle body ${(body / a5).toFixed(1)}×ATR5, closed ${d > 0 ? "near high" : "near low"}`); } }
        if (d * (b5.o - b5.c) >= PD.oppDispAtr5 * a5 && beyond(b5.c) < 0) return fail(m, closeT, `SWEEP: opposing displacement (${(body / a5).toFixed(1)}×ATR5) back through ${m.level}`);
        if (beyond(b5.c) < -PD.sweepCloseAtr5 * a5 && p5 && beyond(p5.c) < -PD.sweepCloseAtr5 * a5 && (p5.t + 300_000) > (m.breakAt ?? 0)) return fail(m, closeT, `SWEEP: two 5M closes back ${d > 0 ? "below" : "above"} ${m.level} — failed to regain`);
        m.consec = beyond(b5.c) > 0 ? m.consec + 1 : 0;
        if (m.consec === 3) { m.acc += 1; m.accEvidence.push("3 consecutive 5M closes holding beyond the level"); }
        if (m.consec >= 3 && !m.accEvidence.some((e) => e.startsWith("higher low") || e.startsWith("lower high"))) {
          const i5 = lastClosed(s.m5, closeT); const lows = [s.m5.bars[i5 - 2], s.m5.bars[i5 - 1], s.m5.bars[i5]].map(near);
          if (lows.every((v) => beyond(v) > 0) && d * (lows[2] - lows[0]) >= 0) { m.acc += 1; m.accEvidence.push(`${d > 0 ? "higher low" : "lower high"} forming beyond the level`); }
        }
      }
      if (b15 && beyond(b15.c) > 0.1 * a15 && Math.abs(b15.c - b15.o) >= 0.4 * (b15.h - b15.l) && !m.accEvidence.some((e) => e.startsWith("15M body"))) { m.acc += 2; m.accEvidence.push(`15M body close ${(beyond(b15.c) / a15).toFixed(2)}×ATR15 beyond ${m.level}`); }
      if (beyond(m.extreme) >= PD.minExtensionAtr15 * a15 && !m.accEvidence.some((e) => e.startsWith("travelled"))) { m.acc += 1; m.accEvidence.push(`travelled ${(beyond(m.extreme) / a15).toFixed(1)}×ATR15 beyond the level`); }
      if (m.acc >= PD.acceptScore) {
        m.acceptedAt = closeT;
        go(m, closeT, "BREAKOUT_ACCEPTED", `acceptance ${m.acc.toFixed(1)}: ${m.accEvidence.join("; ")}`);
        go(m, closeT, "WAITING_FOR_RETEST", `retest zone ${zone(m, a15).map((x) => x.toFixed(2)).join("–")}`);
        return false;
      }
      if (closeT - (m.breakAt ?? closeT) >= PD.acceptWindowMin * 60_000) return fail(m, closeT, beyond(b.c) > 0 ? `WEAK_BREAKOUT: no acceptance within ${PD.acceptWindowMin}m (evidence ${m.acc.toFixed(1)} < ${PD.acceptScore})` : `SWEEP: back inside the level with no acceptance`);
      return false;
    }
    case "WAITING_FOR_RETEST": {
      if (d * (far(b) - m.extreme) > 0) m.extreme = far(b);
      const f = failInside(); if (f) return fail(m, closeT, `BREAKOUT_FAILED before retest: ${f}`);
      if (closeT - (m.acceptedAt ?? closeT) >= PD.retestWaitMin * 60_000) return expire(m, closeT, `no retest within ${PD.retestWaitMin / 60}h of acceptance`);
      if (beyond(m.extreme) >= PD.minExtensionAtr15 * a15 && beyond(near(b)) <= PD.zoneOutsideAtr15 * a15) {
        m.retestAt = closeT; m.retestExt = near(b); m.zone = zone(m, a15).map(r2) as [number, number]; m.defense = 0; m.defEvidence = []; m.reclaimed = false;
        go(m, closeT, "RETEST_IN_PROGRESS", `pullback into retest zone (${(beyond(near(b)) / a15).toFixed(2)}×ATR15 from ${m.level}) after ${(beyond(m.extreme) / a15).toFixed(1)}×ATR15 extension`);
      }
      return false;
    }
    case "RETEST_IN_PROGRESS":
    case "RETEST_DEFENDED":
    case "ENTRY_ARMED": {
      const f = failInside(); if (f) return fail(m, closeT, `RETEST_FAILED: ${f}`);
      const newExt = d * (m.retestExt - near(b)) > 0;
      if (newExt) m.retestExt = near(b);
      if (-beyond(m.retestExt) > PD.maxPenetrationAtr15 * a15) return fail(m, closeT, `RETEST_FAILED: penetrated ${(-beyond(m.retestExt) / a15).toFixed(2)}×ATR15 through ${m.level} — structure destroyed`);
      if (m.phase === "ENTRY_ARMED") {
        if (newExt) return rearm(m, closeT, `sellers made a new retest ${d > 0 ? "low" : "high"} before continuation`);
        if (d * (b.c - (m.trigger as number)) > 0) {
          const extL = beyond(b.c) / a15, extT = d * (b.c - (m.trigger as number)) / a15;
          if (extL > PD.chaseLevelAtr15 || extT > PD.chaseTriggerAtr15) return fail(m, closeT, `EXTENDED: continuation confirmed ${extL.toFixed(2)}×ATR15 from ${m.level} / ${extT.toFixed(2)}×ATR15 past trigger — skipped, no chase`);
          m.entry = { t: closeT, px: b.c, trig: `1M close ${b.c.toFixed(2)} ${d > 0 ? "above" : "below"} defended-retest trigger ${(m.trigger as number).toFixed(2)}` };
          m.entered = true; go(m, closeT, "ENTRY", m.entry.trig); return true;
        }
        if (closeT - (m.armedAt ?? closeT) >= PD.armMaxMin * 60_000) return rearm(m, closeT, `continuation did not begin within ${PD.armMaxMin}m`);
        return false;
      }
      if (closeT - (m.retestAt ?? closeT) >= PD.retestMaxMin * 60_000) return expire(m, closeT, `retest not defended within ${PD.retestMaxMin / 60}h`);
      if (b5 && p5) {
        const body = Math.abs(b5.c - b5.o), rng = b5.h - b5.l || 1e-9, loc = d > 0 ? cloc(b5) : 1 - cloc(b5), withD = d * (b5.c - b5.o) > 0;
        const touched = beyond(near(b5)) <= PD.zoneOutsideAtr15 * a15 || beyond(near(p5)) <= PD.zoneOutsideAtr15 * a15;
        const add = (pts: number, why: string) => { m.defense += pts; m.defEvidence.push(why); };
        if (d * (near(b5) - m.retestExt) <= 0 && loc < 0.4) { if (m.defense > 0) m.defEvidence.push("pressure resumed — defense reset"); m.defense = 0; }
        else if (touched) {
          const wick = d > 0 ? Math.min(b5.o, b5.c) - b5.l : b5.h - Math.max(b5.o, b5.c);
          if (wick >= 0.4 * rng && loc >= 0.55) add(1.5, `rejection wick ${(wick / rng * 100).toFixed(0)}% into the retest zone`);
          if (withD && d * (p5.o - p5.c) > 0 && d * (b5.c - p5.o) >= 0 && d * (p5.c - b5.o) >= 0) add(1.5, `${d > 0 ? "bullish" : "bearish"} engulfing`);
          if (withD && body >= 0.6 * a5 && loc >= 0.7) add(1.5, `strong ${d > 0 ? "bullish" : "bearish"} close (${(body / a5).toFixed(1)}×ATR5)`);
          if (!m.reclaimed && beyond(m.retestExt) < 0 && beyond(b5.c) > 0) { m.reclaimed = true; add(1, `reclaimed ${m.level} after ${(-beyond(m.retestExt)).toFixed(2)} penetration`); }
          if (d * (near(b5) - near(p5)) > 0 && near(p5) === m.retestExt) add(1, `micro ${d > 0 ? "higher low" : "lower high"}`);
          if (d * (near(p5) - near(b5)) > 0 && d * (b5.c - p5.c) > 0 && withD) add(0.5, "failed continuation against the level");
          const i5 = lastClosed(s.m5, closeT); const bodies = [i5 - 2, i5 - 1, i5].map((k) => s.m5.bars[k]).filter((x) => d * (x.o - x.c) > 0).map((x) => Math.abs(x.c - x.o));
          if (bodies.length >= 2 && bodies.every((v, k) => k === 0 || v < bodies[k - 1]) && !m.defEvidence.some((e) => e.startsWith("counter candles"))) add(0.5, "counter candles losing range");
        }
        if (m.defense >= PD.defenseScore && beyond(b5.c) > 0) {
          m.trigger = far(b5); m.armedAt = closeT;
          go(m, closeT, "RETEST_DEFENDED", `defense ${m.defense.toFixed(1)}: ${m.defEvidence.slice(-4).join("; ")}`);
          go(m, closeT, "ENTRY_ARMED", `continuation trigger ${m.trigger.toFixed(2)} (defense candle ${d > 0 ? "high" : "low"})`);
        }
      }
      return false;
    }
    default: return false;
  }
  function fail(mm: PdMachine, t: number, why: string) { mm.failReason = why; go(mm, t, "FAILED", why); return false; }
  function expire(mm: PdMachine, t: number, why: string) { mm.failReason = why; go(mm, t, "EXPIRED", why); return false; }
  function rearm(mm: PdMachine, t: number, why: string) {
    if (++mm.rearms > PD.maxRearms) return fail(mm, t, `RETEST_FAILED: defense failed ${PD.maxRearms}× (${why})`);
    mm.defense = 0; mm.defEvidence = []; mm.trigger = null; mm.armedAt = null; go(mm, t, "RETEST_IN_PROGRESS", why); return false;
  }
  void st;
}
function zone(m: PdMachine, a15: number): [number, number] { return m.d > 0 ? [m.px - PD.zoneInsideAtr15 * a15, m.px + PD.zoneOutsideAtr15 * a15] : [m.px - PD.zoneOutsideAtr15 * a15, m.px + PD.zoneInsideAtr15 * a15]; }

/** Advance the PD state to asOf (catching up from the session open if needed) and emit waits / a candidate. */
export function pdhPdlBreakRetest(s: Series, ctx: Ctx, st: PdState): EngineOut & { machines: PdMachine[] } {
  const out: EngineOut & { machines: PdMachine[] } = { cands: [], waits: [], machines: [] };
  const i1 = ctx.i1; if (i1 < 1) return out;
  const info = dayInfo(s, i1); if (!info) return out;
  const key = tradingDayKey(s.m1.bars[i1].t);
  if (st.dayKey !== key || st.cursor >= s.m1.bars.length) {
    const ended = st.machines.filter((m) => m.phase !== "IDLE" && m.phase !== "ENTRY" && m.phase !== "FAILED" && m.phase !== "EXPIRED");
    for (const m of ended) { m.failReason = "trading day ended before entry"; go(m, s.m1.bars[info.startIdx].t, "EXPIRED", m.failReason); }
    Object.assign(st, newPdState(), { dayKey: key, cursor: info.startIdx - 1, pdh: info.pdh, pdl: info.pdl, ended });
    st.machines = [newMachine("PDH", info.pdh, key, 1, false), newMachine("PDL", info.pdl, key, 1, false)];
  }
  if (st.cursor < info.startIdx - 1) st.cursor = info.startIdx - 1;
  let fired: PdMachine | null = null;
  for (let k = st.cursor + 1; k <= i1; k++) {
    const b = s.m1.bars[k], closeT = b.t + 60_000;
    if (b.h > st.dayHigh) st.dayHigh = b.h; if (b.l < st.dayLow) st.dayLow = b.l;
    for (let mi = 0; mi < st.machines.length; mi++) {
      const m = st.machines[mi];
      if (m.phase === "FAILED" || m.phase === "EXPIRED") {
        const cycles = st.machines.filter((x) => x.level === m.level).length, done = st.machines.some((x) => x.level === m.level && x.entered);
        if (!done && cycles < PD.maxCyclesPerDay && st.machines.filter((x) => x.level === m.level).at(-1) === m) {
          const nm = newMachine(m.level, m.px, key, m.cycle + 1, false); st.machines.push(nm);
        }
        continue;
      }
      if (m.phase === "ENTRY") continue;
      if (advance(s, m, b, closeT, st) && k === i1) fired = m;
    }
    if (closeT % 300_000 === 0) { const b5 = bucket(s.m5, closeT); if (b5) { st.crossH.push(Math.sign(b5.c - st.pdh)); st.crossL.push(Math.sign(b5.c - st.pdl)); if (st.crossH.length > 36) { st.crossH.shift(); st.crossL.shift(); } } }
  }
  st.cursor = i1;
  out.machines = st.ended.length ? [...st.ended, ...st.machines] : st.machines; st.ended = [];

  for (const m of st.machines) {
    if (m.phase === "IDLE" || m.phase === "FAILED" || m.phase === "EXPIRED" || m.phase === "ENTRY") continue;
    out.waits.push({ setup: PD_SETUP as never, side: m.side, anchor: anchorOf(m), reason: `${m.phase.replace("LEVEL", m.level).replace("APPROACHING", `APPROACHING_${m.level}`)}: ${m.transitions.at(-1)?.why ?? ""}` });
  }
  if (!fired || !fired.entry) return out;

  const m = fired, d = m.d, a15 = ctx.atr15, L = m.px;
  const crosses = (() => { let n = 0; const sgn = (m.level === "PDH" ? st.crossH : st.crossL).filter((v) => v !== 0); for (let k = 1; k < sgn.length; k++) if (sgn[k] !== sgn[k - 1]) n++; return n; })();
  const inv = d > 0 ? Math.min(m.retestExt - PD.stopRetestAtr15 * a15, L - PD.stopLevelAtr15 * a15) : Math.max(m.retestExt + PD.stopRetestAtr15 * a15, L + PD.stopLevelAtr15 * a15);
  const b1 = s.m1.bars[i1];
  const evidence = [
    `${m.level} ${L.toFixed(2)} broken ${new Date(m.breakAt!).toISOString().slice(11, 16)}Z (break candle ${m.breakDisp.toFixed(1)}×ATR5)`,
    `acceptance: ${m.accEvidence.join("; ")}`,
    `retest ${new Date(m.retestAt!).toISOString().slice(11, 16)}Z, depth ${(d * (m.retestExt - L)).toFixed(2)} (${(d * (m.retestExt - L) / a15).toFixed(2)}×ATR15), zone ${zone(m, a15).map((x) => x.toFixed(2)).join("–")}`,
    `defense: ${m.defEvidence.slice(-5).join("; ")}`,
    `trigger: ${m.entry!.trig}`,
    ...(m.tests >= 2 ? [`compression before break: ${m.tests} tests${m.higherLows ? (d > 0 ? ", higher lows" : ", lower highs") : ""}`] : []),
  ];
  const base = { setup: PD_SETUP as never, side: m.side, anchor: anchorOf(m), entry: b1.c, invalidation: r2(inv), evidence };
  const feats = {
    compression: m.tests >= 2 ? (m.higherLows ? 1 : 0.6) : 0.3,
    displacement: clamp(m.breakDisp / 1.5),
    acceptance: clamp(m.acc / 5),
    retest: clamp(1 - Math.max(0, -(d * (m.retestExt - L)) / a15 - 0.1) / 0.9),
    defense: clamp(m.defense / 4),
    structure: ctx.trend15 === d ? 1 : ctx.trend15 === 0 ? 0.5 : 0,
    whipsaw: clamp(1 - (crosses - 1) / 5),
    continuation: d > 0 ? cloc(b1) : 1 - cloc(b1),
  };
  const probe = finish(ctx, { ...base, targetR: 2, feats });
  if (!probe) return out;
  // Target: measured breakout expansion (retest extreme → breakout extreme, projected from entry), capped by the next
  // structural level (1H swings, session highs/lows). FLOW's existing management keeps a runner beyond it.
  const mmR = Math.abs(m.extreme - m.retestExt) / probe.risk;
  const targetR = +Math.max(PD.minTargetR, Math.min(PD.maxTargetR, Math.max(2, mmR), probe.roomR)).toFixed(2);
  const c: Cand32 | null = finish(ctx, { ...base, targetR, feats });
  if (!c) return out;
  if (crosses >= PD.whipsawCrossesHard) c.hard.push(`erratic: ${crosses} 5M closes crossed ${m.level} in 3h`);
  if (Math.abs(c.entry - m.entry!.px) > 1e-9) c.hard.push("entry price mismatch");
  out.cands.push(c);
  return out;
}
