/**
 * MATTY PIPS — OUTCOME EVALUATOR. Grades one archived call against the
 * candles that printed AFTER it. Pure and chronological — bars are walked in
 * order and nothing later ever informs an earlier judgment (no lookahead), so
 * the same function serves the outcomes cron AND the backtest harness.
 *
 * Grading rules (pessimistic on ties — honesty over vanity):
 *   • WAIT_FOR_PRICE (limit) / BREAKOUT_ENTRY (stop) must FILL first: a bar
 *     must trade to the entry price. Unfilled after `unfilledBars` → UNFILLED.
 *   • After the fill, the first level TOUCHED decides: SL vs TP1/2/3 by bar
 *     high/low. If SL and a TP print inside the SAME bar, the STOP counts —
 *     never award a win the market may not have paid.
 *   • MFE/MAE tracked in dollars from entry; plus3BeforeMinus3 answers the
 *     owner's core question: did the $3 move come before a $3 drawdown?
 *   • Still open after `expiryBars` → EXPIRED, graded by sign of the last close.
 */
import type { Candle } from "./types";

export type OutcomeStatus = "pending" | "unfilled" | "win_tp1" | "win_tp2" | "win_tp3" | "loss" | "expired_win" | "expired_loss";

export type CallForGrading = {
  direction: "buy" | "sell";
  entry: number;                   // the plan's anchor price
  stopLoss: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  executionState?: "TAKE_NOW" | "WAIT_FOR_PRICE" | "BREAKOUT_ENTRY" | null;
};

export type OutcomeResult = {
  status: OutcomeStatus;
  firstHit: "sl" | "tp1" | "tp2" | "tp3" | null;
  filled: boolean;
  fillBarT: number | null;
  mfe: number;                     // max favorable excursion, $ from entry (≥0)
  mae: number;                     // max adverse excursion, $ from entry (≥0)
  plus3BeforeMinus3: boolean | null;   // null until decided or resolved
  barsUsed: number;
  resolvedAtT: number | null;      // bar time that resolved it
  lastClose: number | null;
};

export function evaluateCall(
  call: CallForGrading,
  bars: Candle[],                  // CLOSED bars strictly AFTER the call, chronological
  opts?: { unfilledBars?: number; expiryBars?: number },
): OutcomeResult {
  const up = call.direction === "buy";
  const state = call.executionState ?? "TAKE_NOW";
  const unfilledBars = opts?.unfilledBars ?? 96;   // e.g. 8h of 5M bars
  const expiryBars = opts?.expiryBars ?? 288;      // e.g. 24h of 5M bars

  let filled = state === "TAKE_NOW";               // market plans are live immediately
  let fillBarT: number | null = filled && bars.length ? bars[0].t : null;
  let mfe = 0, mae = 0;
  let plus3: boolean | null = null;
  let status: OutcomeStatus = "pending";
  let firstHit: OutcomeResult["firstHit"] = null;
  let resolvedAtT: number | null = null;
  let barsUsed = 0;
  let barsSinceStart = 0;

  const fav = (c: Candle) => (up ? c.h - call.entry : call.entry - c.l);
  const adv = (c: Candle) => (up ? call.entry - c.l : c.h - call.entry);
  const touched = (c: Candle, px: number) => c.l <= px && px <= c.h;
  const slHit = (c: Candle) => (up ? c.l <= call.stopLoss : c.h >= call.stopLoss);
  const tpHit = (c: Candle, tp: number) => (up ? c.h >= tp : c.l <= tp);

  for (const c of bars) {
    barsSinceStart++;
    if (!filled) {
      // LIMIT fills when price trades back to the entry; a breakout STOP fills
      // when price trades THROUGH it. Both reduce to "the bar touched entry".
      if (touched(c, call.entry) || (state === "BREAKOUT_ENTRY" && (up ? c.h >= call.entry : c.l <= call.entry))) {
        filled = true;
        fillBarT = c.t;
        // The fill bar itself can also resolve — fall through and grade it,
        // but pessimistically: a fill bar that also tags the stop is a LOSS.
      } else {
        if (barsSinceStart >= unfilledBars) { status = "unfilled"; resolvedAtT = c.t; barsUsed = barsSinceStart; break; }
        continue;
      }
    }
    barsUsed = barsSinceStart;
    mfe = Math.max(mfe, fav(c));
    mae = Math.max(mae, adv(c));
    if (plus3 === null) {
      // Pessimistic same-bar rule here too: the drawdown counts first.
      if (adv(c) >= 3) plus3 = false;
      else if (fav(c) >= 3) plus3 = true;
    }
    if (slHit(c)) { status = "loss"; firstHit = "sl"; resolvedAtT = c.t; break; }
    if (call.tp3 != null && tpHit(c, call.tp3)) { status = "win_tp3"; firstHit = "tp3"; resolvedAtT = c.t; break; }
    if (call.tp2 != null && tpHit(c, call.tp2)) { status = "win_tp2"; firstHit = "tp2"; resolvedAtT = c.t; break; }
    if (tpHit(c, call.tp1)) { status = "win_tp1"; firstHit = "tp1"; resolvedAtT = c.t; break; }
    if (barsSinceStart >= expiryBars) {
      const pnl = up ? c.c - call.entry : call.entry - c.c;
      status = pnl >= 0 ? "expired_win" : "expired_loss";
      resolvedAtT = c.t;
      break;
    }
  }

  return {
    status, firstHit, filled, fillBarT,
    mfe: r2(mfe), mae: r2(mae), plus3BeforeMinus3: plus3,
    barsUsed, resolvedAtT,
    lastClose: bars.length ? bars[bars.length - 1].c : null,
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
