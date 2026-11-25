import { createHash } from "node:crypto";
import type { Bar, MarketSnapshot, Setup } from "../rapid/core/types";
import { TF_MS } from "../rapid/market/bars";

export const MAX_REFERENCE_AGE_MS = 120_000;
export function referenceFresh(bars: Bar[], now: number): boolean {
  const last = bars[bars.length - 1];
  return Boolean(last && last.t + 60_000 <= now && now - last.t - 60_000 <= MAX_REFERENCE_AGE_MS);
}

/** Same completed setup remains the same opportunity across snapshots and worker restarts. */
export function opportunityId(setup: Setup): string {
  return "nitrous:" + createHash("sha256").update([
    setup.strategyVersion, setup.parentId, setup.zoneVersion, setup.side, setup.family,
    setup.breakEvidence?.closedAt ?? "pullback", new Date(setup.createdAt).toISOString().slice(0, 10),
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

/** A trend pullback needs an observed closed rejection; a break/retest needs its closed break. */
export function triggerConfirmed(setup: Setup, bars: Bar[], now: number): boolean {
  if (setup.family === "break_retest") {
    if (!setup.breakEvidence || setup.breakEvidence.closedAt >= now || now >= setup.expiresAt) return false;
    const index = bars.findIndex((b) => b.t + TF_MS[setup.timeframe] === setup.breakEvidence!.closedAt);
    if (index < 1) return false;
    const threshold = setup.refEntry + (setup.side === "buy" ? 1 : -1) * setup.tolerances.breakBuffer;
    // A candle already on the broken side is continuation, not a fresh structural break.
    return setup.side === "buy" ? bars[index - 1].c <= threshold : bars[index - 1].c >= threshold;
  }
  if (setup.family !== "trend_pullback") return false;
  const ms = TF_MS[setup.timeframe];
  const b = bars[bars.length - 1];
  if (!b || b.t + ms > now || now - b.t - ms > ms || b.h <= b.l) return false;
  const touched = b.l <= setup.entryBandHigh && b.h >= setup.entryBandLow;
  const closesAway = setup.side === "buy"
    ? b.c > b.o && b.c >= setup.entryBandLow && (b.c - b.l) / (b.h - b.l) >= 0.65
    : b.c < b.o && b.c <= setup.entryBandHigh && (b.c - b.l) / (b.h - b.l) <= 0.35;
  return touched && closesAway;
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
