import type { Regime, Setup, Timeframe } from "../rapid/core/types";
import { isAggressiveSetup } from "./config";

export function accountVisitId(accountId: string, s: Setup, now: number): string {
  const at = isAggressiveSetup(s) && s.aggressiveEvidence ? s.aggressiveEvidence.candleClosedAt : now;
  return `${accountId}|${s.parentId}|${s.zoneVersion}|${s.side}|${new Date(at).toISOString().slice(0, 10)}`;
}

export function baselineCandidateEligible(s: Setup, regimes: Record<Timeframe, Regime>): boolean {
  if (s.family !== "trend_pullback" && s.family !== "break_retest") return false;
  const direction = s.side === "buy" ? "up" : "down";
  return regimes.H1 === direction && regimes.M15 === direction;
}

/** Expose a distinct fast fallback only when both versions of the same structural
 * level would reserve the same account visit. Conflicting versions keep baseline precedence. */
export function baselineCoversFast(a: Setup, b: Setup): boolean {
  if (a.parentId !== b.parentId || a.side !== b.side) return false;
  if (a.zoneVersion !== b.zoneVersion) return true;
  return a.family === b.family && a.timeframe === b.timeframe &&
    a.entryBandLow === b.entryBandLow && a.entryBandHigh === b.entryBandHigh &&
    a.refEntry === b.refEntry && a.invalidation === b.invalidation && a.stop === b.stop && a.target === b.target &&
    a.expiresAt === b.expiresAt && a.breakEvidence?.closedAt === b.breakEvidence?.closedAt &&
    a.tolerances.breakBuffer === b.tolerances.breakBuffer && a.tolerances.atrEntry === b.tolerances.atrEntry;
}
