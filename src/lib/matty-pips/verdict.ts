/**
 * MATTY'S CALL — the "gun to the head" decision layer (owner spec 09-04).
 *
 * When asked, Matty Pips ALWAYS makes a directional call on gold: it looks at
 * where the market is RIGHT NOW, weighs everything the owner looks for (trend
 * structure, the reaction at the level, liquidity sweeps, momentum, location in
 * the range, DXY), and commits to the direction with the best probability. The
 * checks feed the CONFIDENCE score — they never veto the decision.
 *
 * Trade math (owner's rules, gold priced in dollars):
 *   • TP1 targets a $3–$7 move.
 *   • Stop loss is structural, capped at $10 (never wider).
 *   • TP2 / TP3 come from market structure — the next major levels.
 *
 * Deterministic and additive: nothing here changes the gated TAKE_NOW engine,
 * FLOW, or GENX. This layer only ADDS `call` to the decision object.
 */
import type {
  DxyVerdict, FractalRead, MarketState, MomentumVerdict, RankedLevel,
  ReactionRead, SarRead, StructureContext,
} from "./types";

export type MattyCall = {
  direction: "buy" | "sell";
  confidence: number;              // 0–100
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  stopDollars: number;             // $ distance entry→stop (≤ 10)
  tp1Dollars: number;              // $ distance entry→tp1 (3–7)
  rr1: number;
  reasons: string[];               // what lines up behind the call
  against: string[];               // what argues against it (honesty)
  summary: string;                 // one Matty-voice sentence
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function buildCall(o: {
  price: number;
  atr15: number;
  levels: RankedLevel[];
  sctx: StructureContext;
  reaction: ReactionRead;
  engineDirection: "buy" | "sell" | null;
  momentumV: MomentumVerdict;
  sar: SarRead | null;
  fractals: FractalRead;
  sweep: { side: "buy-side" | "sell-side"; extreme: number } | null;
  dxyVerdict: DxyVerdict;
  scoreTotal: number;
}): MattyCall {
  const { price, atr15 } = o;
  let net = 0;
  const reasons: string[] = [];
  const against: string[] = [];
  const vote = (dir: "buy" | "sell" | null, w: number, why: string) => {
    if (!dir) return;
    net += dir === "buy" ? w : -w;
    // recorded after direction is known — stash raw votes
    votes.push({ dir, w, why });
  };
  const votes: { dir: "buy" | "sell"; w: number; why: string }[] = [];

  const trendDir = (s: MarketState): "buy" | "sell" | null =>
    s === "UPTREND" ? "buy" : s === "DOWNTREND" ? "sell" : null;

  // 1) The reaction at the level — the strongest single input when present.
  vote(o.engineDirection, 2.5, "the live reaction at the level in play");

  // 2) Structure — external (the map) and internal (the current push).
  vote(trendDir(o.sctx.externalTrend), 2.0, `1H structure is a clear ${o.sctx.externalTrend === "UPTREND" ? "uptrend" : "downtrend"}`);
  vote(trendDir(o.sctx.internalTrend), 1.5, `15M internal structure agrees (${o.sctx.internalTrend === "UPTREND" ? "higher highs" : "lower lows"})`);
  if (o.sctx.structureBreakDirection) vote(o.sctx.structureBreakDirection === "up" ? "buy" : "sell", 1.0, `the last structure break was ${o.sctx.structureBreakDirection}`);
  if (o.sctx.changeOfCharacter && trendDir(o.sctx.internalTrend)) vote(trendDir(o.sctx.internalTrend), 0.5, "a change of character — the internal push turned");

  // 3) Momentum reads.
  if (o.fractals.higherLows) vote("buy", 0.75, "fractals stacking higher lows");
  if (o.fractals.lowerHighs) vote("sell", 0.75, "fractals stacking lower highs");
  if (o.sar) vote(o.sar.dir === "up" ? "buy" : "sell", 0.75, `parabolic SAR is ${o.sar.dir === "up" ? "under" : "over"} price`);

  // 4) Liquidity — a swept side usually fuels the move the OTHER way.
  if (o.sweep) vote(o.sweep.side === "sell-side" ? "buy" : "sell", 1.0, `${o.sweep.side === "sell-side" ? "sell-side liquidity was just swept — fuel for buyers" : "buy-side liquidity was just swept — fuel for sellers"}`);

  // 5) Location in the map — closer to major support favors buys, and vice versa.
  const majors = o.levels.filter((l) => l.rank >= 45);
  const nearSup = majors.filter((l) => l.kind === "support" && l.high <= price).sort((a, b) => b.high - a.high)[0] ?? null;
  const nearRes = majors.filter((l) => l.kind === "resistance" && l.low >= price).sort((a, b) => a.low - b.low)[0] ?? null;
  if (nearSup && nearRes) {
    const dSup = price - nearSup.high, dRes = nearRes.low - price;
    const span = dSup + dRes;
    if (span > 0.5) {
      const tilt = (dRes - dSup) / span; // +1 near support → buy
      if (Math.abs(tilt) > 0.25) vote(tilt > 0 ? "buy" : "sell", Math.min(1, Math.abs(tilt)) , tilt > 0 ? "price sits closer to major support than resistance" : "price sits closer to major resistance than support");
    }
  }

  // Decide. A perfect tie falls back to the last 15M drift.
  let direction: "buy" | "sell" = net > 0 ? "buy" : net < 0 ? "sell" : (o.sctx.internalTrend === "DOWNTREND" ? "sell" : "buy");

  // 6) DXY — never a veto; scores the call after direction is known.
  if (o.dxyVerdict === "DXY_SUPPORTS" && o.engineDirection === direction) { net += direction === "buy" ? 0.5 : -0.5; votes.push({ dir: direction, w: 0.5, why: "DXY supports the move" }); }

  // Split the votes into reasons (aligned) and against (opposed).
  for (const v of votes.sort((a, b) => b.w - a.w)) {
    if (v.dir === direction) { if (reasons.length < 6) reasons.push(v.why); }
    else if (against.length < 4) against.push(v.why);
  }
  if (o.momentumV === "TOO_EXTENDED_DO_NOT_CHASE") against.push("price is extended from the level — the entry isn't clean");
  if (reasons.length === 0) reasons.push("nothing is screaming, so the call leans on the current drift — size accordingly");

  // Confidence: alignment first, engine quality score as the refiner.
  const alignment = Math.abs(net);                      // ~0–9
  let confidence = Math.round(40 + alignment * 5.5 + o.scoreTotal * 0.15);
  if (o.momentumV === "TOO_EXTENDED_DO_NOT_CHASE") confidence -= 8;
  if (against.length >= 3) confidence -= 5;
  confidence = clamp(confidence, 34, 94);

  /* ── Trade math (gold dollars) ─────────────────────────────────────── */
  const up = direction === "buy";

  // STOP — structural: behind the protecting major level / sweep extreme /
  // last swing, padded by half an ATR, then hard-capped at $10 and floored at $3.
  const protLevel = up
    ? majors.filter((l) => l.kind === "support" && l.low < price).sort((a, b) => b.low - a.low)[0] ?? null
    : majors.filter((l) => l.kind === "resistance" && l.high > price).sort((a, b) => a.high - b.high)[0] ?? null;
  const cands: number[] = [];
  if (protLevel) cands.push(up ? price - (protLevel.low - 0.5 * atr15) : (protLevel.high + 0.5 * atr15) - price);
  if (o.sweep && ((up && o.sweep.side === "sell-side") || (!up && o.sweep.side === "buy-side"))) {
    cands.push(up ? price - (o.sweep.extreme - 0.3 * atr15) : (o.sweep.extreme + 0.3 * atr15) - price);
  }
  const swing = up ? o.sctx.lastInternalSwingLow ?? o.sctx.lastMajorSwingLow : o.sctx.lastInternalSwingHigh ?? o.sctx.lastMajorSwingHigh;
  if (swing != null) cands.push(up ? price - (swing - 0.4 * atr15) : (swing + 0.4 * atr15) - price);
  const sane = cands.filter((d) => d > 0.8 && d <= 14);
  const structStop = sane.length ? Math.min(...sane) : 1.6 * atr15;
  const stopDollars = r2(clamp(structStop, 3, 10));
  const stopLoss = r2(up ? price - stopDollars : price + stopDollars);

  // TP1 — the $3–$7 move. Prefer snapping just in front of the first opposing
  // major inside the band; otherwise mirror the risk inside the band.
  const opposing = (up
    ? o.levels.filter((l) => l.kind === "resistance" && l.low > price).sort((a, b) => a.low - b.low)
    : o.levels.filter((l) => l.kind === "support" && l.high < price).sort((a, b) => b.high - a.high)
  ).filter((l) => l.rank >= 30);
  let tp1Dollars = clamp(stopDollars, 3, 7);
  const first = opposing[0];
  if (first) {
    const dist = up ? first.low - price - 0.3 : price - first.high - 0.3;
    if (dist >= 3 && dist <= 7) tp1Dollars = dist;
    else if (dist > 7 && opposing[0].rank >= 55) tp1Dollars = 7; // big level beyond — run the full band
  }
  tp1Dollars = r2(clamp(tp1Dollars, 3, 7));
  const tp1 = r2(up ? price + tp1Dollars : price - tp1Dollars);

  // TP2 / TP3 — market structure: the next major levels past TP1.
  const beyond = opposing.filter((l) => (up ? l.low > tp1 + 0.5 : l.high < tp1 - 0.5));
  const tp2Lvl = beyond.find((l) => l.rank >= 40) ?? beyond[0] ?? null;
  const tp2 = tp2Lvl ? r2(up ? tp2Lvl.low - 0.2 : tp2Lvl.high + 0.2) : r2(up ? price + 2 * tp1Dollars : price - 2 * tp1Dollars);
  const after2 = beyond.filter((l) => (up ? l.low > (tp2 ?? price) + 0.5 : l.high < (tp2 ?? price) - 0.5));
  const tp3Lvl = after2.find((l) => l.rank >= 50) ?? after2[0] ?? null;
  const tp3 = tp3Lvl ? r2(up ? tp3Lvl.low - 0.2 : tp3Lvl.high + 0.2) : r2(up ? price + 3 * tp1Dollars : price - 3 * tp1Dollars);

  const rr1 = r2(tp1Dollars / stopDollars);

  const summary = `${up ? "BUY" : "SELL"} — if I have to pick a side right now, the highest-probability path is ${up ? "up" : "down"}: ${reasons[0]}. Stop $${stopDollars.toFixed(2)} away, first target $${tp1Dollars.toFixed(2)} out.`;

  return { direction, confidence, entry: r2(price), stopLoss, tp1, tp2, tp3, stopDollars, tp1Dollars, rr1, reasons, against, summary };
}
