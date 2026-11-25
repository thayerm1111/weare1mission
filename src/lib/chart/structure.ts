export type StructureZone = {
  low: number;
  high: number;
  kind: "support" | "resistance";
  label?: string;
};

export function validStructureZone(zone: StructureZone): boolean {
  return !!zone && (zone.kind === "support" || zone.kind === "resistance")
    && Number.isFinite(zone.low) && Number.isFinite(zone.high) && zone.low > 0 && zone.high > zone.low;
}

/** Project real price bounds into the visible plot. Clipping must never widen a narrow price zone. */
export function priceBand(low: number, high: number, pLo: number, pHi: number, plotHeight: number): { top: number; height: number } | null {
  if (![low, high, pLo, pHi, plotHeight].every(Number.isFinite)
    || low <= 0 || high <= low || pHi <= pLo || plotHeight <= 0 || high <= pLo || low >= pHi) return null;
  const top = (pHi - Math.min(high, pHi)) / (pHi - pLo) * plotHeight;
  const bottom = (pHi - Math.max(low, pLo)) / (pHi - pLo) * plotHeight;
  return { top, height: bottom - top };
}

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;

/**
 * A candle is a session-break candle only when its entire interval falls in a scheduled closure.
 * The app's FX/metal calendars use hour boundaries and long open sessions: checking both edges and
 * every five minutes catches a reopening inside a 4h/day candle, including across NY DST changes.
 * Short bars are sampled each minute. Unsupported longer intervals remain unshaded rather than
 * claiming a closure from a single timestamp. This is calendar classification, not feed freshness.
 */
export function candleInSessionBreak(openedAt: number, tfMs: number, isOpenAt: (at: number) => boolean): boolean {
  const end = openedAt + tfMs;
  if (!Number.isFinite(openedAt) || !Number.isFinite(tfMs) || tfMs <= 0 || tfMs > DAY
    || !Number.isFinite(end) || Math.abs(openedAt) > 8.64e15 || Math.abs(end) > 8.64e15) return false;
  if (isOpenAt(openedAt) || isOpenAt(end - 1)) return false;
  const step = tfMs <= 60 * MINUTE ? MINUTE : 5 * MINUTE;
  for (let at = (Math.floor(openedAt / step) + 1) * step; at < end; at += step) {
    if (isOpenAt(at)) return false;
  }
  return true;
}
