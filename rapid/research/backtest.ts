import type { Bar, Setup, Side } from "../core/types";
import { dirOf } from "../core/types";
import { DEFAULT_CONFIG, type RapidConfig } from "../config/defaults";
import { buildSnapshot } from "../engine/snapshot";
import { findPivots } from "../engine/structure";
import { atr } from "../market/bars";
import { GOLD_SESSION, isSessionOpen } from "../market/session";
import { breakevenStop, breakevenTrigger, changeOfCharacter, type ManagedTrade } from "../engine/manage";
import { sizePosition } from "../risk/sizing";
import { goldSpec } from "../exec/simulator";
import type { Window } from "./loader";

/**
 * Replay.
 *
 * The same `buildSnapshot` the live worker calls produces the candidates, so a result here is a
 * result about the thing that would actually run. What replay CANNOT do honestly, and does not
 * pretend to:
 *
 *   - Intrabar order. With 5-minute OHLC there is no way to know whether the high or the low came
 *     first. A bar that touches both the entry and the stop is AMBIGUOUS. Every ambiguous bar is
 *     resolved ADVERSELY (stopped), and the count is reported, so the number cannot be quietly
 *     flattering.
 *   - Real spread. The archive has no bid/ask, so a fixed spread assumption is applied and named.
 *   - Queue position, rejects, and requotes. Modelled as a slippage allowance, not as certainty.
 *
 * Anything this produces is a HYPOTHESIS about the rules, not evidence about the market.
 */

export type BacktestOptions = {
  cfg?: RapidConfig;
  /** Assumed spread in price units. The archive contains no bid/ask. */
  spread?: number;
  equity?: number;
  riskPct?: number;
  /** Re-evaluate the engine every N closed M5 bars. 1 is every bar. */
  everyBars?: number;
  /** Management ON or OFF, so the two can be compared rather than assumed. */
  management?: boolean;
  /**
   * Rolling history handed to the engine, in M5 bars. The live worker keeps a bounded window too, so
   * this is not a shortcut — replaying with unbounded history would give the engine MORE context than
   * production has. 900 bars is a little over three session days, enough for the daily context and
   * the 48-bar range lookback.
   */
  historyBars?: number;
};

export type Trade = {
  window: string;
  phase: Window["phase"];
  family: Setup["family"];
  side: Side;
  entryAt: number;
  entry: number;
  stop: number;
  target: number;
  qty: number;
  riskAmount: number;
  exitAt: number;
  exit: number;
  exitReason: "target" | "stop" | "breakeven" | "change_of_character" | "session_end" | "ambiguous_adverse";
  priceMove: number;
  r: number;
  pnl: number;
  mfe: number;
  mae: number;
  barsHeld: number;
  ambiguousBar: boolean;
};

export type BacktestResult = {
  window: string;
  phase: Window["phase"];
  bars: number;
  from: string;
  to: string;
  evaluations: number;
  candidates: number;
  trades: Trade[];
  /** Every reason a candidate did not become a trade, counted. */
  funnel: Record<string, number>;
  ambiguousBars: number;
  coverageNote: string;
};

const M5 = 300_000;

export function runWindow(w: Window, opts: BacktestOptions = {}): BacktestResult {
  const cfg = opts.cfg ?? DEFAULT_CONFIG;
  const spread = opts.spread ?? 0.35;
  const equity = opts.equity ?? 10_000;
  const riskPct = opts.riskPct ?? cfg.risk.defaultPct;
  const every = Math.max(1, opts.everyBars ?? 1);
  const management = opts.management !== false;
  const history = Math.max(200, opts.historyBars ?? 900);

  const funnel: Record<string, number> = {};
  const bump = (k: string) => { funnel[k] = (funnel[k] ?? 0) + 1; };

  const trades: Trade[] = [];
  let evaluations = 0;
  let candidates = 0;
  let ambiguousBars = 0;
  let open: (ManagedTrade & { setup: Setup; entryIdx: number; qty: number; riskAmount: number; mfe: number; mae: number; ambiguous: boolean }) | null = null;

  const bars = w.bars;
  const warm = Math.max(cfg.feed.warmupBars, cfg.range.lookbackBars) + 10;

  // The bar a fill happened on is not also managed: we do not know where inside it we filled.
  let skipUntil = -1;
  for (let i = warm; i < bars.length; i++) {
    const bar = bars[i];
    if (i <= skipUntil) continue;
    const asOf = bar.t + M5; // this bar has just closed
    const closed = bars.slice(Math.max(0, i + 1 - history), i + 1);

    // ---- Manage an open position on this bar, before considering anything new. ----------------
    if (open) {
      const d = dirOf(open.side);
      const hitTarget = d === 1 ? bar.h >= open.target : bar.l <= open.target;
      const hitStop = d === 1 ? bar.l <= open.currentStop : bar.h >= open.currentStop;
      open.mfe = Math.max(open.mfe, d * ((d === 1 ? bar.h : bar.l) - open.entry));
      open.mae = Math.min(open.mae, d * ((d === 1 ? bar.l : bar.h) - open.entry));

      if (hitTarget && hitStop) {
        // Both inside one bar and no way to know which came first. Resolved adversely, counted.
        ambiguousBars++;
        close(open, open.currentStop, asOf, "ambiguous_adverse", i, true);
        open = null;
        continue;
      }
      if (hitStop) { close(open, open.currentStop, asOf, open.breakevenDone ? "breakeven" : "stop", i, false); open = null; continue; }
      if (hitTarget) { close(open, open.target, asOf, "target", i, false); open = null; continue; }

      if (management) {
        // Breakeven, evaluated on the bar's favourable extreme.
        if (!open.breakevenDone) {
          const best = d === 1 ? bar.h : bar.l;
          if (d * (best - open.entry) >= breakevenTrigger(open, cfg)) {
            const be = breakevenStop(open, 0.01);
            if (d * (be - open.currentStop) > 0) { open.currentStop = be; open.breakevenDone = true; }
          }
        }
        // Change of character on the completed bar.
        const pivots = findPivots(closed, "M5", cfg.structure.pivotLeft, cfg.structure.pivotRight);
        const coc = changeOfCharacter(open, closed, pivots, asOf, cfg);
        if (coc.exit) {
          // Exits at the NEXT available price, not at the close that produced the signal.
          const next = bars[i + 1];
          if (next) { close(open, next.o, next.t + M5, "change_of_character", i + 1, false); open = null; continue; }
        }
      }
      continue; // one position at a time
    }

    if (i % every !== 0) continue;
    if (!isSessionOpen(asOf, GOLD_SESSION)) { bump("session_closed"); continue; }

    evaluations++;
    const snap = buildSnapshot({
      asOf,
      cfg,
      tick: 0.01,
      contractSize: 100,
      minStopDistance: 0.1,
      m1: closed, // the archive's M5 bars are the finest resolution available here
      higher: { M5: closed },
      // A synthetic executable quote from the close plus the assumed spread, clearly an assumption.
      quote: { source: "broker", bid: bar.c - spread / 2, ask: bar.c + spread / 2, providerTs: asOf, providerTsPrecision: "ms", receivedAt: asOf, seq: `${asOf}` },
    });

    for (const r of snap.rejections) bump(r.code);
    if (!snap.scenarios.length) continue;

    const setup = snap.scenarios[0];
    candidates++;

    // The setup only became knowable when THIS bar closed, so the earliest possible fill is the
    // NEXT bar. Filling on the bar whose close produced the signal is look-ahead, and it flatters
    // the result badly: it lets the engine buy a low it could not have known was a low.
    const entryBar = bars[i + 1];
    if (!entryBar) { bump("no_next_bar"); continue; }

    const want = setup.side === "buy" ? setup.entryBandHigh : setup.entryBandLow;
    const touched = entryBar.l <= setup.entryBandHigh && entryBar.h >= setup.entryBandLow;
    if (!touched) { bump("band_not_touched"); continue; }

    // A bar that opens already beyond the band gapped through the level; there was no touch to
    // enter on. Otherwise the fill is the worse of the band edge and the open — never a price that
    // was not actually available.
    const gappedPast = setup.side === "buy" ? entryBar.o < setup.entryBandLow : entryBar.o > setup.entryBandHigh;
    if (gappedPast) { bump("gapped_through"); continue; }
    const base = setup.side === "buy" ? Math.min(want, entryBar.o) : Math.max(want, entryBar.o);
    const fill = setup.side === "buy" ? base + spread / 2 : base - spread / 2;
    const size = sizePosition({ side: setup.side, executable: fill, stop: setup.stop, equity, riskPct, spec: goldSpec, conversionRate: 1, cfg });
    if (!size.ok) { bump(`sizing:${size.reason.slice(0, 24)}`); continue; }

    const a = atr(closed, cfg.structure.atrPeriod) ?? setup.tolerances.atrEntry;
    open = {
      // The fill happened on bar i+1, so that is where the hold starts.
      setup, entryIdx: i + 1, qty: size.qty, riskAmount: size.estimatedRisk, mfe: 0, mae: 0, ambiguous: false,
      side: setup.side, entry: fill, initialStop: setup.stop, currentStop: setup.stop, target: setup.target,
      originalQty: size.qty, currentQty: size.qty, atrAtFill: a, costPrice: 0,
      breakevenDone: false, partialDone: false, managementVersion: cfg.managementVersion, protectedSwing: setup.invalidation,
    };
    skipUntil = i + 1;
  }

  // A position still open at the end of the window is closed at the last price, and labelled.
  if (open) close(open, bars[bars.length - 1].c, bars[bars.length - 1].t + M5, "session_end", bars.length - 1, false);

  function close(
    t: NonNullable<typeof open>, exit: number, at: number,
    reason: Trade["exitReason"], idx: number, ambiguous: boolean,
  ) {
    const d = dirOf(t.side);
    const move = d * (exit - t.entry);
    const risk = Math.abs(t.entry - t.initialStop);
    trades.push({
      window: w.name, phase: w.phase, family: t.setup.family, side: t.side,
      entryAt: bars[t.entryIdx].t, entry: t.entry, stop: t.initialStop, target: t.target,
      qty: t.qty, riskAmount: t.riskAmount, exitAt: at, exit, exitReason: reason,
      priceMove: move, r: risk > 0 ? move / risk : 0, pnl: move * t.qty * 100,
      mfe: t.mfe, mae: t.mae, barsHeld: idx - t.entryIdx, ambiguousBar: ambiguous,
    });
  }

  return {
    window: w.name, phase: w.phase, bars: bars.length,
    from: new Date(bars[0].t).toISOString(), to: new Date(bars[bars.length - 1].t).toISOString(),
    evaluations, candidates, trades, funnel, ambiguousBars,
    coverageNote: `5-minute OHLC only; ${w.gaps} gap(s) preserved; spread assumed at ${spread}`,
  };
}

// -------------------------------------------------------------------------------------------------

export type Summary = {
  trades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number | null;
  netR: number;
  expectancyR: number | null;
  netPnl: number;
  expectancyPnl: number | null;
  profitFactor: number | null;
  maxDrawdownR: number;
  medianMfe: number;
  medianMae: number;
  medianBarsHeld: number;
  ambiguous: number;
  /** Rough 95% interval on expectancy in R. Wide is the honest answer on a small sample. */
  expectancyCi: [number, number] | null;
  byFamily: Record<string, { n: number; netR: number }>;
  byExit: Record<string, number>;
};

export function summarise(trades: Trade[]): Summary {
  const n = trades.length;
  const rs = trades.map((t) => t.r);
  const netR = rs.reduce((a, b) => a + b, 0);
  const netPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const wins = trades.filter((t) => t.r > 0.02).length;
  const losses = trades.filter((t) => t.r < -0.02).length;
  const breakevens = n - wins - losses;
  const gross = trades.filter((t) => t.r > 0).reduce((a, t) => a + t.r, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.r < 0).reduce((a, t) => a + t.r, 0));

  let peak = 0, equity = 0, dd = 0;
  for (const t of trades) { equity += t.r; peak = Math.max(peak, equity); dd = Math.min(dd, equity - peak); }

  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  const mean = n ? netR / n : null;
  let ci: [number, number] | null = null;
  if (n >= 2 && mean != null) {
    const variance = rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1);
    const se = Math.sqrt(variance / n);
    ci = [Number((mean - 1.96 * se).toFixed(3)), Number((mean + 1.96 * se).toFixed(3))];
  }

  const byFamily: Summary["byFamily"] = {};
  for (const t of trades) {
    byFamily[t.family] = byFamily[t.family] ?? { n: 0, netR: 0 };
    byFamily[t.family].n++;
    byFamily[t.family].netR += t.r;
  }
  const byExit: Record<string, number> = {};
  for (const t of trades) byExit[t.exitReason] = (byExit[t.exitReason] ?? 0) + 1;

  return {
    trades: n, wins, losses, breakevens,
    winRate: n ? wins / n : null,
    netR: Number(netR.toFixed(3)),
    expectancyR: mean == null ? null : Number(mean.toFixed(4)),
    netPnl: Number(netPnl.toFixed(2)),
    expectancyPnl: n ? Number((netPnl / n).toFixed(2)) : null,
    profitFactor: grossLoss > 0 ? Number((gross / grossLoss).toFixed(3)) : null,
    maxDrawdownR: Number(dd.toFixed(3)),
    medianMfe: Number(med(trades.map((t) => t.mfe)).toFixed(2)),
    medianMae: Number(med(trades.map((t) => t.mae)).toFixed(2)),
    medianBarsHeld: med(trades.map((t) => t.barsHeld)),
    ambiguous: trades.filter((t) => t.ambiguousBar).length,
    expectancyCi: ci,
    byFamily, byExit,
  };
}
