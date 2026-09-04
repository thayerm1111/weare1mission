/**
 * MATTY PIPS — deterministic narration. Turns the DecisionObject's NUMBERS into
 * plain English. Templates only: nothing here decides anything, and nothing an
 * AI writes ever feeds back into the engine.
 */
import type { DecisionObject, SetupStatus, SetupType, TfStructure, Zone } from "./types";
import { formatPrice } from "./pips";

const SETUP_LABEL: Record<SetupType, string> = {
  BUY_SUPPORT: "BUY SUPPORT",
  SELL_RESISTANCE: "SELL RESISTANCE",
  BREAKOUT_RUNNER: "BREAKOUT RUNNER",
};

export function setupLabel(t: SetupType | null): string {
  return t ? SETUP_LABEL[t] : "—";
}

/** The "watching" line shown while there's no trade. */
export function watchLine(o: {
  symbol: string;
  watchType: SetupType | null;
  watchZone: Zone | null;
  distancePips: number | null;
  status: SetupStatus;
  daily: TfStructure;
}): string {
  if (!o.watchZone || !o.watchType) return "No strong level in play — standing down until structure gives one.";
  const z = `${formatPrice(o.symbol, o.watchZone.zoneLow)}–${formatPrice(o.symbol, o.watchZone.zoneHigh)}`;
  const dist = o.distancePips != null && o.distancePips > 0 ? ` (${o.distancePips} pips away)` : " (price is there now)";
  const action = o.watchType === "SELL_RESISTANCE" ? "a sell" : o.watchType === "BUY_SUPPORT" ? "a buy" : "a breakout";
  return `Watching the ${z} ${o.watchZone.zoneType} zone${dist} for ${action} — status: ${o.status.replace("_", " ")}.`;
}

/** The Why This Trade checklist (or "why we wait" lines when there's no trade). */
export function whyThisTrade(d: DecisionObject): string[] {
  const lines: string[] = [];
  const s = d.symbol;
  lines.push(`Daily is ${pretty(d.daily.marketState)} (strength ${d.daily.trendStrength}) — ${d.daily.structureReason}`);
  const h4 = d.structures.find((t) => t.timeframe === "H4");
  if (h4) lines.push(`4H is ${pretty(h4.marketState)} (strength ${h4.trendStrength}).`);
  if (d.trade) {
    const z = d.trade.entryZone;
    lines.push(`Price is ${pretty(d.location)} at the ${formatPrice(s, z.low)}–${formatPrice(s, z.high)} zone (range position ${d.rangePosition}%).`);
    for (const c of d.confirmations.slice(0, 3)) lines.push(`15M confirmation: ${c.label} — ${c.detail}`);
    if (d.trade.setupType === "BREAKOUT_RUNNER" && d.breakoutDetail) lines.push(`Breakout: ${d.breakoutDetail}`);
    lines.push(`Stop ${formatPrice(s, d.trade.stopLoss)} (${d.trade.stopPips} pips, beyond the zone + volatility buffer); TP1 ${formatPrice(s, d.trade.tp1)} at the next opposing zone (${d.trade.tp1Pips} pips) — ${d.trade.riskReward}:1.`);
    lines.push(`Idea dies on a close beyond ${formatPrice(s, d.trade.invalidationLevel)}.`);
    lines.push(`MATTY PIPS SCORE ${d.score.total}/100 (structure ${d.score.structure}/30 · zone ${d.score.zone}/20 · location ${d.score.location}/20 · confirmation ${d.score.confirmation}/15 · R:R ${d.score.riskReward}/10 · momentum ${d.score.momentum}/5).`);
  } else {
    lines.push(`Location: ${pretty(d.location)} — range position ${d.rangePosition}%.`);
    if (d.noTradeReason) lines.push(d.noTradeReason);
    lines.push(d.monitoring.watching);
  }
  return lines;
}

function pretty(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
}
