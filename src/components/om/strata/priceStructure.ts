import { pivotsOf, validBars, type Bar, type Direction } from "../../../lib/strata/engine";

export type ChartFrame = "m5" | "m15" | "h1" | "h4";
export type PriceStructure = {
  swing: { t: number; price: number; label: "Swing low" | "Swing high" };
  reaction: "Recovery" | "Pullback" | null;
};

/** Read the selected timeframe's completed candles with STRATA's own confirmed-pivot rule. */
export function priceStructure(source: Bar[], side: Direction | undefined, price: number | null): PriceStructure | null {
  const bars = validBars(source).slice(-28);
  const pivots = pivotsOf(bars);
  const pivot = side ? pivots.filter(p => p.side === (side === "buy" ? "low" : "high")).at(-1) : pivots.at(-1);
  if (!pivot) return null;

  const low = pivot.side === "low";
  const after = bars.slice(pivot.index + 1);
  const candle = bars[pivot.index];
  const lastClose = after.at(-1)!.c;
  const holds = low
    ? after.every(b => b.l >= pivot.price) && lastClose > candle.h && price !== null && price > candle.h
    : after.every(b => b.h <= pivot.price) && lastClose < candle.l && price !== null && price < candle.l;
  return {
    swing: { t: pivot.t, price: pivot.price, label: low ? "Swing low" : "Swing high" },
    reaction: holds ? low ? "Recovery" : "Pullback" : null,
  };
}
