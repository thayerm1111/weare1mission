/**
 * MATTY PIPS — the eight deterministic 15-minute confirmation predicates.
 * All work on CLOSED candles only (the forming bar never confirms anything).
 * Each returned flag carries the actual numbers behind it for the audit log.
 */
import type { Candle, ConfirmationFlag, Zone } from "./types";

const f = (n: number) => (n >= 100 ? n.toFixed(1) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));

/**
 * Evaluate confirmations for a BUY at support / SELL at resistance.
 * `m15` is the raw series oldest→newest; the last element is the forming bar
 * and is excluded. `atr15` = ATR(14) on the 15M.
 */
export function confirmations(o: {
  side: "buy" | "sell";
  zone: Zone;
  m15: Candle[];
  atr15: number;
}): ConfirmationFlag[] {
  const closed = o.m15.slice(0, -1);
  if (closed.length < 10) return [];
  const k = closed[closed.length - 1];        // last closed candle
  const p = closed[closed.length - 2];        // the one before it
  const recent = closed.slice(-8);
  const range = Math.max(k.h - k.l, 1e-9);
  const body = Math.abs(k.c - k.o);
  const out: ConfirmationFlag[] = [];
  const z = o.zone;

  if (o.side === "buy") {
    const lowerWick = Math.min(k.o, k.c) - k.l;
    if (k.l <= z.zoneHigh && lowerWick / range >= 0.6 && k.c >= z.zoneHigh) {
      out.push({ key: "rejection_wick", label: "Rejection wick off the zone", detail: `Lower wick ${Math.round((lowerWick / range) * 100)}% of the bar, dipped to ${f(k.l)} and closed back above ${f(z.zoneHigh)}.` });
    }
    if (k.c > k.o && k.o <= p.c && k.c >= p.o && p.c < p.o && k.c > z.zoneHigh) {
      out.push({ key: "engulfing", label: "Bullish engulfing", detail: `Green body ${f(k.o)}→${f(k.c)} engulfed the prior red body and closed above the zone.` });
    }
    if (body / range >= 0.6 && (k.c - k.l) / range >= 0.75 && k.c > z.zoneHigh && k.c > k.o) {
      out.push({ key: "strong_close", label: "Strong close away from support", detail: `Body ${Math.round((body / range) * 100)}% of range, closed in the top quarter at ${f(k.c)}.` });
    }
    if (k.l < z.zoneLow && k.c > z.zoneLow) {
      out.push({ key: "failed_break", label: "Failed break of support", detail: `Traded ${f(k.l)} below the zone floor ${f(z.zoneLow)} and closed back at ${f(k.c)}.` });
    }
    const swept = recent.slice(-4, -1).some((b) => b.l < z.zoneLow);
    if (swept && k.c > z.zoneHigh) {
      out.push({ key: "reclaim_close", label: "Reclaim after the sweep", detail: `A recent bar swept below ${f(z.zoneLow)}; this one closed back above ${f(z.zoneHigh)}.` });
    }
    if (recent.length >= 3) {
      const [a, b, c] = recent.slice(-3);
      if (a.l < b.l && b.l < c.l && c.c > c.o) {
        out.push({ key: "micro_shift", label: "Higher lows forming (micro shift)", detail: `15M lows stepping up: ${f(a.l)} → ${f(b.l)} → ${f(c.l)}.` });
      }
    }
    const priorHigh = Math.max(...closed.slice(-7, -1).map((b) => b.h));
    if (k.c > priorHigh) {
      out.push({ key: "structure_shift", label: "15M structure break up", detail: `Closed ${f(k.c)} above the last minor swing high ${f(priorHigh)}.` });
    }
    if (range >= 1.5 * o.atr15 && k.c > k.o) {
      out.push({ key: "momentum_expansion", label: "Momentum expansion up", detail: `Bar range ${f(range)} ≥ 1.5×ATR15 (${f(o.atr15)}), closing green.` });
    }
  } else {
    const upperWick = k.h - Math.max(k.o, k.c);
    if (k.h >= z.zoneLow && upperWick / range >= 0.6 && k.c <= z.zoneLow) {
      out.push({ key: "rejection_wick", label: "Rejection wick off the zone", detail: `Upper wick ${Math.round((upperWick / range) * 100)}% of the bar, spiked to ${f(k.h)} and closed back below ${f(z.zoneLow)}.` });
    }
    if (k.c < k.o && k.o >= p.c && k.c <= p.o && p.c > p.o && k.c < z.zoneLow) {
      out.push({ key: "engulfing", label: "Bearish engulfing", detail: `Red body ${f(k.o)}→${f(k.c)} engulfed the prior green body and closed below the zone.` });
    }
    if (body / range >= 0.6 && (k.h - k.c) / range >= 0.75 && k.c < z.zoneLow && k.c < k.o) {
      out.push({ key: "strong_close", label: "Strong close away from resistance", detail: `Body ${Math.round((body / range) * 100)}% of range, closed in the bottom quarter at ${f(k.c)}.` });
    }
    if (k.h > z.zoneHigh && k.c < z.zoneHigh) {
      out.push({ key: "failed_break", label: "Failed break of resistance", detail: `Traded ${f(k.h)} above the zone ceiling ${f(z.zoneHigh)} and closed back at ${f(k.c)}.` });
    }
    const swept = recent.slice(-4, -1).some((b) => b.h > z.zoneHigh);
    if (swept && k.c < z.zoneLow) {
      out.push({ key: "reclaim_close", label: "Reclaim after the sweep", detail: `A recent bar swept above ${f(z.zoneHigh)}; this one closed back below ${f(z.zoneLow)}.` });
    }
    if (recent.length >= 3) {
      const [a, b, c] = recent.slice(-3);
      if (a.h > b.h && b.h > c.h && c.c < c.o) {
        out.push({ key: "micro_shift", label: "Lower highs forming (micro shift)", detail: `15M highs stepping down: ${f(a.h)} → ${f(b.h)} → ${f(c.h)}.` });
      }
    }
    const priorLow = Math.min(...closed.slice(-7, -1).map((b) => b.l));
    if (k.c < priorLow) {
      out.push({ key: "structure_shift", label: "15M structure break down", detail: `Closed ${f(k.c)} below the last minor swing low ${f(priorLow)}.` });
    }
    if (range >= 1.5 * o.atr15 && k.c < k.o) {
      out.push({ key: "momentum_expansion", label: "Momentum expansion down", detail: `Bar range ${f(range)} ≥ 1.5×ATR15 (${f(o.atr15)}), closing red.` });
    }
  }
  return out;
}
