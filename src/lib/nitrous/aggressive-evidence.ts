const fields = ["rangeStartedAt", "rangeEndedAt", "edgeTime", "rangeLow", "rangeHigh",
  "candleOpenedAt", "candleClosedAt", "candleOpen", "candleHigh", "candleLow", "candleClose"] as const;
export type AggressiveEvidence = Record<(typeof fields)[number], number>;

/** Return only the observed range and completed signal candle. Stored payloads are untrusted. */
export function readAggressiveEvidence(value: unknown, family: string, side: "buy" | "sell", now: number): AggressiveEvidence | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const publicFields = {} as AggressiveEvidence;
  for (const key of fields) {
    const number = data[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) return null;
    publicFields[key] = number;
  }
  const e = publicFields;
  if (e.rangeStartedAt >= e.rangeEndedAt || e.rangeEndedAt > e.candleOpenedAt ||
      e.edgeTime < e.rangeStartedAt || e.edgeTime > e.rangeEndedAt || e.rangeLow >= e.rangeHigh ||
      e.candleClosedAt !== e.candleOpenedAt + 300_000 || e.candleClosedAt > now ||
      e.candleHigh < Math.max(e.candleOpen, e.candleClose) || e.candleLow > Math.min(e.candleOpen, e.candleClose)) return null;
  if (side === "buy" ? e.candleClose <= e.candleOpen : e.candleClose >= e.candleOpen) return null;
  if (family === "compression_breakout") return (side === "buy" ? e.candleClose > e.rangeHigh : e.candleClose < e.rangeLow) ? e : null;
  if (family === "range_edge_rejection") return e.candleClose > e.rangeLow && e.candleClose < e.rangeHigh ? e : null;
  return null;
}
