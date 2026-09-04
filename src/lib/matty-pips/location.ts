/**
 * MATTY PIPS — WHERE is price inside the structure? Location is half the trade.
 */
import type { Candle, LocationState, Zone } from "./types";

export function rangePosition(price: number, recentLow: number, recentHigh: number): number {
  if (!(recentHigh > recentLow)) return 50;
  return Math.max(0, Math.min(100, Math.round(((price - recentLow) / (recentHigh - recentLow)) * 100)));
}

/**
 * Location state from price vs the nearest zones. `atr1h` sizes "near" (0.5×ATR)
 * and `m15` decides whether a poke beyond a zone has CONFIRMED (15M close beyond
 * the edge + buffer) or is still just BREAKING.
 */
export function locate(o: {
  price: number;
  nearestSupport: Zone | null;
  nearestResistance: Zone | null;
  atr1h: number;
  m15: Candle[];
  atr15: number;
  rangePos: number;
}): LocationState {
  const near = 0.5 * o.atr1h;
  const buf = 0.25 * o.atr15;
  const lastClosed = o.m15.length >= 2 ? o.m15[o.m15.length - 2] : null;
  const s = o.nearestSupport, r = o.nearestResistance;

  // Beyond a zone?
  if (r && o.price > r.zoneHigh) {
    return lastClosed && lastClosed.c > r.zoneHigh + buf ? "ABOVE_RESISTANCE" : "BREAKING_RESISTANCE";
  }
  if (s && o.price < s.zoneLow) {
    return lastClosed && lastClosed.c < s.zoneLow - buf ? "BELOW_SUPPORT" : "BREAKING_SUPPORT";
  }
  // Inside a zone?
  if (s && o.price >= s.zoneLow && o.price <= s.zoneHigh) return "AT_SUPPORT";
  if (r && o.price >= r.zoneLow && o.price <= r.zoneHigh) return "AT_RESISTANCE";
  // Near a zone?
  if (s && o.price - s.zoneHigh <= near && o.price > s.zoneHigh) return "NEAR_SUPPORT";
  if (r && r.zoneLow - o.price <= near && o.price < r.zoneLow) return "NEAR_RESISTANCE";
  return "MIDDLE_OF_RANGE";
}
