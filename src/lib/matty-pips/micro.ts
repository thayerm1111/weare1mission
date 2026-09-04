/**
 * MATTY PIPS — 5M micro-read: the TRIGGER timeframe. Closed 5M candles only.
 * Answers three questions the 15M can't answer fast enough:
 *   1. Which way is the micro flow pushing right now?
 *   2. Did a displacement (trigger) candle just fire, and which way?
 *   3. Is price extended on the micro — i.e. would entering here be a chase?
 * Fails soft: with no 5M data every field goes neutral and the scorer treats
 * the component as a wash — the engine still decides from 15M and up.
 */
import type { Candle } from "./types";
import { atr, findPivots } from "./structure";
import type { MpConfig } from "./config";

export type MicroRead = {
  available: boolean;
  microTrend: "up" | "down" | "flat";
  trigger: { side: "buy" | "sell"; detail: string } | null;  // last closed bar
  extended: boolean;             // stretched from the 20-bar mean
  extendedSide: "up" | "down" | null;
  atr5: number;
  detail: string;
};

const NEUTRAL: MicroRead = {
  available: false, microTrend: "flat", trigger: null,
  extended: false, extendedSide: null, atr5: 0,
  detail: "5M feed unavailable — deciding from 15M structure and up.",
};

export function readMicro(m5: Candle[], cfg: MpConfig): MicroRead {
  if (!Array.isArray(m5) || m5.length < 30) return NEUTRAL;
  const closed = m5.slice(0, -1);
  const atr5 = atr(closed);
  if (atr5 <= 0) return NEUTRAL;

  // Micro trend: last two confirmed 5M swing pairs (same rule as every TF).
  const pivots = findPivots(closed.slice(-80), 2);
  const highs = pivots.filter((p) => p.kind === "high").slice(-2);
  const lows = pivots.filter((p) => p.kind === "low").slice(-2);
  let microTrend: MicroRead["microTrend"] = "flat";
  if (highs.length === 2 && lows.length === 2) {
    if (highs[1].price > highs[0].price && lows[1].price > lows[0].price) microTrend = "up";
    else if (highs[1].price < highs[0].price && lows[1].price < lows[0].price) microTrend = "down";
  }

  // Trigger: the LAST CLOSED bar is a displacement candle — big directional
  // body closing near its extreme. That's the "go" print.
  const k = closed[closed.length - 1];
  const range = k.h - k.l;
  const body = Math.abs(k.c - k.o);
  let trigger: MicroRead["trigger"] = null;
  if (range > 0 && body >= cfg.micro.triggerBodyAtr * atr5) {
    const up = k.c > k.o;
    const closePos = (k.c - k.l) / range;                 // 1 = closed on the high
    if (up && closePos >= 1 - cfg.micro.triggerCloseFrac) {
      trigger = { side: "buy", detail: `5M displacement up — ${body.toFixed(2)} body closing near the high.` };
    } else if (!up && closePos <= cfg.micro.triggerCloseFrac) {
      trigger = { side: "sell", detail: `5M displacement down — ${body.toFixed(2)} body closing near the low.` };
    }
  }

  // Extension: distance from the 20-bar mean close, in 5M ATRs.
  const look = closed.slice(-20);
  const mean = look.reduce((s, c) => s + c.c, 0) / look.length;
  const stretch = (k.c - mean) / atr5;
  const extended = Math.abs(stretch) >= cfg.micro.extendedAtr;
  const extendedSide: MicroRead["extendedSide"] = extended ? (stretch > 0 ? "up" : "down") : null;

  const detail = [
    microTrend === "flat" ? "5M flow is flat" : `5M flow pushing ${microTrend}`,
    trigger ? trigger.detail : "no fresh trigger candle",
    extended ? `price is stretched ${extendedSide} ${Math.abs(stretch).toFixed(1)}×ATR5 from its mean — entries here are chases` : "not extended on the micro",
  ].join("; ") + ".";

  return { available: true, microTrend, trigger, extended, extendedSide, atr5, detail };
}
