/**
 * MATTY PIPS — EXPECTED PATH ENGINE. A structured, drawable sketch of HOW the
 * engine expects price to travel — not a straight arrow. The chart renders
 * this as a polyline from "now", through the entry behavior the execution
 * state implies (pullback / break), then TP1 → TP2. Deterministic geometry
 * from the decision itself; no forecasting model.
 */
import type { EntryPlan, ExecutionState } from "./execution";

export type PathPoint = { label: string; price: number };

const r2 = (n: number) => Math.round(n * 100) / 100;

export function expectedPath(o: {
  direction: "buy" | "sell";
  price: number;
  atr15: number;
  state: ExecutionState;
  entry: EntryPlan;
  tp1: number;
  tp2: number | null;
}): PathPoint[] {
  const up = o.direction === "buy";
  const pts: PathPoint[] = [{ label: "NOW", price: r2(o.price) }];

  if (o.state === "WAIT_FOR_PRICE") {
    pts.push({ label: "PULLBACK", price: r2(o.entry.price) });
  } else if (o.state === "BREAKOUT_ENTRY") {
    // A last press into the level, then the break trigger.
    const press = up ? Math.min(o.price, o.entry.zoneLow) : Math.max(o.price, o.entry.zoneHigh);
    if (Math.abs(press - o.price) > 0.05) pts.push({ label: "PRESS", price: r2(press) });
    pts.push({ label: "BREAK", price: r2(o.entry.price) });
  } else {
    // TAKE_NOW — allow the ordinary small dip toward the zone edge first.
    const dip = up ? o.entry.price - 0.3 * o.atr15 : o.entry.price + 0.3 * o.atr15;
    if (up ? dip < o.price : dip > o.price) pts.push({ label: "DIP", price: r2(dip) });
    pts.push({ label: "GO", price: r2(o.entry.price) });
  }

  pts.push({ label: "TP1", price: r2(o.tp1) });
  if (o.tp2 != null) {
    // Ordinary partial retrace between targets, then the extension.
    const mid = up ? o.tp1 - 0.25 * o.atr15 : o.tp1 + 0.25 * o.atr15;
    pts.push({ label: "HOLD", price: r2(mid) });
    pts.push({ label: "TP2", price: r2(o.tp2) });
  }
  return pts;
}
