/**
 * MATTY PIPS — DUAL-SIDE SCORING. The heart of the Gold Decision Engine:
 * BUY and SELL are scored SEPARATELY against the same eight components
 * (weights in config.ts, summing to 100), and the SCORE DIFFERENTIAL — not
 * either absolute number — drives directional conviction. The engine always
 * picks a side: a small differential is honest low conviction, never "no call".
 * Pure, deterministic, no LLM anywhere near the math.
 */
import type {
  DxyVerdict, FractalRead, RankedLevel, ReactionRead, SarRead,
  StructureContext, TfStructure,
} from "./types";
import type { MpConfig, ScoringWeights } from "./config";
import type { RegimeRead } from "./regime";
import type { MicroRead } from "./micro";
import type { SessionRead } from "./session";
import type { VolatilityRead } from "./volatility";

export type SideScore = {
  total: number;                                   // 0–100
  parts: Record<keyof ScoringWeights, number>;
  notes: string[];                                 // evidence lines for this side
};

export type DualScore = {
  buy: SideScore;
  sell: SideScore;
  direction: "buy" | "sell";
  differential: number;                            // winner − loser (0–100)
  conviction: number;                              // 0–100, differential-driven
  penalties: string[];
};

type Dir = "buy" | "sell";
const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function scoreSides(o: {
  cfg: MpConfig;
  price: number;
  atr15: number;
  daily: TfStructure;
  regime: RegimeRead;
  sctx: StructureContext;
  levels: RankedLevel[];
  node: { low: number; high: number; kind: "support" | "resistance"; rank: number } | null;
  atNode: boolean;
  rangePosition: number;                           // 0–100
  reaction: ReactionRead;
  micro: MicroRead;
  sar: SarRead | null;
  fractals: FractalRead;
  sweep: { side: "buy-side" | "sell-side" } | null;
  session: SessionRead;
  vol: VolatilityRead;
  dxyVerdict: DxyVerdict;
  engineDirection: Dir | null;                     // the gated engine's read, as a tiebreak
}): DualScore {
  const { cfg, price } = o;
  const W = cfg.weights;

  const trendDir = (s: TfStructure["marketState"]): Dir | null =>
    s === "UPTREND" ? "buy" : s === "DOWNTREND" ? "sell" : null;

  const majors = o.levels.filter((l) => l.rank >= 45);
  const nearSup = majors.filter((l) => l.kind === "support" && l.high <= price).sort((a, b) => b.high - a.high)[0] ?? null;
  const nearRes = majors.filter((l) => l.kind === "resistance" && l.low >= price).sort((a, b) => a.low - b.low)[0] ?? null;

  const roomFor = (dir: Dir): number | null => {
    const opp = o.levels
      .filter((l) => l.rank >= cfg.move.opposingMinRank && (dir === "buy" ? l.kind === "resistance" && l.low > price : l.kind === "support" && l.high < price))
      .sort((a, b) => (dir === "buy" ? a.low - b.low : b.high - a.high))[0];
    return opp ? (dir === "buy" ? opp.low - price : price - opp.high) : null;
  };

  const scoreSide = (dir: Dir): SideScore => {
    const notes: string[] = [];
    const up = dir === "buy";

    // 1) HTF STRUCTURE /20 — Daily map (6) + 4H tide (8) + 1H structure (6).
    let htf = 0;
    const dStr = o.daily.trendStrength / 100;
    if (trendDir(o.daily.marketState) === dir) { htf += (W.htfStructure * 0.3) * (0.4 + 0.6 * dStr); notes.push(`Daily map is a ${o.daily.marketState.toLowerCase()}`); }
    else if (o.daily.marketState === "LEFT_TO_RIGHT") htf += W.htfStructure * 0.12;
    else htf += W.htfStructure * 0.03;
    const rStr = o.regime.strength / 100;
    if ((o.regime.state === "UPTREND" && up) || (o.regime.state === "DOWNTREND" && !up)) { htf += (W.htfStructure * 0.4) * (0.4 + 0.6 * rStr); notes.push(`4H tide is with the ${dir}`); }
    else if (o.regime.state === "RANGE") htf += W.htfStructure * 0.14;
    else if (o.regime.state === "TRANSITION") htf += W.htfStructure * 0.1;
    else htf += W.htfStructure * 0.04;
    const ext = o.sctx.externalTrend;
    if (trendDir(ext) === dir) { htf += W.htfStructure * 0.25; notes.push(`1H swings run with the ${dir}`); }
    else if (ext === "LEFT_TO_RIGHT") htf += W.htfStructure * 0.1;
    else htf += W.htfStructure * 0.025;
    htf = clamp(htf, 0, W.htfStructure);

    // 2) S/R LOCATION /20 — where price sits in the map for THIS side.
    let loc: number;
    if (nearSup && nearRes) {
      const dSup = Math.max(0, price - nearSup.high), dRes = Math.max(0, nearRes.low - price);
      const span = dSup + dRes;
      const tilt = span > 0.5 ? (up ? dRes / span : dSup / span) : 0.5;   // 1 = right at our level
      loc = W.srLocation * 0.7 * tilt;
      if (tilt > 0.7) notes.push(up ? "price is parked on major support" : "price is parked under major resistance");
    } else {
      loc = W.srLocation * 0.35 * (up ? (100 - o.rangePosition) / 100 + 0.5 : o.rangePosition / 100 + 0.5);
    }
    if (o.node && o.atNode && ((up && o.node.kind === "support") || (!up && o.node.kind === "resistance"))) {
      loc += W.srLocation * 0.2 + (o.node.rank / 100) * W.srLocation * 0.1;
      notes.push(`at an active ${o.node.kind} (rank ${o.node.rank})`);
    }
    loc = clamp(loc, 0, W.srLocation);

    // 3) 15M SETUP /15 — what price is DOING at the level, for this side.
    let setup = W.m15Setup * 0.2;
    const rx = o.reaction;
    const nodeFavors = o.node ? (up ? o.node.kind === "support" : o.node.kind === "resistance") : false;
    const brokeOur = rx.brokeDirection === (up ? "up" : "down");
    if ((rx.state === "REJECTING" || rx.state === "FAILED_BREAK") && nodeFavors) {
      setup = W.m15Setup * (rx.confirmedByClose ? 0.95 : 0.75);
      notes.push(rx.state === "FAILED_BREAK" ? "a failed break at the level — trapped traders fuel our side" : "a live rejection at the level");
    } else if ((rx.state === "BREAK_RETEST" || rx.state === "ACCEPTED_BREAK") && brokeOur) {
      setup = W.m15Setup * (rx.state === "BREAK_RETEST" && rx.confirmedByClose ? 0.9 : 0.7);
      notes.push(rx.state === "BREAK_RETEST" ? "broke the level and the retest is holding" : "price is accepting beyond the level");
    } else if ((rx.state === "MOMENTUM_CONTINUATION" || rx.state === "EXPANSION_BREAKOUT") && brokeOur) {
      setup = W.m15Setup * 0.6;
      notes.push("momentum is carrying through the level");
    } else if ((rx.state === "TESTING" || rx.state === "RESPECTING") && nodeFavors) {
      setup = W.m15Setup * 0.45;
      notes.push("the level is holding so far");
    }
    if (trendDir(o.sctx.internalTrend) === dir) setup += W.m15Setup * 0.15;
    setup = clamp(setup, 0, W.m15Setup);

    // 4) 5M CONFIRM /15 — the trigger timeframe. Neutral wash when no feed.
    let m5c: number;
    if (!o.micro.available) m5c = W.m5Confirm * 0.47;
    else {
      m5c = 0;
      if (o.micro.microTrend === (up ? "up" : "down")) { m5c += W.m5Confirm * 0.4; notes.push("5M flow is pushing our way"); }
      else if (o.micro.microTrend === "flat") m5c += W.m5Confirm * 0.2;
      else m5c += W.m5Confirm * 0.07;
      if (o.micro.trigger?.side === dir) { m5c += W.m5Confirm * 0.4; notes.push("a fresh 5M trigger candle just fired"); }
      else if (!o.micro.trigger) m5c += W.m5Confirm * 0.13;
      if (!(o.micro.extended && o.micro.extendedSide === (up ? "up" : "down"))) m5c += W.m5Confirm * 0.2;
    }
    m5c = clamp(m5c, 0, W.m5Confirm);

    // 5) MOMENTUM /10 — SAR, fractal stacking, impulse, sweep fuel.
    let mom = 0;
    if (o.sar) mom += o.sar.dir === (up ? "up" : "down") ? W.momentum * 0.3 : 0;
    else mom += W.momentum * 0.15;
    if (up && o.fractals.higherLows) { mom += W.momentum * 0.25; notes.push("higher lows stacking underneath"); }
    if (!up && o.fractals.lowerHighs) { mom += W.momentum * 0.25; notes.push("lower highs stacking overhead"); }
    if (trendDir(o.sctx.internalTrend) === dir) mom += (o.sctx.impulseStrength / 100) * W.momentum * 0.2;
    if (o.sweep && ((up && o.sweep.side === "sell-side") || (!up && o.sweep.side === "buy-side"))) {
      mom += W.momentum * 0.25;
      notes.push(up ? "sell-side liquidity was just swept — fuel for buyers" : "buy-side liquidity was just swept — fuel for sellers");
    }
    mom = clamp(mom, 0, W.momentum);

    // 6) ROOM /10 — dollars of clean air before the first opposing major.
    const room = roomFor(dir);
    let roomPts: number;
    if (room == null) { roomPts = W.room * 0.8; }
    else if (room >= 7) { roomPts = W.room; notes.push(`$${room.toFixed(0)}+ of clean air to the next level`); }
    else if (room >= 5) roomPts = W.room * 0.8;
    else if (room >= 3.5) roomPts = W.room * 0.6;
    else if (room >= 2) roomPts = W.room * 0.3;
    else roomPts = W.room * 0.1;

    // 7) SESSION + VOLATILITY /5 — symmetric context (affects conviction, not direction).
    const volPts = o.vol.state === "NORMAL" ? 0.4 : o.vol.state === "ELEVATED" ? 0.3 : o.vol.state === "LOW" ? 0.2 : 0.1;
    const sv = clamp(W.sessionVol * (0.6 * o.session.liquidityQuality + volPts), 0, W.sessionVol);

    // 8) EXECUTION /5 — how clean acting RIGHT NOW would be for this side.
    let exec = W.execution * 0.6;
    if (o.node && o.atNode && nodeFavors && !(o.micro.extended && o.micro.extendedSide === (up ? "up" : "down"))) exec = W.execution;
    else if (o.micro.extended && o.micro.extendedSide === (up ? "up" : "down")) exec = W.execution * 0.2;
    exec = clamp(exec, 0, W.execution);

    const parts = {
      htfStructure: r1(htf), srLocation: r1(loc), m15Setup: r1(setup), m5Confirm: r1(m5c),
      momentum: r1(mom), room: r1(roomPts), sessionVol: r1(sv), execution: r1(exec),
    };
    const total = Math.round(Object.values(parts).reduce((a, b) => a + b, 0));
    return { total, parts, notes };
  };

  const buy = scoreSide("buy");
  const sell = scoreSide("sell");
  const direction: Dir =
    buy.total > sell.total ? "buy" :
    sell.total > buy.total ? "sell" :
    o.engineDirection ?? (trendDir(o.sctx.internalTrend) ?? "buy");
  const differential = Math.abs(buy.total - sell.total);

  // CONVICTION — differential first, absolute quality second, honest penalties.
  const winner = direction === "buy" ? buy.total : sell.total;
  const penalties: string[] = [];
  let conviction = cfg.conviction.base + winner * cfg.conviction.winnerCoef + differential * cfg.conviction.diffCoef;
  if (o.vol.state === "EXTREME") { conviction -= cfg.conviction.extremeVolPenalty; penalties.push("volatility is EXTREME — both sides overshoot"); }
  if (o.session.liquidityQuality <= 0.2) { conviction -= cfg.conviction.deadSessionPenalty; penalties.push(`${o.session.label} hours — thin tape, weak follow-through`); }
  if (o.dxyVerdict === "DXY_CONFLICTS") { conviction -= cfg.conviction.dxyConflictPenalty; penalties.push("the dollar leans against this call"); }
  conviction = Math.round(clamp(conviction, cfg.conviction.min, cfg.conviction.max));

  return { buy, sell, direction, differential, conviction, penalties };
}
