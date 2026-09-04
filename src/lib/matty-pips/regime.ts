/**
 * MATTY PIPS — 4H regime engine: the TIDE. One of exactly four states read
 * from 4H swing structure, so every lower-timeframe decision knows whether it
 * is trading WITH the tide, AGAINST it, inside a box, or during a handover.
 */
import type { Candle } from "./types";
import { readStructure } from "./structure";

export type RegimeState = "UPTREND" | "DOWNTREND" | "RANGE" | "TRANSITION";

export type RegimeRead = {
  state: RegimeState;
  strength: number;              // 0–100 (trendStrength of the 4H read)
  note: string;
};

export function readRegime(h4: Candle[]): RegimeRead {
  const s = readStructure("H4", h4);

  // TRANSITION: the state just changed, or a trend has decayed to weakness —
  // the old regime is dying and the new one isn't confirmed yet.
  const changed = s.previousMarketState !== s.marketState;
  const weakTrend = s.marketState !== "LEFT_TO_RIGHT" && s.trendStrength < 40;

  let state: RegimeState;
  if (changed || weakTrend) state = "TRANSITION";
  else if (s.marketState === "UPTREND") state = "UPTREND";
  else if (s.marketState === "DOWNTREND") state = "DOWNTREND";
  else state = "RANGE";

  const note =
    state === "UPTREND" ? `4H tide is UP (strength ${s.trendStrength}) — buys are with the tide, sells are counter-trend scalps.` :
    state === "DOWNTREND" ? `4H tide is DOWN (strength ${s.trendStrength}) — sells are with the tide, buys are counter-trend scalps.` :
    state === "RANGE" ? "4H is boxed — trade the edges of the range, fade the middle of nothing." :
    `4H regime is CHANGING (${s.previousMarketState.replace(/_/g, " ")} → ${s.marketState.replace(/_/g, " ")}) — first moves out of a handover often fake.`;

  return { state, strength: s.trendStrength, note };
}
