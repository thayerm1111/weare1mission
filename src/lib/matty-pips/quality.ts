/**
 * MATTY PIPS — the trade-quality layer: GOOD trade vs merely POSSIBLE trade.
 * Breakout quality grading, acceptance vs rejection, entry quality
 * (EARLY/OPTIMAL/LATE/CHASE), the bad-location filter, and asymmetry.
 */
import type { Acceptance, BreakoutQuality, Candle, EntryQuality, RankedLevel, ReactionRead, TradeQuality } from "./types";

const f = (n: number) => (n >= 100 ? n.toFixed(1) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));

/** Grade a break in force: WEAK / VALID / STRONG. */
export function breakoutQuality(o: {
  direction: "up" | "down";
  edge: number;
  m15: Candle[];
  atr15: number;
  retestHeld: boolean;
  structureAligned: boolean;   // internal HL after bull break / LH after bear break
  roomToNext: number | null;
}): { grade: BreakoutQuality; detail: string } {
  const closed = o.m15.slice(0, -1);
  const up = o.direction === "up";
  const beyond = closed.slice(-8).filter((k) => (up ? k.c > o.edge : k.c < o.edge));
  const bk = beyond[0] ?? closed[closed.length - 1];
  const range = Math.max(bk.h - bk.l, 1e-9);
  const body = Math.abs(bk.c - bk.o) / range;
  const rejWick = up ? (bk.h - bk.c) / range : (bk.c - bk.l) / range;
  let pts = 0;
  const why: string[] = [];
  if (body >= 0.55) { pts += 2; why.push("strong body"); }
  if (rejWick <= 0.25) { pts += 1; why.push("small rejection wick"); }
  if (beyond.length >= 2) { pts += 2; why.push(`${beyond.length} closes beyond`); }
  if (o.retestHeld) { pts += 3; why.push("retest held — level flipped"); }
  if (o.structureAligned) { pts += 2; why.push(up ? "higher lows continuing" : "lower highs continuing"); }
  if (o.roomToNext == null || o.roomToNext >= 1.5 * o.atr15) { pts += 1; why.push("room ahead"); }
  const grade: BreakoutQuality = pts >= 8 ? "BREAKOUT_STRONG" : pts >= 5 ? "BREAKOUT_VALID" : "BREAKOUT_WEAK";
  return { grade, detail: `${grade.replace("BREAKOUT_", "")} break of ${f(o.edge)} (${why.join(", ") || "little evidence"}).` };
}

/** Is price ACCEPTING beyond the level, or being REJECTED? Central concept. */
export function acceptanceRead(o: {
  node: { low: number; high: number };
  m15: Candle[];
  atr15: number;
}): { acceptance: Acceptance; detail: string } {
  const closed = o.m15.slice(0, -1).slice(-8);
  if (closed.length < 4) return { acceptance: "UNDECIDED", detail: "Not enough candles." };
  const buf = 0.25 * o.atr15;
  const above = closed.filter((k) => k.c > o.node.high + buf).length;
  const below = closed.filter((k) => k.c < o.node.low - buf).length;
  const inside = closed.length - above - below;
  const bodiesAbove = closed.filter((k) => Math.min(k.o, k.c) > o.node.high).length;
  const bodiesBelow = closed.filter((k) => Math.max(k.o, k.c) < o.node.low).length;
  if (above >= 3 && bodiesAbove >= 2) return { acceptance: "ACCEPTANCE", detail: `${above} of the last ${closed.length} closes (${bodiesAbove} full bodies) above ${f(o.node.high)} — price is comfortable up there; that's acceptance, not a fakeout.` };
  if (below >= 3 && bodiesBelow >= 2) return { acceptance: "ACCEPTANCE", detail: `${below} of the last ${closed.length} closes (${bodiesBelow} full bodies) below ${f(o.node.low)} — acceptance below the level.` };
  const wicked = closed.some((k) => (k.h > o.node.high && k.c < o.node.high) || (k.l < o.node.low && k.c > o.node.low));
  if (wicked && inside >= closed.length - 2) return { acceptance: "REJECTION", detail: "Penetrations keep closing back inside — the market is rejecting life beyond this level." };
  return { acceptance: "UNDECIDED", detail: "No clear acceptance or rejection beyond the level yet." };
}

/** Entry timing quality. CHASE is only rescued by the continuation evaluator. */
export function entryQuality(o: {
  price: number;
  node: { low: number; high: number };
  reaction: ReactionRead;
  atr15: number;
  continuationOk: boolean;
}): { quality: EntryQuality; detail: string } {
  const dist = o.price > o.node.high ? o.price - o.node.high : o.price < o.node.low ? o.node.low - o.price : 0;
  const atLevel = dist <= 0.7 * o.atr15;
  if (atLevel && o.reaction.confirmedByClose) return { quality: "OPTIMAL", detail: "Confirmed right at the level — the entry Matty wants." };
  if (atLevel) return { quality: "EARLY", detail: "At the level but the confirming 15M close hasn't printed yet." };
  if (dist <= 1.8 * o.atr15) return { quality: "LATE", detail: `Already ${f(dist)} from the level — playable, but the best price is gone.` };
  if (o.continuationOk) return { quality: "LATE", detail: `Extended ${f(dist)} from the level, but the continuation engine found a structurally valid new entry.` };
  return { quality: "CHASE", detail: `${f(dist)} beyond the level with no fresh structure — chasing. Skip.` };
}

/**
 * BAD LOCATION filter — "good idea, bad location". Returns the explanation
 * when an otherwise-valid setup is boxed in, or null when the road is clear.
 */
export function badLocation(o: {
  direction: "buy" | "sell";
  price: number;
  riskDist: number;               // entry → structural stop distance
  levels: RankedLevel[];
  atr15: number;
}): string | null {
  const opposing = o.levels.filter((l) =>
    o.direction === "buy" ? l.kind === "resistance" && l.low > o.price : l.kind === "support" && l.high < o.price);
  if (!opposing.length) return null;
  const nearest = opposing.sort((a, b) =>
    o.direction === "buy" ? a.low - b.low : b.high - a.high)[0];
  const room = o.direction === "buy" ? nearest.low - o.price : o.price - nearest.high;
  if (room < Math.max(0.8 * o.riskDist, 1.0 * o.atr15) && nearest.rank >= 40) {
    return `SETUP VALID · BUT TRADE QUALITY POOR — a rank-${nearest.rank} ${o.direction === "buy" ? "resistance" : "support"} sits only ${f(room)} away (stop needs ${f(o.riskDist)}). Boxed in: reward can't clear the risk. WAIT.`;
  }
  return null;
}

/** Asymmetry ratio: clean room toward the target vs structural risk. */
export function asymmetry(room: number | null, riskDist: number): number {
  if (room == null) return 2.5; // open air
  return riskDist > 0 ? +(room / riskDist).toFixed(2) : 0;
}

/** Final GOOD-vs-POSSIBLE verdict from the total score + hard caps. */
export function tradeQualityVerdict(o: {
  total: number;
  hasTradeMath: boolean;
  confirmed: boolean;
  boxedIn: boolean;
  entry: EntryQuality | null;
}): TradeQuality {
  if (!o.hasTradeMath) return "NO_TRADE";
  if (o.boxedIn || o.entry === "CHASE") return "LOW_QUALITY";
  if (!o.confirmed) return o.total >= 70 ? "VALID" : "LOW_QUALITY"; // unconfirmed can't be HQ
  if (o.total >= 88) return "A_PLUS";
  if (o.total >= 76) return "HIGH_QUALITY";
  if (o.total >= 62) return "VALID";
  return "LOW_QUALITY";
}
