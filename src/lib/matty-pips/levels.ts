/**
 * MATTY PIPS — the level map. Time-based levels (week/day highs and lows) +
 * structural highs/lows + S/R zones, RANKED (not all levels are equal) and
 * grouped into RESISTANCE/SUPPORT COMPLEXES when they sit close together
 * relative to volatility. Every level carries WHY it matters (its sources),
 * and overlapping sources create confluence — e.g. Previous Day High + recent
 * structural high + a 4H zone merge into one high-quality resistance level.
 */
import type { Candle, LevelComplex, LevelSource, RankedLevel, Zone } from "./types";

const SOURCE_WEIGHT: Record<LevelSource, number> = {
  WEEK_HIGH: 25, WEEK_LOW: 25,
  PREV_DAY_HIGH: 18, PREV_DAY_LOW: 18,
  DAY_HIGH: 12, DAY_LOW: 12,
  STRUCT_HIGH: 20, STRUCT_LOW: 20,
  ZONE_D: 20, ZONE_H4: 14, ZONE_H1: 8,
};

type Seed = { low: number; high: number; sources: LevelSource[]; touches: number; freshness: number; retested: boolean };

/** UTC start-of-week (Monday) for grouping daily candles. */
function weekKey(t: number): string {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return mon.toISOString().slice(0, 10);
}

/**
 * Build the ranked level map.
 * `d` daily candles oldest→newest (last row = current, forming, day);
 * `zones` from zones.ts; struct highs/lows from structure.ts meaningfulRange.
 */
export function buildLevels(o: {
  d: Candle[];
  zones: Zone[];
  structHigh: number; structLow: number;
  price: number;
  atr1h: number;
}): { levels: RankedLevel[]; complexes: LevelComplex[] } {
  const band = Math.max(0.15 * o.atr1h, 1e-9); // half-width for point levels
  const seeds: Seed[] = [];
  const point = (px: number, src: LevelSource) =>
    seeds.push({ low: px - band, high: px + band, sources: [src], touches: 0, freshness: 0, retested: false });

  // Time-based levels from the daily series.
  const n = o.d.length;
  if (n >= 2) {
    const today = o.d[n - 1];             // forming day
    const prev = o.d[n - 2];              // previous completed day
    point(today.h, "DAY_HIGH"); point(today.l, "DAY_LOW");
    point(prev.h, "PREV_DAY_HIGH"); point(prev.l, "PREV_DAY_LOW");
    const wk = weekKey(today.t);
    const thisWeek = o.d.filter((c) => weekKey(c.t) === wk);
    if (thisWeek.length) {
      point(Math.max(...thisWeek.map((c) => c.h)), "WEEK_HIGH");
      point(Math.min(...thisWeek.map((c) => c.l)), "WEEK_LOW");
    }
  }
  // Meaningful structural high/low.
  if (Number.isFinite(o.structHigh)) point(o.structHigh, "STRUCT_HIGH");
  if (Number.isFinite(o.structLow)) point(o.structLow, "STRUCT_LOW");
  // S/R zones (already volatility-sized bands with touch history).
  for (const z of o.zones) {
    const src: LevelSource = z.timeframes.includes("D") ? "ZONE_D" : z.timeframes.includes("H4") ? "ZONE_H4" : "ZONE_H1";
    seeds.push({ low: z.zoneLow, high: z.zoneHigh, sources: [src], touches: z.touchCount, freshness: z.freshness, retested: z.brokeAndRetested });
  }

  // MERGE overlapping/near seeds (within 0.3×ATR1H) — overlap = confluence.
  seeds.sort((a, b) => (a.low + a.high) - (b.low + b.high));
  const merged: Seed[] = [];
  for (const s of seeds) {
    const last = merged[merged.length - 1];
    if (last && s.low <= last.high + 0.3 * o.atr1h) {
      last.low = Math.min(last.low, s.low); last.high = Math.max(last.high, s.high);
      last.sources = [...new Set([...last.sources, ...s.sources])];
      last.touches = Math.max(last.touches, s.touches);
      last.freshness = Math.min(last.freshness || s.freshness, s.freshness || last.freshness);
      last.retested = last.retested || s.retested;
    } else merged.push({ ...s });
  }

  // RANK each merged level.
  const levels: RankedLevel[] = merged.map((s) => {
    const srcScore = s.sources.reduce((acc, x) => acc + SOURCE_WEIGHT[x], 0);
    const confluence = s.sources.length > 1 ? 8 * (s.sources.length - 1) : 0;
    const rank = Math.min(100, Math.round(
      Math.min(55, srcScore) + confluence + Math.min(15, s.touches * 3) + (s.retested ? 8 : 0)
      - Math.min(10, s.freshness / 24),
    ));
    const mid = (s.low + s.high) / 2;
    return {
      low: s.low, high: s.high,
      kind: mid <= o.price ? "support" as const : "resistance" as const,
      sources: s.sources, rank,
      touches: s.touches, freshness: s.freshness, brokeAndRetested: s.retested,
      complexId: null,
    };
  }).sort((a, b) => b.rank - a.rank).slice(0, 10); // top 10, no flooding

  // COMPLEXES — same-kind levels whose gap < 0.8×ATR1H form one broader structure.
  const complexes: LevelComplex[] = [];
  for (const kind of ["support", "resistance"] as const) {
    const ks = levels.filter((l) => l.kind === kind).sort((a, b) => a.low - b.low);
    let group: RankedLevel[] = [];
    const flush = () => {
      if (group.length >= 2) {
        const id = complexes.length + 1;
        for (const g of group) g.complexId = id;
        complexes.push({
          id, kind,
          low: Math.min(...group.map((g) => g.low)),
          high: Math.max(...group.map((g) => g.high)),
          members: group.length,
          sources: [...new Set(group.flatMap((g) => g.sources))],
          rank: Math.min(100, Math.round(Math.max(...group.map((g) => g.rank)) + 6 * (group.length - 1))),
        });
      }
      group = [];
    };
    for (const l of ks) {
      const last = group[group.length - 1];
      if (last && l.low - last.high < 0.8 * o.atr1h) group.push(l);
      else { flush(); group = [l]; }
    }
    flush();
  }

  return { levels: levels.sort((a, b) => a.low - b.low), complexes };
}

/** The level/complex price is interacting with (inside, or nearest within reach). */
export function activeNode(o: { levels: RankedLevel[]; complexes: LevelComplex[]; price: number; atr1h: number }):
  { low: number; high: number; kind: "support" | "resistance"; rank: number; sources: LevelSource[]; isComplex: boolean } | null {
  const reach = 1.2 * o.atr1h;
  type Node = { low: number; high: number; kind: "support" | "resistance"; rank: number; sources: LevelSource[]; isComplex: boolean };
  const nodes: Node[] = [
    ...o.complexes.map((c) => ({ low: c.low, high: c.high, kind: c.kind, rank: c.rank, sources: c.sources, isComplex: true })),
    ...o.levels.filter((l) => l.complexId == null).map((l) => ({ low: l.low, high: l.high, kind: l.kind, rank: l.rank, sources: l.sources, isComplex: false })),
  ];
  let best: Node | null = null, bestScore = -Infinity;
  for (const nd of nodes) {
    const dist = o.price < nd.low ? nd.low - o.price : o.price > nd.high ? o.price - nd.high : 0;
    if (dist > reach) continue;
    // prefer close + high-rank (rank dominates ties; being inside beats near).
    const s = nd.rank - (dist / o.atr1h) * 18 + (dist === 0 ? 10 : 0);
    if (s > bestScore) { bestScore = s; best = nd; }
  }
  return best;
}

/** Active range for range-position + runner math: the OUTERMOST meaningful
 *  bounds (major recent high/low territory), not whatever sits nearest. */
export function activeRange(levels: RankedLevel[], price: number, fallbackHigh: number, fallbackLow: number): { high: number; low: number; mid: number } {
  const majors = levels.filter((l) => l.rank >= 30);
  const res = majors.filter((l) => l.kind === "resistance").map((l) => (l.low + l.high) / 2);
  const sup = majors.filter((l) => l.kind === "support").map((l) => (l.low + l.high) / 2);
  const high = Math.max(res.length ? Math.max(...res) : -Infinity, Number.isFinite(fallbackHigh) ? fallbackHigh : -Infinity);
  const low = Math.min(sup.length ? Math.min(...sup) : Infinity, Number.isFinite(fallbackLow) ? fallbackLow : Infinity);
  const hi = Number.isFinite(high) ? high : price;
  const lo = Number.isFinite(low) ? low : price;
  const h = Math.max(hi, lo), l = Math.min(hi, lo);
  return { high: h, low: l, mid: (h + l) / 2 };
}
