/**
 * TRADE THESIS + POSITION HEALTH.
 *
 * > A stop loss is the last line of defence. It is not the only reason to exit.
 *
 * The thesis is written once, at entry, and is the benchmark everything afterwards is measured against. The
 * question is never "am I in profit?" but "is the reason I took this still true?".
 */
import type { Mode, Pressure, Regime, Side, StructureState, TfState, TradeThesis } from "./types";
import { PIP } from "./types";
import { isBearish, isBullish } from "./regime";

/** How long each mode's setup has to prove itself, and which timeframe its character is judged on. */
export const MODE_HORIZON: Record<Mode, { followThroughMs: number; structureTf: "1m" | "5m" | "15m" | "1h" | "4h"; noiseFloorPips: number }> = {
  scalp:    { followThroughMs: 35 * 60_000,      structureTf: "5m",  noiseFloorPips: 12 },
  intraday: { followThroughMs: 4 * 3600_000,     structureTf: "15m", noiseFloorPips: 30 },
  swing:    { followThroughMs: 3 * 24 * 3600_000, structureTf: "4h",  noiseFloorPips: 90 },
};

export function buildThesis(input: {
  strategy: string; mode: Mode; side: Side; reason: string; expected: string; invalidation: string;
  invalidationPrice: number; regime: Regime; pressure: number; atr: number; positionInRange: number | null;
}): TradeThesis {
  return {
    strategy: input.strategy, mode: input.mode, side: input.side,
    reason: input.reason, expected: input.expected, invalidation: input.invalidation,
    invalidationPrice: +input.invalidationPrice.toFixed(2),
    followThroughMs: MODE_HORIZON[input.mode].followThroughMs,
    entryContext: { regime: input.regime, pressure: input.pressure, atr: input.atr, positionInRange: input.positionInRange },
  };
}

export type HealthInput = {
  thesis: TradeThesis;
  now: number;
  openedAt: number;
  price: number;
  entry: number;
  structure: StructureState;
  tfState: TfState;
  pressure: Pressure;
  regime: Regime;
  mfePips: number;
  newsImminent?: boolean;
};

export type Health = { score: number; drivers: { label: string; delta: number }[]; verdict: "strong" | "healthy" | "weakening" | "at_risk" | "exit_developing" };

/**
 * A 0–100 score with attributable drivers. It summarises; it does not fire orders. Every driver is a
 * sentence a member could read and check on their own chart.
 */
export function positionHealth(i: HealthInput): Health {
  const long = i.thesis.side === "buy";
  const drivers: { label: string; delta: number }[] = [];
  let score = 70;                                  // a trade with nothing to say for or against it

  const movePips = (long ? i.price - i.entry : i.entry - i.price) / PIP;
  const noise = MODE_HORIZON[i.thesis.mode].noiseFloorPips;
  if (Math.abs(movePips) > noise) {
    const d = Math.round(Math.max(-20, Math.min(20, (movePips / noise) * 8)));
    score += d;
    drivers.push({ label: movePips > 0 ? `${Math.round(movePips)} pips in favour` : `${Math.round(-movePips)} pips against`, delta: d });
  }

  // Structure on the trade's OWN timeframe. A 5-minute wobble is not a swing thesis failing.
  const withTrade = long ? isBullish(i.tfState) : isBearish(i.tfState);
  const againstTrade = long ? isBearish(i.tfState) : isBullish(i.tfState);
  if (withTrade) { score += 10; drivers.push({ label: `${i.thesis.mode} structure still ${long ? "bullish" : "bearish"}`, delta: 10 }); }
  if (againstTrade) { score -= 22; drivers.push({ label: `${i.thesis.mode} structure turned ${long ? "bearish" : "bullish"}`, delta: -22 }); }

  const brokeAgainst = i.structure.brokeStructure === (long ? "down" : "up") && !i.structure.failedBreak;
  if (brokeAgainst) { score -= 25; drivers.push({ label: "structure broke against the trade", delta: -25 }); }

  const netForTrade = long ? i.pressure.net : -i.pressure.net;
  const pd = Math.round(Math.max(-18, Math.min(18, netForTrade / 4)));
  if (Math.abs(pd) >= 4) { score += pd; drivers.push({ label: pd > 0 ? "pressure still favours the trade" : "pressure flipped against the trade", delta: pd }); }

  // Invalidation is a price, and price does not care how the trade feels.
  const invalidated = long ? i.price < i.thesis.invalidationPrice : i.price > i.thesis.invalidationPrice;
  if (invalidated) { score -= 30; drivers.push({ label: `price is beyond the invalidation level ${i.thesis.invalidationPrice}`, delta: -30 }); }

  // Failing by doing nothing: a "momentum" trade that has not moved has already been wrong for a while.
  const age = i.now - i.openedAt;
  if (age > i.thesis.followThroughMs && Math.abs(movePips) < noise) {
    score -= 15; drivers.push({ label: `no follow-through after ${Math.round(age / 60_000)} minutes`, delta: -15 });
  }

  // Giving back a real winner is information, not bad luck.
  if (i.mfePips > noise * 2 && movePips < i.mfePips * 0.4) {
    score -= 12; drivers.push({ label: `gave back most of a ${Math.round(i.mfePips)}-pip run`, delta: -12 });
  }

  if (i.regime !== i.thesis.entryContext.regime && (i.regime === "chaotic" || i.regime === "news_shock")) {
    score -= 10; drivers.push({ label: `regime became ${i.regime.replace("_", " ")}`, delta: -10 });
  }
  if (i.newsImminent) { score -= 6; drivers.push({ label: "high-impact news is close", delta: -6 }); }

  const final = Math.max(0, Math.min(100, Math.round(score)));
  const verdict: Health["verdict"] =
    final >= 85 ? "strong" : final >= 65 ? "healthy" : final >= 50 ? "weakening" : final >= 32 ? "at_risk" : "exit_developing";
  return { score: final, drivers: drivers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)), verdict };
}

/**
 * CHANGE OF CHARACTER, horizon-relative. The rule that keeps a 5-minute candle from closing a swing trade:
 * a thesis only dies on evidence from ITS OWN timeframe, and one weak signal is never enough.
 */
export function thesisStillValid(h: Health, i: HealthInput): { valid: boolean; action: "hold" | "reduce" | "protect" | "exit"; why: string } {
  const invalidated = i.thesis.side === "buy" ? i.price < i.thesis.invalidationPrice : i.price > i.thesis.invalidationPrice;
  const structureAgainst = i.structure.brokeStructure === (i.thesis.side === "buy" ? "down" : "up") && !i.structure.failedBreak;

  if (invalidated && structureAgainst) {
    return { valid: false, action: "exit", why: `Price accepted beyond ${i.thesis.invalidationPrice} and ${i.thesis.mode} structure broke against the trade — the reason for this trade is gone.` };
  }
  if (h.verdict === "exit_developing") {
    return { valid: false, action: "exit", why: `Position health ${h.score}: ${h.drivers.slice(0, 2).map((d) => d.label).join(" · ")}.` };
  }
  if (h.verdict === "at_risk") {
    return { valid: true, action: "protect", why: `Position health ${h.score} — protecting what is there while the thesis is still technically alive.` };
  }
  if (h.verdict === "weakening") {
    return { valid: true, action: "reduce", why: `Position health ${h.score} — reducing risk, not abandoning the trade.` };
  }
  return { valid: true, action: "hold", why: `Position health ${h.score} — the thesis is intact; leaving it alone.` };
}
