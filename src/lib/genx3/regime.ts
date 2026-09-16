import { type Bar, atr } from "./candles";
import { box, efficiency, ema, pivots, swingState, type SwingState } from "./structure";
import { CONFIG, STRATEGY_VERSION } from "./config";

export type Regime = "TREND_UP" | "TREND_DOWN" | "ORDERLY_RANGE" | "COMPRESSION" | "BREAKOUT_EXPANSION" | "TRANSITION" | "DISORDERED_NO_TRADE";
export type Bias = "UP" | "DOWN" | "NEUTRAL";

export type RegimeResult = {
  regime: Regime; confidence: number;
  bias1h: Bias; env4h: Bias;
  supporting: string[]; contradicting: string[]; invalidation: string[];
  features: Record<string, number | string | boolean | null>;
  swings15m: SwingState;
  box15m: { high: number; low: number } | null;
  compressionBox: { high: number; low: number } | null; // most recent compression box (for breakout playbook)
  breakoutSide: "up" | "down" | null;
  atr15: number; atr5: number | null;
  strategyVersion: string;
};

function biasOf(bars: Bar[], emaLen: number, left: number, right: number, tfMs: number): { bias: Bias; why: string } {
  if (bars.length < emaLen + 5) return { bias: "NEUTRAL", why: "insufficient_history" };
  const e = ema(bars.map((b) => b.c), emaLen);
  const slope = e.at(-1)! - e.at(-6)!;
  const sw = swingState(bars, pivots(bars, left, right, tfMs).confirmed);
  const close = bars.at(-1)!.c;
  if (sw.trend === "up" && close > e.at(-1)! && slope > 0) return { bias: "UP", why: "HH/HL above rising EMA" };
  if (sw.trend === "down" && close < e.at(-1)! && slope < 0) return { bias: "DOWN", why: "LH/LL below falling EMA" };
  if (close > e.at(-1)! && slope > 0 && sw.trend !== "down") return { bias: "UP", why: "above rising EMA" };
  if (close < e.at(-1)! && slope < 0 && sw.trend !== "up") return { bias: "DOWN", why: "below falling EMA" };
  return { bias: "NEUTRAL", why: "mixed" };
}

/** Classify the 15m regime from CLOSED bars only. */
export function classifyRegime(m15: Bar[], h1: Bar[], h4: Bar[], m5: Bar[]): RegimeResult | null {
  const R = CONFIG.regime, S = CONFIG.structure;
  const atr15 = atr(m15, S.atrPeriod);
  const atrShort = atr(m15, 5), atrLong = atr(m15, 40);
  const er = efficiency(m15, R.efficiencyBars);
  if (atr15 == null || atrShort == null || atrLong == null || er == null) return null;
  const volRatio = atrShort / atrLong;
  const piv = pivots(m15, S.pivotLeft15m, S.pivotRight15m, 900_000);
  const sw = swingState(m15, piv.confirmed);
  const e20 = ema(m15.map((b) => b.c), 20).at(-1)!;
  const last = m15.at(-1)!;
  const prevBox = box(m15, 24, 0.25 * atr15, m15.length - 1);
  const rangeBox = box(m15, R.rangeBoxBars, 0.25 * atr15);
  const compBox = box(m15, 16, 0.25 * atr15);
  const b1 = biasOf(h1, 50, 3, 3, 3_600_000);
  const b4 = biasOf(h4, 20, 2, 2, 14_400_000);

  // Most recent compression box within the last 12 bars (for breakout retest).
  let compressionBox: RegimeResult["compressionBox"] = null;
  for (let end = m15.length - 1; end >= m15.length - 12 && end > 40; end--) {
    const bx = box(m15, 16, 0, end); const aL = atr(m15, 40, end);
    if (bx && aL && bx.width <= R.compressionWidthAtrMax * aL) { compressionBox = { high: bx.high, low: bx.low }; break; }
  }
  let breakoutSide: RegimeResult["breakoutSide"] = null;
  const recent = m15.slice(-3);
  if (prevBox) {
    for (const b of recent) {
      const body = Math.abs(b.c - b.o);
      if (b.c > prevBox.high + R.breakoutBufferAtr * atr15 && body >= R.breakoutBodyAtr * atr15) breakoutSide = "up";
      if (b.c < prevBox.low - R.breakoutBufferAtr * atr15 && body >= R.breakoutBodyAtr * atr15) breakoutSide = "down";
    }
  }

  const features = {
    atr15, atrShort, atrLong, volRatio: +volRatio.toFixed(3), efficiency: +er.toFixed(3), ema20: e20, close: last.c,
    swingTrend: sw.trend, bos: sw.bos, choch: sw.choch,
    rangeWidthAtr: rangeBox ? +(rangeBox.width / atr15).toFixed(2) : null,
    rangeTouchesHigh: rangeBox?.touchesHigh ?? null, rangeTouchesLow: rangeBox?.touchesLow ?? null,
    compressionWidthAtr: compBox ? +(compBox.width / atrLong).toFixed(2) : null,
    breakoutSide, bias1h: b1.bias, env4h: b4.bias,
  };
  const sup: string[] = [], con: string[] = [], inv: string[] = [];
  let regime: Regime = "TRANSITION"; let conf = 40;

  if (volRatio >= R.volRatioDisordered || (er < 0.12 && volRatio > 1.6)) {
    regime = "DISORDERED_NO_TRADE"; conf = Math.min(95, 60 + (volRatio - 1.6) * 30);
    sup.push(`short/long volatility ${volRatio.toFixed(2)}`, `efficiency ${er.toFixed(2)}`);
  } else if (breakoutSide && volRatio >= 1.2) {
    regime = "BREAKOUT_EXPANSION"; conf = Math.min(90, 60 + (volRatio - 1.2) * 40);
    sup.push(`15m close beyond 24-bar box (${breakoutSide})`, `volatility expanding ${volRatio.toFixed(2)}`);
    inv.push(`close back inside ${prevBox!.low.toFixed(2)}–${prevBox!.high.toFixed(2)}`);
  } else if (compBox && compBox.width <= R.compressionWidthAtrMax * atrLong && volRatio <= R.compressionVolRatioMax) {
    regime = "COMPRESSION"; conf = Math.min(90, 55 + (R.compressionVolRatioMax - volRatio) * 80);
    sup.push(`16-bar box ${(compBox.width / atrLong).toFixed(2)}×ATR40`, `volatility contracting ${volRatio.toFixed(2)}`);
    inv.push("15m close beyond the compression box");
  } else if (er >= R.trendEfficiencyMin && sw.trend === "up" && last.c > e20) {
    regime = "TREND_UP"; conf = Math.min(95, 50 + er * 60 + (b1.bias === "UP" ? 10 : 0));
    sup.push("15m HH + HL", `efficiency ${er.toFixed(2)}`, "close above EMA20");
    if (b1.bias === "DOWN") con.push("1H bias down");
    inv.push(`15m close below last swing low ${sw.lastLow?.price.toFixed(2)}`);
  } else if (er >= R.trendEfficiencyMin && sw.trend === "down" && last.c < e20) {
    regime = "TREND_DOWN"; conf = Math.min(95, 50 + er * 60 + (b1.bias === "DOWN" ? 10 : 0));
    sup.push("15m LH + LL", `efficiency ${er.toFixed(2)}`, "close below EMA20");
    if (b1.bias === "UP") con.push("1H bias up");
    inv.push(`15m close above last swing high ${sw.lastHigh?.price.toFixed(2)}`);
  } else if (rangeBox && er <= R.rangeEfficiencyMax && rangeBox.width >= R.rangeWidthAtrMin * atr15 && rangeBox.width <= R.rangeWidthAtrMax * atr15
             && rangeBox.touchesHigh >= 2 && rangeBox.touchesLow >= 2 && volRatio >= 0.6 && volRatio <= 1.4) {
    regime = "ORDERLY_RANGE"; conf = Math.min(90, 55 + (R.rangeEfficiencyMax - er) * 100 + Math.min(rangeBox.touchesHigh, rangeBox.touchesLow) * 3);
    sup.push(`32-bar range ${(rangeBox.width / atr15).toFixed(1)}×ATR`, `touches ${rangeBox.touchesHigh}/${rangeBox.touchesLow}`, `efficiency ${er.toFixed(2)}`);
    inv.push(`15m close beyond ${rangeBox.low.toFixed(2)}–${rangeBox.high.toFixed(2)}`);
  } else {
    regime = "TRANSITION"; conf = 50;
    con.push(`efficiency ${er.toFixed(2)}`, `swing trend ${sw.trend}`);
  }
  if (sw.choch) con.push(`change of character ${sw.choch}`);
  return {
    regime, confidence: Math.round(conf), bias1h: b1.bias, env4h: b4.bias,
    supporting: sup, contradicting: con, invalidation: inv, features,
    swings15m: sw, box15m: rangeBox ? { high: rangeBox.high, low: rangeBox.low } : null,
    compressionBox, breakoutSide, atr15, atr5: atr(m5, S.atrPeriod), strategyVersion: STRATEGY_VERSION,
  };
}
