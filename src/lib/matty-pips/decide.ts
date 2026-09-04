/**
 * MATTY PIPS — GOLD DECISION ENGINE (v2 orchestrator). ONE pure function from
 * candles → the full MattyCall: dual BUY/SELL scores, differential-driven
 * conviction, execution state (TAKE_NOW / WAIT_FOR_PRICE / BREAKOUT_ENTRY),
 * trade math anchored at the PLANNED entry, expected move and expected path.
 *
 * PURE + SYNCHRONOUS on purpose: the live engine calls it with fresh candles,
 * and the replay/backtest harness calls it with truncated historical arrays —
 * same code, zero lookahead, no network. Async context (DXY, news) is injected
 * by the live caller and defaults to neutral here.
 */
import type { Candle, DxyVerdict } from "./types";
import { atr, readStructure } from "./structure";
import { buildZones } from "./zones";
import { buildLevels, activeNode, activeRange } from "./levels";
import { readReaction } from "./reaction";
import { structureContext } from "./structureAdv";
import { liquidityContext } from "./liquidity";
import { parabolicSar, fractalRead } from "./momentum";
import { readSession } from "./session";
import { readVolatility } from "./volatility";
import { readRegime } from "./regime";
import { readMicro } from "./micro";
import { scoreSides } from "./scoring2";
import { readExecution } from "./execution";
import { expectedPath } from "./path";
import { DEFAULT_CONFIG, type MpConfig } from "./config";
import type { MattyCall, SetupFamily, TfSummary } from "./verdict";

export const DECISION_ENGINE_VERSION = "gde-1.0.0";

export type GoldMarket = {
  d: Candle[]; h4: Candle[]; h1: Candle[]; m15: Candle[];
  m5: Candle[];                    // may be empty — micro read fails soft
  price: number;
};

export type DecideExtras = {
  dxyVerdict?: DxyVerdict;         // live caller injects; replay defaults neutral
  engineDirection?: "buy" | "sell" | null;  // the gated engine's read (tiebreak)
  nowMs?: number;                  // replay passes the historical clock
  cfg?: MpConfig;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function decideGold(mkt: GoldMarket, extras?: DecideExtras): MattyCall {
  const cfg = extras?.cfg ?? DEFAULT_CONFIG;
  const dxyVerdict: DxyVerdict = extras?.dxyVerdict ?? "DXY_UNAVAILABLE";
  const nowMs = extras?.nowMs ?? (mkt.m15.length ? mkt.m15[mkt.m15.length - 1].t + 15 * 60000 : Date.now());
  const price = mkt.price;

  /* ── 1) The reads (all pure, all reused from the existing engine) ─────── */
  const daily = readStructure("D", mkt.d);
  const h1 = readStructure("H1", mkt.h1);
  const atr15 = atr(mkt.m15.slice(0, -1));
  const zones = buildZones({ d: mkt.d, h4: mkt.h4, h1: mkt.h1, price });
  const { levels, complexes } = buildLevels({ d: mkt.d, zones, structHigh: daily.recentHigh, structLow: daily.recentLow, price, atr1h: h1.atr });
  const node = activeNode({ levels, complexes, price, atr1h: h1.atr });
  const range = activeRange(levels, price, daily.recentHigh, daily.recentLow);
  const rangePosition = range.high > range.low ? clamp(Math.round(((price - range.low) / (range.high - range.low)) * 100), 0, 100) : 50;
  const sctx = structureContext({ h1: mkt.h1, m15: mkt.m15 });
  const liq = liquidityContext({ m15: mkt.m15, levels, node, price, atr15, atr1h: h1.atr });
  const sar = parabolicSar(mkt.m15, atr15);
  const fractals = fractalRead(mkt.m15);
  const reaction = node
    ? readReaction({ node, price, m15: mkt.m15, atr15, atr1h: h1.atr })
    : { state: "NONE" as const, detail: "Price is between meaningful levels.", brokeDirection: null, confirmedByClose: false };
  const regime = readRegime(mkt.h4);
  const session = readSession(mkt.m15, nowMs);
  const vol = readVolatility(mkt.m15, cfg);
  const micro = readMicro(mkt.m5, cfg);
  const atNode = !!node && price >= node.low - 0.7 * atr15 && price <= node.high + 0.7 * atr15;

  /* ── 2) DUAL SCORES → direction + conviction ──────────────────────────── */
  const dual = scoreSides({
    cfg, price, atr15, daily, regime, sctx, levels, node, atNode, rangePosition,
    reaction, micro, sar, fractals, sweep: liq.sweep ? { side: liq.sweep.side } : null,
    session, vol, dxyVerdict, engineDirection: extras?.engineDirection ?? null,
  });
  const direction = dual.direction;
  const up = direction === "buy";

  /* ── 3) EXECUTION STATE — direction and entry are different decisions ─── */
  const exec = readExecution({ cfg, direction, price, atr15, levels, node, reaction, sctx, micro });
  const entryPrice = exec.entry.price;

  /* ── 4) TRADE MATH — anchored at the PLANNED entry, never the live print ─ */
  const majors = levels.filter((l) => l.rank >= 45);

  // STOP: behind the protecting structure, padded, clamped to [$3,$10].
  const protLevel = up
    ? majors.filter((l) => l.kind === "support" && l.low < entryPrice).sort((a, b) => b.low - a.low)[0] ?? null
    : majors.filter((l) => l.kind === "resistance" && l.high > entryPrice).sort((a, b) => a.high - b.high)[0] ?? null;
  const cands: number[] = [];
  if (protLevel) cands.push(up ? entryPrice - (protLevel.low - cfg.stops.levelPadAtr * atr15) : (protLevel.high + cfg.stops.levelPadAtr * atr15) - entryPrice);
  if (liq.sweep && ((up && liq.sweep.side === "sell-side") || (!up && liq.sweep.side === "buy-side"))) {
    cands.push(up ? entryPrice - (liq.sweep.extreme - cfg.stops.sweepPadAtr * atr15) : (liq.sweep.extreme + cfg.stops.sweepPadAtr * atr15) - entryPrice);
  }
  const swing = up ? sctx.lastInternalSwingLow ?? sctx.lastMajorSwingLow : sctx.lastInternalSwingHigh ?? sctx.lastMajorSwingHigh;
  if (swing != null) cands.push(up ? entryPrice - (swing - cfg.stops.swingPadAtr * atr15) : (swing + cfg.stops.swingPadAtr * atr15) - entryPrice);
  const sane = cands.filter((d) => d > cfg.stops.minRawDollars && d <= cfg.stops.maxRawDollars);
  const structStop = sane.length ? Math.min(...sane) : cfg.stops.atrFallbackMult * atr15;
  const stopDollars = r2(clamp(structStop, cfg.stops.minRawDollars > cfg.move.stopMinDollars ? cfg.stops.minRawDollars : cfg.move.stopMinDollars, cfg.move.stopMaxDollars));
  const stopLoss = r2(up ? entryPrice - stopDollars : entryPrice + stopDollars);

  // TP1: the $3–$7 move, snapped in front of the first opposing meaningful level.
  const opposing = (up
    ? levels.filter((l) => l.kind === "resistance" && l.low > entryPrice).sort((a, b) => a.low - b.low)
    : levels.filter((l) => l.kind === "support" && l.high < entryPrice).sort((a, b) => b.high - a.high)
  ).filter((l) => l.rank >= cfg.move.opposingMinRank);
  let tp1Dollars = clamp(stopDollars, cfg.move.tp1MinDollars, cfg.move.tp1MaxDollars);
  const first = opposing[0];
  if (first) {
    const dist = up ? first.low - entryPrice - cfg.move.tpFrontRunDollars : entryPrice - first.high - cfg.move.tpFrontRunDollars;
    if (dist >= cfg.move.tp1MinDollars && dist <= cfg.move.tp1MaxDollars) tp1Dollars = dist;
    else if (dist > cfg.move.tp1MaxDollars && first.rank >= 55) tp1Dollars = cfg.move.tp1MaxDollars;
  }
  tp1Dollars = r2(clamp(tp1Dollars, cfg.move.tp1MinDollars, cfg.move.tp1MaxDollars));
  const tp1 = r2(up ? entryPrice + tp1Dollars : entryPrice - tp1Dollars);

  // TP2 / TP3: the NEXT structural levels past TP1, monotonic-guarded.
  const beyond = opposing.filter((l) => (up ? l.low > tp1 + 0.5 : l.high < tp1 - 0.5));
  const tp2Lvl = beyond[0] ?? null;
  let tp2 = tp2Lvl ? r2(up ? tp2Lvl.low - 0.2 : tp2Lvl.high + 0.2) : r2(up ? entryPrice + 2 * tp1Dollars : entryPrice - 2 * tp1Dollars);
  const after2 = beyond.filter((l) => (up ? l.low > tp2 + 0.5 : l.high < tp2 - 0.5));
  const tp3Lvl = after2[0] ?? null;
  let tp3 = tp3Lvl ? r2(up ? tp3Lvl.low - 0.2 : tp3Lvl.high + 0.2) : r2(up ? Math.max(tp2 + tp1Dollars, entryPrice + 3 * tp1Dollars) : Math.min(tp2 - tp1Dollars, entryPrice - 3 * tp1Dollars));
  if (up) { if (tp2 <= tp1) tp2 = r2(tp1 + tp1Dollars); if (tp3 <= tp2) tp3 = r2(tp2 + tp1Dollars); }
  else { if (tp2 >= tp1) tp2 = r2(tp1 - tp1Dollars); if (tp3 >= tp2) tp3 = r2(tp2 - tp1Dollars); }

  const rr1 = r2(tp1Dollars / stopDollars);
  const expectedMove = {
    min: cfg.move.tp1MinDollars,
    primary: r2(Math.min(tp1Dollars, cfg.move.primaryMaxDollars)),
    max: r2(Math.min(cfg.move.maxMoveDollars, Math.abs(tp2 - entryPrice))),
  };

  /* ── 5) Setup family + narration inputs ───────────────────────────────── */
  const sweepAligned = liq.sweep && ((up && liq.sweep.side === "sell-side") || (!up && liq.sweep.side === "buy-side"));
  const nodeFavors = !!node && (up ? node.kind === "support" : node.kind === "resistance");
  const tideWith = (regime.state === "UPTREND" && up) || (regime.state === "DOWNTREND" && !up);
  const setupFamily: SetupFamily =
    sweepAligned ? "LIQUIDITY_SWEEP" :
    exec.state === "BREAKOUT_ENTRY" ? "BREAKOUT" :
    nodeFavors && atNode ? (up ? "SUPPORT_BUY" : "RESISTANCE_SELL") :
    tideWith && exec.state === "WAIT_FOR_PRICE" ? "TREND_PULLBACK" :
    "MOMENTUM";

  const winner = up ? dual.buy : dual.sell;
  const loser = up ? dual.sell : dual.buy;
  const reasons = winner.notes.slice(0, 6);
  if (reasons.length === 0) reasons.push("nothing is screaming, so the call leans on the current drift — size accordingly");
  const against = loser.notes.slice(0, 3);
  const riskFactors = [...dual.penalties];
  if (micro.extended && micro.extendedSide === (up ? "up" : "down")) riskFactors.push("price is stretched on the 5M — entries here chase");
  if (regime.state === "TRANSITION") riskFactors.push("the 4H regime is mid-handover — first moves often fake");
  if (vol.expanding) riskFactors.push("candle ranges are expanding — stops get tested harder");

  const timeframes: TfSummary[] = [
    { tf: "D", state: daily.marketState.replace(/_/g, " "), note: `strength ${daily.trendStrength} — the map` },
    { tf: "4H", state: regime.state, note: regime.note },
    { tf: "1H", state: sctx.externalTrend.replace(/_/g, " "), note: "the structure the trade lives in" },
    { tf: "15M", state: reaction.state.replace(/_/g, " "), note: reaction.detail },
    { tf: "5M", state: micro.available ? micro.microTrend.toUpperCase() : "N/A", note: micro.detail },
  ];

  const path = expectedPath({ direction, price, atr15, state: exec.state, entry: exec.entry, tp1, tp2 });

  const stateLine =
    exec.state === "TAKE_NOW" ? "TAKE IT NOW" :
    exec.state === "WAIT_FOR_PRICE" ? `WAIT FOR ${exec.entry.price.toFixed(2)}` :
    `ARM THE BREAK AT ${exec.entry.price.toFixed(2)}`;
  const summary = `${up ? "BUY" : "SELL"} — gun to the head, the next $${expectedMove.primary.toFixed(0)} move is ${up ? "up" : "down"} (${dual.conviction}% conviction). ${stateLine}: stop $${stopDollars.toFixed(2)} away, first target $${tp1Dollars.toFixed(2)} out.`;

  return {
    direction,
    confidence: dual.conviction,
    entry: r2(entryPrice), stopLoss, tp1, tp2, tp3, stopDollars, tp1Dollars, rr1,
    reasons, against, summary,
    conviction: dual.conviction,
    buyScore: dual.buy.total, sellScore: dual.sell.total, differential: dual.differential,
    scoreParts: { buy: dual.buy.parts, sell: dual.sell.parts },
    executionState: exec.state, entryPlan: exec.entry, entryQualityScore: exec.entryQualityScore,
    expectedMove, setupFamily,
    regime: regime.state, session: session.label, volatility: vol.state,
    timeframes, riskFactors, expectedPath: path,
    engine: DECISION_ENGINE_VERSION,
  };
}
