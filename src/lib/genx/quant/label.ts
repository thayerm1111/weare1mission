/**
 * PATH LABELS — the only question that matters for a trade: from this bar, did price reach the TARGET before
 * the STOP? Labelled by walking the candles forward, exactly as the trade would have lived. A bar where
 * neither is reached inside the horizon is dropped, not counted as a win.
 */
import { type Bar } from "./features";

export type Geometry = { tpPips: number; slPips: number; horizonBars: number; pip: number };

/** 1 = target first, 0 = stop first, null = neither inside the horizon (unusable for training). */
export function labelPath(bars: Bar[], i: number, side: "buy" | "sell", g: Geometry): 0 | 1 | null {
  const entry = bars[i].c;
  const d = side === "buy" ? 1 : -1;
  const tp = entry + d * g.tpPips * g.pip;
  const sl = entry - d * g.slPips * g.pip;
  const end = Math.min(bars.length - 1, i + g.horizonBars);
  for (let k = i + 1; k <= end; k++) {
    const b = bars[k];
    const hitTp = side === "buy" ? b.h >= tp : b.l <= tp;
    const hitSl = side === "buy" ? b.l <= sl : b.h >= sl;
    if (hitTp && hitSl) return 0;            // both in one bar → assume the bad one (never flatter the model)
    if (hitTp) return 1;
    if (hitSl) return 0;
  }
  return null;
}

/** Break-even hit rate for a geometry: below this, the trade loses money however good it feels. */
export const breakEvenRate = (g: Pick<Geometry, "tpPips" | "slPips">) => g.slPips / (g.tpPips + g.slPips);

/** Expected pips per trade at a given hit rate — the number that decides whether to take it. */
export function expectancy(p: number, g: Pick<Geometry, "tpPips" | "slPips">, costPips = 3): number {
  return p * g.tpPips - (1 - p) * g.slPips - costPips;
}
