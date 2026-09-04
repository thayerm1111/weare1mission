/**
 * MATTY PIPS — support/resistance ZONES (never single lines).
 * Pivots + wick extremes from Daily (weight 3), 4H (2), 1H (1) cluster into
 * volatility-sized zones, scored by touches, reactions, confluence, freshness.
 * Only the strongest 3 above and 3 below price survive — no level flooding.
 */
import type { Candle, Timeframe, Zone } from "./types";
import { findPivots, atr } from "./structure";

type Point = { price: number; weight: number; t: number; tf: Timeframe };

const TF_WEIGHT: Record<string, number> = { D: 3, H4: 2, H1: 1 };

function collectPoints(tf: Timeframe, candles: Candle[]): Point[] {
  const w = TF_WEIGHT[tf] ?? 1;
  return findPivots(candles, 2).map((p) => ({ price: p.price, weight: w, t: p.t, tf }));
}

/**
 * Build merged zones from D/4H/1H pivots. Width is volatility-based:
 * at least 0.25×ATR(1H), at most 1.0×ATR(1H). Cluster radius 0.5×ATR(1H).
 */
export function buildZones(o: { d: Candle[]; h4: Candle[]; h1: Candle[]; price: number }): Zone[] {
  const atr1h = atr(o.h1) || 1e-9;
  const pts = [
    ...collectPoints("D", o.d),
    ...collectPoints("H4", o.h4),
    ...collectPoints("H1", o.h1),
  ].sort((a, b) => a.price - b.price);
  if (!pts.length) return [];

  // Greedy clustering: points within 0.5×ATR(1H) of the cluster's weighted center merge.
  const clusters: Point[][] = [];
  for (const p of pts) {
    const cur = clusters[clusters.length - 1];
    if (cur) {
      const center = cur.reduce((s, x) => s + x.price * x.weight, 0) / cur.reduce((s, x) => s + x.weight, 0);
      if (Math.abs(p.price - center) <= 0.5 * atr1h) { cur.push(p); continue; }
    }
    clusters.push([p]);
  }

  const zones: Zone[] = [];
  for (const cl of clusters) {
    if (cl.reduce((s, x) => s + x.weight, 0) < 2) continue; // a lone 1H pivot is not a zone
    let lo = Math.min(...cl.map((x) => x.price));
    let hi = Math.max(...cl.map((x) => x.price));
    const center = (lo + hi) / 2;
    // Volatility-based width: floor 0.25×ATR(1H), cap 1.0×ATR(1H).
    if (hi - lo < 0.25 * atr1h) { lo = center - 0.125 * atr1h; hi = center + 0.125 * atr1h; }
    if (hi - lo > 1.0 * atr1h) { lo = center - 0.5 * atr1h; hi = center + 0.5 * atr1h; }

    // Touches + reactions measured on the 1H series.
    let touches = 0, lastTouchT = 0, lastTouchIdx = -1, reactionSum = 0, reactionN = 0;
    let closedThrough = false, cameBack = false;
    for (let i = 0; i < o.h1.length; i++) {
      const k = o.h1[i];
      const entered = k.l <= hi && k.h >= lo;
      if (entered) {
        touches++;
        lastTouchT = k.t; lastTouchIdx = i;
        // reaction: max excursion away from the zone over the next 8 bars, in ATR units
        let best = 0;
        for (let j = i + 1; j < Math.min(o.h1.length, i + 9); j++) {
          best = Math.max(best, Math.max(lo - o.h1[j].l, o.h1[j].h - hi, 0));
        }
        if (best > 0) { reactionSum += best / atr1h; reactionN++; }
      }
      if (k.c > hi || k.c < lo) {
        // note closes through for the break-and-retest tag
        if ((k.c > hi && o.price < hi) || (k.c < lo && o.price > lo)) closedThrough = true;
      }
      if (closedThrough && entered) cameBack = true;
    }

    const tfs = [...new Set(cl.map((x) => x.tf))] as Timeframe[];
    const weightSum = cl.reduce((s, x) => s + x.weight, 0);
    const freshness = lastTouchIdx >= 0 ? o.h1.length - 1 - lastTouchIdx : o.h1.length;
    const avgReaction = reactionN ? reactionSum / reactionN : 0;

    // strengthScore 0–100: confluence 40, touches 25, reaction 25, minus staleness.
    const confluence = Math.min(1, weightSum / 8);
    const touchScore = Math.min(1, touches / 6);
    const reactScore = Math.min(1, avgReaction / 1.5);
    const staleness = Math.min(1, freshness / 120); // fades over ~5 days of 1H bars
    const strength = Math.max(0, Math.round(40 * confluence + 25 * touchScore + 25 * reactScore + 10 * (1 - staleness)));

    zones.push({
      zoneLow: lo, zoneHigh: hi,
      zoneType: center <= o.price ? "support" : "resistance",
      timeframes: tfs,
      touchCount: touches,
      freshness,
      strengthScore: strength,
      lastReactionTime: lastTouchT ? new Date(lastTouchT).toISOString() : null,
      brokeAndRetested: cameBack,
    });
  }

  // Strongest 3 below + 3 above the live price. No flooding.
  const sup = zones.filter((z) => z.zoneType === "support").sort((a, b) => b.strengthScore - a.strengthScore).slice(0, 3);
  const res = zones.filter((z) => z.zoneType === "resistance").sort((a, b) => b.strengthScore - a.strengthScore).slice(0, 3);
  return [...sup, ...res].sort((a, b) => a.zoneLow - b.zoneLow);
}

/** Nearest zone of a type relative to the live price. */
export function nearestZone(zones: Zone[], price: number, type: "support" | "resistance"): Zone | null {
  const pool = zones.filter((z) => z.zoneType === type);
  if (!pool.length) return null;
  return pool.sort((a, b) => {
    const da = type === "support" ? Math.abs(price - a.zoneHigh) : Math.abs(a.zoneLow - price);
    const db = type === "support" ? Math.abs(price - b.zoneHigh) : Math.abs(b.zoneLow - price);
    return da - db;
  })[0];
}
