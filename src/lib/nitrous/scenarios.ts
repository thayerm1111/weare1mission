import { readAggressiveEvidence } from "./aggressive-evidence";
import { setupCapability } from "./policy";
import type { NitrousScenario, NitrousSweepEvidence } from "./types";

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const states = new Set(["watching", "approaching", "armed", "triggered", "consumed", "waiting_for_departure", "invalidated", "expired"]);
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];

/** Copy only public candle/level evidence; never spread properties from persisted JSON. */
function sweepEvidence(value: unknown, timeframe: string, side: "buy" | "sell", now: number): NitrousSweepEvidence | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const numbers = ["pivotPrice", "pivotTime", "pivotKnownAt", "candleOpenedAt", "candleClosedAt", "candleOpen",
    "candleHigh", "candleLow", "candleClose", "sweepExtreme", "confirmationThreshold"] as const;
  if (typeof v.pivotId !== "string" || !v.pivotId || v.pivotKind !== (side === "buy" ? "low" : "high")
    || !numbers.every(key => positive(v[key]))) return null;
  const n = v as Record<(typeof numbers)[number], number>;
  const duration = timeframe === "M5" ? 300_000 : timeframe === "M15" ? 900_000 : 0;
  if (!duration || n.pivotTime > n.pivotKnownAt || n.pivotKnownAt > n.candleOpenedAt
    || n.candleClosedAt - n.candleOpenedAt !== duration || n.candleClosedAt > now
    || n.candleHigh < Math.max(n.candleOpen, n.candleClose, n.candleLow)
    || n.candleLow > Math.min(n.candleOpen, n.candleClose, n.candleHigh)) return null;
  return {
    pivotId: v.pivotId, pivotKind: v.pivotKind as "low" | "high", pivotPrice: n.pivotPrice,
    pivotTime: n.pivotTime, pivotKnownAt: n.pivotKnownAt, candleOpenedAt: n.candleOpenedAt,
    candleClosedAt: n.candleClosedAt, candleOpen: n.candleOpen, candleHigh: n.candleHigh,
    candleLow: n.candleLow, candleClose: n.candleClose, sweepExtreme: n.sweepExtreme,
    confirmationThreshold: n.confirmationThreshold,
  };
}

/** Public analysis is descriptive. Classification here never grants an account entry permission. */
export function publicNitrousScenario(value: unknown, now: number, stale: boolean): NitrousScenario | null {
  if (!value || typeof value !== "object" || !Number.isFinite(now)) return null;
  const s = value as Record<string, unknown>;
  const capability = setupCapability(s.configVersion, s.family);
  if (!capability || typeof s.setupId !== "string" || !s.setupId || typeof s.family !== "string"
    || typeof s.configVersion !== "string" || (s.side !== "buy" && s.side !== "sell")
    || (s.timeframe !== "M5" && s.timeframe !== "M15") || typeof s.state !== "string" || !states.has(s.state)
    || ![s.refEntry, s.stop, s.target, s.entryBandLow, s.entryBandHigh, s.expiresAt, s.invalidation, s.stopUsd, s.targetUsd].every(positive)) return null;
  const n = s as Record<"refEntry" | "stop" | "target" | "entryBandLow" | "entryBandHigh" | "expiresAt" | "invalidation" | "stopUsd" | "targetUsd", number>;
  if (n.entryBandLow > n.entryBandHigh || n.refEntry < n.entryBandLow || n.refEntry > n.entryBandHigh
    || (s.side === "buy" ? n.stop >= n.entryBandLow || n.target <= n.entryBandHigh
      : n.stop <= n.entryBandHigh || n.target >= n.entryBandLow)) return null;
  const evidence = capability === "sweep" ? sweepEvidence(s.sweepEvidence, s.timeframe, s.side, now) : null;
  if (capability === "sweep" && !evidence) return null;
  const aggressive = capability === "aggressive" ? readAggressiveEvidence(s.aggressiveEvidence, s.family, s.side, now) : null;
  if (capability === "aggressive" && (!aggressive || s.timeframe !== "M5" || n.refEntry !== aggressive.candleClose)) return null;
  return {
    setupId: s.setupId, family: s.family, side: s.side, timeframe: s.timeframe,
    state: n.expiresAt <= now ? "expired" : stale ? "stale" : s.state,
    profile: capability === "baseline" ? "both" : "nitrous", capability, configVersion: s.configVersion,
    entryBandLow: n.entryBandLow, entryBandHigh: n.entryBandHigh, refEntry: n.refEntry,
    stop: n.stop, target: n.target, stopUsd: n.stopUsd, targetUsd: n.targetUsd,
    expiresAt: n.expiresAt, invalidation: n.invalidation,
    conditionsMet: strings(s.conditionsMet), conditionsPending: strings(s.conditionsPending),
    ...(typeof s.explanation === "string" ? { explanation: s.explanation } : {}),
    ...(aggressive ? { aggressiveEvidence: aggressive } : {}),
    ...(evidence ? { sweepEvidence: evidence } : {}),
  };
}
