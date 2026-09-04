/**
 * MATTY PIPS — supporting evidence + the two special decision paths:
 *  • Parabolic SAR + fractals (SUPPORTING evidence, never independent signals)
 *  • MOMENTUM CONTINUATION evaluator (break ran without a retest — chase or not?)
 *  • EXPANSION BREAKOUT evaluator (violent break — continuation / exhaustion / stand aside)
 */
import type { Candle, ExpansionOutcome, FractalRead, MomentumVerdict, SarRead } from "./types";
import { findPivots } from "./structure";

const f = (n: number) => (n >= 100 ? n.toFixed(1) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));

/** Standard Parabolic SAR (step 0.02, max 0.2) on closed candles. */
export function parabolicSar(candlesAll: Candle[], atr15: number): SarRead | null {
  const c = candlesAll.slice(0, -1);
  if (c.length < 20) return null;
  let up = c[1].c > c[0].c;
  let sar = up ? c[0].l : c[0].h;
  let ep = up ? c[0].h : c[0].l;
  let af = 0.02;
  let lastFlip = 0;
  for (let i = 1; i < c.length; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, c[i - 1].l, i >= 2 ? c[i - 2].l : c[i - 1].l);
      if (c[i].l < sar) { up = false; sar = ep; ep = c[i].l; af = 0.02; lastFlip = i; }
      else if (c[i].h > ep) { ep = c[i].h; af = Math.min(0.2, af + 0.02); }
    } else {
      sar = Math.max(sar, c[i - 1].h, i >= 2 ? c[i - 2].h : c[i - 1].h);
      if (c[i].h > sar) { up = true; sar = ep; ep = c[i].h; af = 0.02; lastFlip = i; }
      else if (c[i].l < ep) { ep = c[i].l; af = Math.min(0.2, af + 0.02); }
    }
  }
  const price = c[c.length - 1].c;
  return {
    dir: up ? "up" : "down",
    value: +sar.toFixed(4),
    distanceAtr: atr15 > 0 ? +(Math.abs(price - sar) / atr15).toFixed(2) : 0,
    flippedRecently: c.length - 1 - lastFlip <= 3,
  };
}

/** 15M fractal read: last confirmed fractal high/low + HL/LH sequences. */
export function fractalRead(m15: Candle[]): FractalRead {
  const piv = findPivots(m15.slice(0, -1), 2);
  const highs = piv.filter((p) => p.kind === "high").slice(-3);
  const lows = piv.filter((p) => p.kind === "low").slice(-3);
  return {
    lastHigh: highs.length ? highs[highs.length - 1].price : null,
    lastLow: lows.length ? lows[lows.length - 1].price : null,
    higherLows: lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price,
    lowerHighs: highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price,
  };
}

/**
 * MOMENTUM CONTINUATION evaluator — an accepted break ran without a retest.
 * Never chase automatically; never fade automatically. Deterministic verdict.
 */
export function continuationVerdict(o: {
  direction: "up" | "down";
  edge: number;                 // the broken level edge
  price: number;
  m15: Candle[];
  atr15: number;
  roomToNext: number | null;    // price distance to the next opposing level (null = open air)
  sar: SarRead | null;
  fractals: FractalRead;
}): { verdict: MomentumVerdict; detail: string } {
  const closed = o.m15.slice(0, -1);
  const k = closed[closed.length - 1];
  const range = Math.max(k.h - k.l, 1e-9);
  const body = Math.abs(k.c - k.o) / range;
  const traveled = o.direction === "up" ? o.price - o.edge : o.edge - o.price;
  const travelAtr = traveled / Math.max(o.atr15, 1e-9);
  const sarIntact = !o.sar || (o.direction === "up" ? o.sar.dir === "up" : o.sar.dir === "down");
  const structIntact = o.direction === "up" ? o.fractals.higherLows : o.fractals.lowerHighs;
  const closesStrong = o.direction === "up" ? (k.c - k.l) / range >= 0.6 && k.c > k.o : (k.h - k.c) / range >= 0.6 && k.c < k.o;
  // A sane continuation stop: last fractal on the trade side, within ~2×ATR.
  const contStop = o.direction === "up" ? o.fractals.lastLow : o.fractals.lastHigh;
  const stopDist = contStop != null ? Math.abs(o.price - contStop) : null;
  const stopSane = stopDist != null && stopDist <= 2.2 * o.atr15 && stopDist > 0;
  const roomOk = o.roomToNext == null || (stopDist != null ? o.roomToNext >= stopDist : o.roomToNext >= 1.0 * o.atr15);

  if (travelAtr > 3.0 || (!stopSane && travelAtr > 1.8)) {
    return { verdict: "TOO_EXTENDED_DO_NOT_CHASE", detail: `Already ${f(traveled)} (${travelAtr.toFixed(1)}×ATR15) past ${f(o.edge)} with ${stopSane ? "shrinking structure" : "no sane continuation stop"} — too extended to chase.` };
  }
  if (sarIntact && structIntact && closesStrong && body >= 0.45 && stopSane && roomOk) {
    return { verdict: "CONTINUATION_ENTRY_AVAILABLE", detail: `Momentum intact: ${o.direction === "up" ? "higher lows" : "lower highs"} on 15M, SAR ${o.sar ? o.sar.dir : "n/a"}, decisive close, continuation stop at ${f(contStop as number)} (${f(stopDist as number)}) with room ahead.` };
  }
  return { verdict: "WAIT_FOR_PULLBACK", detail: `Break is real but continuation isn't clean (structure ${structIntact ? "ok" : "unclear"}, SAR ${sarIntact ? "aligned" : "flipped"}, close ${closesStrong ? "strong" : "soft"}) — wait for the pullback toward ${f(o.edge)}.` };
}

/**
 * EXPANSION BREAKOUT evaluator — a violent break (huge candle / long travel).
 * Outcome A: pullback into the broken level / fractal area rejects + confirmed
 *            close in the break direction → CONTINUATION.
 * Outcome B: objective reversal evidence (close back into prior structure, SAR
 *            flip, opposite 15M structure) → EXHAUSTION_REVERSAL.
 * Outcome C: neither confirmed → STAND_ASIDE ("move confirmed, entry missed,
 *            waiting for new structure"). Never buy the top, never blind-fade.
 */
export function expansionOutcome(o: {
  direction: "up" | "down";
  edge: number;
  price: number;
  m15: Candle[];
  atr15: number;
  sar: SarRead | null;
  fractals: FractalRead;
}): { outcome: ExpansionOutcome; detail: string } {
  const closed = o.m15.slice(0, -1);
  const k = closed[closed.length - 1];
  const buf = 0.25 * o.atr15;
  const recent = closed.slice(-6);
  const up = o.direction === "up";

  // Reversal evidence: a close back through the broken edge into prior structure
  // + SAR flipped against the break + opposite 15M structure forming.
  const closedBackIn = up ? k.c < o.edge - buf : k.c > o.edge + buf;
  const sarAgainst = o.sar != null && (up ? o.sar.dir === "down" : o.sar.dir === "up");
  const oppStructure = up ? o.fractals.lowerHighs : o.fractals.higherLows;
  const evidence = [closedBackIn, sarAgainst, oppStructure].filter(Boolean).length;
  if (closedBackIn && evidence >= 2) {
    return { outcome: "EXHAUSTION_REVERSAL", detail: `Expansion exhausted: 15M closed back ${up ? "below" : "above"} ${f(o.edge)}${sarAgainst ? ", SAR flipped" : ""}${oppStructure ? `, ${up ? "lower highs" : "higher lows"} forming` : ""} — confirmed loss of control; opposite-direction setup can be valid.` };
  }

  // Continuation: retracement reached the broken level / fractal area, rejected it,
  // and a closed candle confirms the original direction.
  const pulledBack = recent.some((x) => up ? x.l <= o.edge + buf : x.h >= o.edge - buf)
    || (o.fractals.lastLow != null && up && recent.some((x) => x.l <= (o.fractals.lastLow as number) + buf))
    || (o.fractals.lastHigh != null && !up && recent.some((x) => x.h >= (o.fractals.lastHigh as number) - buf));
  const holding = up ? recent.every((x) => x.c > o.edge - buf) : recent.every((x) => x.c < o.edge + buf);
  const confirms = up ? k.c > k.o : k.c < k.o;
  if (pulledBack && holding && confirms) {
    return { outcome: "CONTINUATION", detail: `Pullback into the ${f(o.edge)} area held and a ${up ? "green" : "red"} 15M close confirms continuation ${up ? "higher" : "lower"}.` };
  }

  return { outcome: "STAND_ASIDE", detail: "MOVE CONFIRMED · ENTRY MISSED · WAITING FOR NEW STRUCTURE — too far to chase, no confirmed reversal. Missing a trade beats manufacturing a bad entry." };
}
