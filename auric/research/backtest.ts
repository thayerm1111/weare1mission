import { DEFAULT_CONFIG, MANAGEMENT_VERSION, type AuricConfig } from "../config/defaults";
import type { Bar, Candidate, Quote } from "../core/types";
import { evaluate, emptyEngineState, type EngineState } from "../engine/evaluate";
import { sizePosition } from "../engine/sizing";
import { manage, type ManagedPosition } from "../engine/management";
import { confirmedPivots } from "../engine/features";
import { aggregate } from "../market/bars";
import { fallbackSession } from "../market/session";
import { checkBreakers, freshRiskState, recordClose, type RiskState } from "../engine/breakers";
import type { InstrumentSpec } from "../core/types";

/**
 * Deterministic replay of the live decision path on historical M1 bars.
 *
 * HONESTY NOTES (also printed in the report):
 *  - Quotes are synthesized from the bar close ± spread/2 (reference candles, not broker ticks).
 *  - Bar-level fills: when a bar touches both stop and target the STOP is assumed first (conservative).
 *  - Entry slippage and stop slippage are charged at the configured allowance; target fills get none.
 *  - No look-ahead: every decision uses only bars closed before the decision bar; pivots are confirmed-only.
 *  - No parameter fitting was performed on this data; the defaults are prior hypotheses, so the whole
 *    period is out-of-sample with respect to fitting — but NOT with respect to design intuition.
 */
export type BtAssumptions = { spread: number; slippageTicks: number; commissionPerLot: number; equity: number; riskFraction: number; label: string };
export type BtTrade = { openedAt: number; closedAt: number; side: string; family: string; regime: string; entry: number; exit: number; stop: number; target: number; qty: number; pnl: number; r: number; reason: string; holdMin: number; session: string; atrPct: number };
export type BtReport = {
  label: string; strategyVersion: string; managementVersion: string; assumptions: BtAssumptions; bars: number; from: string; to: string;
  trades: number; wins: number; losses: number; timeouts: number; net: number; grossWin: number; grossLoss: number; profitFactor: number | null; expectancy: number; expectancyR: number;
  maxDrawdown: number; maxDrawdownPct: number; exposurePct: number; avgHoldMin: number; tradesPerWeek: number;
  byFamily: Record<string, { n: number; net: number; wins: number }>; byRegime: Record<string, { n: number; net: number; wins: number }>; bySession: Record<string, { n: number; net: number; wins: number }>; byVol: Record<string, { n: number; net: number; wins: number }>;
  byQuarter: Record<string, { n: number; net: number; wins: number }>;
  rejections: Record<string, number>; candidatesSeen: number; evalP50Ms: number; evalP95Ms: number; evalP99Ms: number;
  tradeSample: BtTrade[]; notes: string[];
};

const SPEC: InstrumentSpec = { tradableInstrumentId: "sim", tradeRouteId: "sim", infoRouteId: "sim", name: "XAUUSD(sim)", contractSize: 100, lotStep: 0.01, minLot: 0.01, maxLot: 100, tickSize: 0.01, tickValue: null, priceDecimals: 2, currency: "USD", minStopDistance: null, raw: null };

const sessionOf = (t: number) => { const h = new Date(t).getUTCHours(); return h < 7 ? "asia" : h < 13 ? "london" : h < 21 ? "newyork" : "late"; };
const quarterOf = (t: number) => { const d = new Date(t); return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };

export function backtest(m1All: Bar[], a: BtAssumptions, cfg: AuricConfig = DEFAULT_CONFIG, opts: { maxBars?: number; log?: (s: string) => void } = {}): BtReport {
  const bars = opts.maxBars ? m1All.slice(-opts.maxBars) : m1All;
  const cfgSized: AuricConfig = { ...cfg, sizing: { ...cfg.sizing, slippageAllowanceTicks: a.slippageTicks, commissionPerLotRoundTrip: a.commissionPerLot } };
  let engine: EngineState = emptyEngineState();
  let equity = a.equity, peak = equity, maxDd = 0, maxDdPct = 0;
  let risk: RiskState | null = null;
  const trades: BtTrade[] = []; const rejections: Record<string, number> = {}; let candidatesSeen = 0;
  const evalTimes: number[] = [];
  let open: (ManagedPosition & { family: string; regime: string; atrPct: number; openIdx: number }) | null = null;
  let barsInPosition = 0; let lastEntryIdx = -1e9; let lastCandidateBarT = 0;
  const warm = 1500;
  if (bars.length < warm + 100) throw new Error(`backtest needs at least ${warm + 100} bars; got ${bars.length}`);
  // Incremental higher-timeframe caches: recompute M5/M15/H1 only when a new bucket closes.
  let m5: Bar[] = [], m15: Bar[] = [], h1: Bar[] = []; let last5 = -1, last15 = -1, last60 = -1;
  const tick = SPEC.tickSize!;

  for (let i = warm; i < bars.length; i++) {
    const now = bars[i].t + 60_000;               // decision time = close of bar i
    const closed = bars.slice(Math.max(0, i - 1500), i + 1);
    const b5 = Math.floor(now / 300_000), b15 = Math.floor(now / 900_000), b60 = Math.floor(now / 3600_000);
    if (b5 !== last5) { m5 = aggregate(bars.slice(Math.max(0, i - 3000), i + 1), 5, true, now).slice(-400); last5 = b5; }
    if (b15 !== last15) { m15 = aggregate(bars.slice(Math.max(0, i - 4500), i + 1), 15, true, now).slice(-200); last15 = b15; }
    if (b60 !== last60) { h1 = aggregate(bars.slice(Math.max(0, i - 9000), i + 1), 60, true, now).slice(-120); last60 = b60; }
    const c = bars[i].c;
    const q: Quote = { source: "broker", bid: +(c - a.spread / 2).toFixed(2), ask: +(c + a.spread / 2).toFixed(2), providerTs: bars[i].t, providerTsPrecision: "s", receivedAt: now };
    const sess = fallbackSession(now);

    // ---- manage an open position on bar i+1 (next bar) using only information at `now`.
    if (open) {
      barsInPosition++;
      const nb = bars[i + 1]; if (!nb) break;
      const piv = confirmedPivots(m5, cfg.features.pivotLeft, cfg.features.pivotRight);
      const act = manage(open, q.bid, q.ask, tick, 0, closed, piv.highs, piv.lows, now, cfg.protection, sess.minutesToClose, a.spread);
      if (act.kind === "modify_stop") { open.stop = act.newStop; if (act.breakeven) open.breakevenDone = true; }
      let exit: number | null = null, reason = "";
      const slip = a.slippageTicks * tick;
      if (act.kind === "close") { exit = open.side === "buy" ? q.bid - slip : q.ask + slip; reason = act.code.toLowerCase(); }
      else {
        const stopHit = open.side === "buy" ? nb.l - a.spread / 2 <= open.stop : nb.h + a.spread / 2 >= open.stop;
        const tgtHit = open.side === "buy" ? nb.h - a.spread / 2 >= open.target : nb.l + a.spread / 2 <= open.target;
        if (stopHit) { exit = open.side === "buy" ? open.stop - slip : open.stop + slip; reason = "stop"; }   // conservative: stop first
        else if (tgtHit) { exit = open.target; reason = "target"; }
      }
      if (exit != null) {
        const pnl = (open.side === "buy" ? exit - open.entry : open.entry - exit) * open.qty * SPEC.contractSize! - a.commissionPerLot * open.qty;
        equity += pnl; peak = Math.max(peak, equity); const dd = peak - equity; if (dd > maxDd) { maxDd = dd; maxDdPct = dd / peak; }
        const closedAt = act.kind === "close" ? now : nb.t + 60_000;
        trades.push({ openedAt: open.openedAt, closedAt, side: open.side, family: open.family, regime: open.regime, entry: open.entry, exit, stop: open.stop, target: open.target, qty: open.qty, pnl: +pnl.toFixed(2), r: +(pnl / (open.initialRisk * open.qty * SPEC.contractSize!)).toFixed(2), reason, holdMin: Math.round((closedAt - open.openedAt) / 60_000), session: sessionOf(open.openedAt), atrPct: open.atrPct });
        if (risk) risk = recordClose(risk, pnl, closedAt, cfg.breakers);
        open = null;
        continue;
      }
      continue; // one position at a time: no evaluation while in a trade
    }

    // ---- evaluate
    const t0 = performance.now();
    const out = evaluate({ cfg: cfgSized, m1: closed, m5, m15, h1, quote: q, tick, contractSize: SPEC.contractSize, now }, engine);
    evalTimes.push(performance.now() - t0); engine = out.state;
    for (const r of out.decision.rejections) rejections[`${r.family ?? "-"}:${r.code}`] = (rejections[`${r.family ?? "-"}:${r.code}`] ?? 0) + 1;
    if (out.decision.kind !== "candidate") continue;
    const cand: Candidate = out.decision.candidate; candidatesSeen++;
    if (cand.sourceTimestamps.m1Close === lastCandidateBarT) continue; lastCandidateBarT = cand.sourceTimestamps.m1Close;
    // gates (same as live): session, near close, breakers, spacing
    if (!sess.open) { rejections["-:MARKET_CLOSED"] = (rejections["-:MARKET_CLOSED"] ?? 0) + 1; continue; }
    if (sess.minutesToClose != null && sess.minutesToClose <= cfg.protection.noNewEntriesBeforeCloseMin) { rejections["-:NEAR_CLOSE"] = (rejections["-:NEAR_CLOSE"] ?? 0) + 1; continue; }
    if (!risk) risk = freshRiskState(now, equity, cfg.breakers);
    const bk = checkBreakers(risk, now, equity, cfg.breakers); risk = bk.state;
    if (!bk.verdict.ok) { rejections[`-:${bk.verdict.code}`] = (rejections[`-:${bk.verdict.code}`] ?? 0) + 1; continue; }
    const sz = sizePosition({ side: cand.side, entry: cand.frozen.entryRef, stop: cand.plannedStop, equity, riskFraction: a.riskFraction, spec: SPEC, cfg: cfgSized.sizing, accountCurrency: "USD" });
    if (!sz.ok) { rejections[`-:${sz.code}`] = (rejections[`-:${sz.code}`] ?? 0) + 1; continue; }
    // Fill on the NEXT bar open with adverse slippage (we cannot trade the bar that produced the signal).
    const nb = bars[i + 1]; if (!nb) break;
    const slip = a.slippageTicks * tick;
    const entry = cand.side === "buy" ? +(nb.o + a.spread / 2 + slip).toFixed(2) : +(nb.o - a.spread / 2 - slip).toFixed(2);
    if (cand.side === "buy" ? entry >= cand.plannedTarget - 1 || entry <= cand.plannedStop : entry <= cand.plannedTarget + 1 || entry >= cand.plannedStop) { rejections["-:GAP_AT_OPEN"] = (rejections["-:GAP_AT_OPEN"] ?? 0) + 1; continue; }
    open = { side: cand.side, entry, stop: cand.plannedStop, target: cand.plannedTarget, qty: sz.qty, openedAt: nb.t, initialRisk: Math.abs(entry - cand.plannedStop), managementVersion: MANAGEMENT_VERSION, setupFamily: cand.family, invalidation: cand.invalidation, breakevenDone: false, family: cand.family, regime: cand.regime, atrPct: out.features.atrPercentile, openIdx: i + 1 };
    risk.lastEntryAt = now; lastEntryIdx = i;
    if (opts.log && trades.length % 25 === 0) opts.log(`bar ${i}/${bars.length} trades ${trades.length} equity ${equity.toFixed(2)}`);
  }
  void lastEntryIdx;

  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0), grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  const group = (key: (t: BtTrade) => string) => { const o: Record<string, { n: number; net: number; wins: number }> = {}; for (const t of trades) { const k = key(t); o[k] = o[k] ?? { n: 0, net: 0, wins: 0 }; o[k].n++; o[k].net = +(o[k].net + t.pnl).toFixed(2); if (t.pnl > 0) o[k].wins++; } return o; };
  const sorted = [...evalTimes].sort((x, y) => x - y); const qt = (p: number) => sorted.length ? +sorted[Math.floor(p * (sorted.length - 1))].toFixed(3) : NaN;
  const weeks = Math.max(1, (bars[bars.length - 1].t - bars[warm].t) / (7 * 86_400_000));
  return {
    label: a.label, strategyVersion: cfg.version, managementVersion: MANAGEMENT_VERSION, assumptions: a, bars: bars.length - warm, from: new Date(bars[warm].t).toISOString(), to: new Date(bars[bars.length - 1].t).toISOString(),
    trades: trades.length, wins: wins.length, losses: losses.length, timeouts: trades.filter((t) => t.reason === "time_stop").length, net: +net.toFixed(2), grossWin: +grossWin.toFixed(2), grossLoss: +grossLoss.toFixed(2),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null, expectancy: trades.length ? +(net / trades.length).toFixed(2) : 0, expectancyR: trades.length ? +(trades.reduce((s, t) => s + t.r, 0) / trades.length).toFixed(3) : 0,
    maxDrawdown: +maxDd.toFixed(2), maxDrawdownPct: +(100 * maxDdPct).toFixed(2), exposurePct: +(100 * barsInPosition / (bars.length - warm)).toFixed(2), avgHoldMin: trades.length ? Math.round(trades.reduce((s, t) => s + t.holdMin, 0) / trades.length) : 0, tradesPerWeek: +(trades.length / weeks).toFixed(2),
    byFamily: group((t) => t.family), byRegime: group((t) => t.regime), bySession: group((t) => t.session), byVol: group((t) => t.atrPct >= 0.8 ? "high-vol" : t.atrPct >= 0.4 ? "mid-vol" : "low-vol"), byQuarter: group((t) => quarterOf(t.openedAt)),
    rejections, candidatesSeen, evalP50Ms: qt(0.5), evalP95Ms: qt(0.95), evalP99Ms: qt(0.99), tradeSample: trades.slice(-40),
    notes: [
      "Quotes synthesized from reference M1 closes ± spread/2 — not broker ticks; live spreads vary by session.",
      "Bar-level fills; when a bar spans both stop and target the stop is counted first (conservative).",
      "Entry and stop exits charged the slippage allowance; target exits assumed at the target price.",
      "No parameter fitting on this data; defaults are prior hypotheses. Results are not a profitability claim.",
      "Session/maintenance handling uses the fallback schedule (22:00–23:00 UTC daily, weekend close).",
    ],
  };
}
