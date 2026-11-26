import { createHash } from "node:crypto";
import type { Bar, MarketSnapshot, Regime, Rejection, Setup, Timeframe, ValidatedRange } from "../rapid/core/types";
import { TF_MS } from "../rapid/market/bars";
import { isFastSetup, isSweepSetup } from "./config";
import { setupAuthorized } from "../src/lib/nitrous/policy";

export const MAX_REFERENCE_AGE_MS = 120_000;
export function referenceFresh(bars: Bar[], now: number): boolean {
  const last = bars[bars.length - 1];
  return Boolean(last && last.t + 60_000 <= now && now - last.t - 60_000 <= MAX_REFERENCE_AGE_MS);
}

/** Same completed setup remains the same opportunity across snapshots and worker restarts. */
export function opportunityId(setup: Setup): string {
  const eventTime = setup.sweepEvidence?.candleClosedAt;
  return "nitrous:" + createHash("sha256").update([
    setup.strategyVersion, ...(isFastSetup(setup) || isSweepSetup(setup) ? [setup.configVersion] : []), setup.parentId, setup.zoneVersion, setup.side, setup.family,
    eventTime ?? setup.breakEvidence?.closedAt ?? "pullback", new Date(eventTime ?? setup.createdAt).toISOString().slice(0, 10),
  ].join("|")).digest("hex").slice(0, 32);
}

/** Only strategies explicitly included in this first release can become executable. */
export function supportedSetups(snapshot: MarketSnapshot): Setup[] {
  return snapshot.scenarios.filter((s) => {
    if (s.family !== "trend_pullback" && s.family !== "break_retest") return false;
    const direction = s.side === "buy" ? "up" : "down";
    return snapshot.regimes.H1 === direction && snapshot.regimes.M15 === direction;
  }).map((s) => ({ ...s, setupId: opportunityId(s), conditionsPending: [
    ...(s.family === "trend_pullback" ? ["A completed entry candle rejects the pullback zone."] : []),
    "Broker price returns inside the entry zone with affordable size, spread and margin.",
  ] }));
}

/** Additional nearby structural opportunities; no blind or countertrend entries. */
export function fastCandidateEligible(s: Setup, regimes: Record<Timeframe, Regime>, range: ValidatedRange | null, price: number, now: number): boolean {
  if (!isFastSetup(s) || !Number.isFinite(price) || price <= 0 || s.expiresAt <= now || s.createdAt > now) return false;
  if (s.timeframe !== "M5" && s.timeframe !== "M15") return false;
  const direction = s.side === "buy" ? "up" : "down";
  const h1 = regimes.H1, m15 = regimes.M15;
  if (h1 !== direction || (m15 !== direction && m15 !== "sideways")) return false;
  if (s.family === "range_reaction") {
    if (m15 !== "sideways" || !range || range.brokenAt != null || range.timeframe !== s.timeframe || range.knownAt > now) return false;
    if ((s.side === "buy" ? range.lower.id : range.upper.id) !== s.zoneId) return false;
  } else if (s.family === "break_retest") {
    if (!s.breakEvidence || s.breakEvidence.closedAt >= now) return false;
  } else if (s.family !== "trend_pullback") return false;
  const distance = Math.max(s.entryBandLow - price, price - s.entryBandHigh, 0);
  return distance <= 12 && (s.side === "buy" ? price > s.invalidation && price < s.target : price < s.invalidation && price > s.target);
}
export function fastSetups(snapshot: MarketSnapshot): Setup[] {
  return snapshot.scenarios.filter(isFastSetup).map(s => ({
    ...s, setupId: opportunityId(s),
    conditionsMet: ["Nitrous-only · faster setup qualification", ...s.conditionsMet],
    conditionsPending: [
      s.family === "break_retest" ? "A fresh closed break and a return to the entry zone." : "A completed entry candle rejects the zone.",
      "Fresh broker price, structural stop, net reward/risk, spread, margin and account risk must qualify.",
    ],
  }));
}
/** Sweeps use the same directional context as faster Nitrous, with an immediate, bounded entry. */
export function sweepCandidateEligible(s: Setup, regimes: Record<Timeframe, Regime>, price: number, now: number): boolean {
  if (!isSweepSetup(s) || s.family !== "sweep_reclaim" || !s.sweepEvidence || !Number.isFinite(price) || price <= 0
    || !Number.isFinite(now) || s.createdAt > now || s.expiresAt <= now
    || (s.timeframe !== "M5" && s.timeframe !== "M15")) return false;
  const direction = s.side === "buy" ? "up" : "down";
  if (regimes.H1 !== direction || (regimes.M15 !== direction && regimes.M15 !== "sideways")) return false;
  return price >= s.entryBandLow && price <= s.entryBandHigh && (s.side === "buy"
    ? price > s.invalidation && price < s.target : price < s.invalidation && price > s.target);
}
export function sweepSetups(snapshot: MarketSnapshot): Setup[] {
  return snapshot.scenarios.filter(s => isSweepSetup(s) && s.family === "sweep_reclaim").map(s => ({
    ...s, setupId: opportunityId(s),
    conditionsMet: ["Nitrous-only · completed sweep and reclaim", ...s.conditionsMet],
    conditionsPending: [
      "A fresh broker quote stays inside the entry band around the completed reclaim close; no separate retest is required.",
      "Sweep authorization, structural stop, net reward/risk, spread, margin and account risk must qualify.",
    ],
  }));
}
export function mergeNitrousSetups(baseline: Setup[], fast: Setup[], sweeps: Setup[] = []): Setup[] {
  const key = (s: Setup) => `${s.parentId}|${s.side}`;
  const keys = new Set(baseline.map(key));
  const existing = [...baseline, ...fast.filter(s => !keys.has(key(s)))];
  const ids = new Set(existing.map(s => s.setupId));
  // Keep earlier authorized plans available to v1/v2 accounts. A separately confirmed sweep
  // is a capability alternative; the unchanged account + parent + side + day intent key
  // still permits only one reservation at that economic level.
  return [...existing, ...sweeps.filter(s => {
    if (!isSweepSetup(s) || s.family !== "sweep_reclaim" || ids.has(s.setupId)) return false;
    ids.add(s.setupId);
    return true;
  })];
}
export function setupAllowedForAccount(setup: Setup, mode: unknown, consent: unknown): boolean {
  return setupAuthorized(setup.configVersion, setup.family, mode, consent);
}
/** Explain a rejected context filter without changing the eligibility decision. */
export function qualificationRejection(s: Setup, regimes: Record<Timeframe, Regime>, range: ValidatedRange | null,
  price: number, now: number, bars: Bar[]): Pick<Rejection, "code" | "detail"> {
  const direction = s.side === "buy" ? "up" : "down";
  if (regimes.H1 !== direction) return { code: "regime_conflict", detail: `The 1H structure is ${regimes.H1}; this ${s.side} setup requires ${direction} structure.` };
  if (regimes.M15 !== direction && regimes.M15 !== "sideways") return { code: "regime_conflict", detail: `The 15M structure opposes this ${s.side} setup.` };
  if (s.expiresAt <= now) return { code: "expired", detail: "The original closed-candle entry window expired." };
  if (s.family === "range_reaction" && (regimes.M15 !== "sideways" || !range || range.brokenAt != null
    || range.timeframe !== s.timeframe || range.knownAt > now || (s.side === "buy" ? range.lower.id : range.upper.id) !== s.zoneId)) {
    return { code: "no_zone", detail: "The entry is not at a currently validated, unbroken range boundary during 15M consolidation." };
  }
  if (!triggerConfirmed(s, bars, now) && (s.family === "sweep_reclaim" || s.family === "break_retest")) {
    return s.family === "sweep_reclaim" ? { code: "no_reclaim", detail: "The completed sweep/reclaim evidence is unavailable, revised or no longer fresh." }
      : { code: "not_fresh_visit", detail: "A genuine completed crossing of the boundary is required; continuation alone is insufficient." };
  }
  const distance = Math.max(s.entryBandLow-price,price-s.entryBandHigh,0);
  if (distance > (isSweepSetup(s) ? 0 : 12)) return { code: "outside_band", detail: isSweepSetup(s)
    ? "Price has left the bounded entry around the reclaim close." : `The entry band is ${distance.toFixed(2)} away; the nearby setup limit is 12.` };
  return { code: "outside_band", detail: "Current reference price is outside the setup's valid entry, invalidation or target boundaries." };
}
/** Pullback/range entries need a closed rejection; a break/retest needs its closed break. */
export function triggerConfirmed(setup: Setup, bars: Bar[], now: number): boolean {
  if (setup.family === "sweep_reclaim") return sweepTriggerConfirmed(setup, bars, now);
  if (setup.family === "break_retest") {
    if (!setup.breakEvidence || setup.breakEvidence.closedAt >= now || now >= setup.expiresAt) return false;
    const index = bars.findIndex((b) => b.t + TF_MS[setup.timeframe] === setup.breakEvidence!.closedAt);
    if (index < 1) return false;
    const threshold = setup.refEntry + (setup.side === "buy" ? 1 : -1) * setup.tolerances.breakBuffer;
    // A candle already on the broken side is continuation, not a fresh structural break.
    return setup.side === "buy" ? bars[index - 1].c <= threshold : bars[index - 1].c >= threshold;
  }
  if (setup.family !== "trend_pullback" && !(setup.family === "range_reaction" && isFastSetup(setup))) return false;
  const ms = TF_MS[setup.timeframe];
  const b = bars[bars.length - 1];
  if (!b || b.t + ms > now || now - b.t - ms > ms || b.h <= b.l) return false;
  const touched = b.l <= setup.entryBandHigh && b.h >= setup.entryBandLow;
  const closesAway = setup.side === "buy"
    ? b.c > b.o && b.c >= setup.entryBandLow && (b.c - b.l) / (b.h - b.l) >= 0.65
    : b.c < b.o && b.c <= setup.entryBandHigh && (b.c - b.l) / (b.h - b.l) <= 0.35;
  return touched && closesAway;
}

/** Recheck the actual completed candle, not a label or a forming wick. */
function sweepTriggerConfirmed(setup: Setup, bars: Bar[], now: number): boolean {
  const e = setup.sweepEvidence;
  if (!isSweepSetup(setup) || !e || (setup.timeframe !== "M5" && setup.timeframe !== "M15")) return false;
  const ms = TF_MS[setup.timeframe];
  if (![now,e.pivotPrice,e.pivotTime,e.pivotKnownAt,e.candleOpenedAt,e.candleClosedAt,e.candleOpen,e.candleHigh,e.candleLow,e.candleClose,
    e.sweepExtreme,e.confirmationThreshold,setup.tolerances.breakBuffer].every(Number.isFinite)
    || e.pivotPrice <= 0 || e.pivotTime <= 0 || e.pivotKnownAt <= e.pivotTime || e.pivotTime >= e.candleOpenedAt || e.pivotKnownAt > e.candleOpenedAt
    || e.candleClosedAt !== e.candleOpenedAt + ms || e.candleClosedAt >= now
    || setup.expiresAt !== e.candleClosedAt + ms || now >= setup.expiresAt
    || e.confirmationThreshold !== e.pivotPrice || setup.tolerances.breakBuffer <= 0) return false;
  const index = bars.findIndex(b => b.t === e.candleOpenedAt);
  if (index < 1) return false;
  const b = bars[index], previous = bars[index - 1];
  if (previous.t + ms !== b.t || b.o !== e.candleOpen || b.h !== e.candleHigh || b.l !== e.candleLow || b.c !== e.candleClose
    || b.h <= b.l || b.h < Math.max(b.o,b.c) || b.l > Math.min(b.o,b.c) || setup.refEntry !== b.c) return false;
  const position = (b.c - b.l) / (b.h - b.l);
  return setup.side === "buy"
    ? e.pivotKind === "low" && previous.c > e.pivotPrice && b.l < e.pivotPrice - setup.tolerances.breakBuffer
      && b.c > e.pivotPrice && b.c > b.o && b.l < b.o && position >= 0.65 && e.sweepExtreme === b.l && setup.invalidation === b.l && setup.stop < b.l
    : e.pivotKind === "high" && previous.c < e.pivotPrice && b.h > e.pivotPrice + setup.tolerances.breakBuffer
      && b.c < e.pivotPrice && b.c < b.o && b.h > b.o && position <= 0.35 && e.sweepExtreme === b.h && setup.invalidation === b.h && setup.stop > b.h;
}

export function aggregateClosed(bars: Bar[], minutes: number, now: number): Bar[] {
  const ms = minutes * 60_000;
  const buckets = new Map<number, { bar: Bar; minutes: Set<number>; invalid: boolean }>();
  for (const b of [...bars].sort((a, b) => a.t - b.t)) {
    const t = Math.floor(b.t / ms) * ms;
    const item = buckets.get(t);
    const valid = [b.t,b.o,b.h,b.l,b.c].every(Number.isFinite) && b.t % 60_000 === 0 && b.l > 0 &&
      b.h >= Math.max(b.o,b.c,b.l) && b.l <= Math.min(b.o,b.c,b.h);
    if (!item) buckets.set(t, { bar: { ...b, t }, minutes: new Set([b.t]), invalid: !valid });
    else {
      item.invalid ||= !valid || item.minutes.has(b.t);
      item.minutes.add(b.t); item.bar.h = Math.max(item.bar.h, b.h); item.bar.l = Math.min(item.bar.l, b.l); item.bar.c = b.c;
    }
  }
  // A gap is not silently turned into a complete candle.
  return [...buckets.values()].filter((v) => !v.invalid && v.minutes.size === minutes && v.bar.t + ms <= now).map((v) => v.bar);
}

/** Profits do not replenish the daily loss allowance. Unknown outcomes stop new entries. */
export function dailyAllowance(startEquity: number, equity: number, pct: number,
  closed: Array<{ realised_pnl: unknown; realised_pnl_source?: unknown }>): number | null {
  if (!(startEquity > 0 && equity > 0 && pct > 0)) return null;
  let losses = 0;
  for (const row of closed) {
    if (row.realised_pnl === null || row.realised_pnl === undefined || !Number.isFinite(Number(row.realised_pnl)) ||
      !["broker_net", "calculated_gross"].includes(String(row.realised_pnl_source))) return null;
    losses += Math.max(0, -Number(row.realised_pnl));
  }
  return Math.max(0, startEquity * pct / 100 - Math.max(losses, startEquity - equity));
}

export function memberActive(row: Record<string, unknown> | null, now: number): boolean {
  if (!row) return false;
  if (row.role === "admin") return true;
  if (row.status !== "active") return false;
  return row.access_expires_at === null || row.access_expires_at === undefined ||
    (Number.isFinite(Date.parse(String(row.access_expires_at))) && Date.parse(String(row.access_expires_at)) > now);
}
