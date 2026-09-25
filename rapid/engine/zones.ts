import type { Bar, Pivot, Reaction, Timeframe, Zone, ZoneProvenance, ZoneRole } from "../core/types";
import { TF_MS } from "../market/bars";
import { roundToStep } from "../core/decimal";

/**
 * Levels with a lifecycle.
 *
 * A level is not a line someone drew after the fact. Every zone here records when it became knowable,
 * what it was built from, the role it currently plays, when that role last flipped, and every
 * completed reaction against it. A zone whose bounds change gets a NEW VERSION rather than being
 * edited in place, so a pending or open trade can keep pointing at the exact geometry it was planned
 * against.
 */

export type ZoneSeed = {
  role: ZoneRole;
  low: number;
  high: number;
  origin: Timeframe;
  provenance: ZoneProvenance;
  knownAt: number;
  tier: "primary" | "execution";
};

/**
 * Zone geometry from a pivot bar.
 *
 * Resistance runs from the body top to the high; support runs from the low to the body bottom. A
 * genuinely broad wick is PRESERVED — narrowing it to buy a smaller stop would be inventing a level
 * that never existed. A zone too wide for a Rapid trade stays visible and is simply ineligible.
 */
export function zoneFromPivot(bar: Bar, kind: "high" | "low", tick: number, minWidthTicks: number): { low: number; high: number } {
  const minWidth = minWidthTicks * tick;
  let low: number;
  let high: number;
  if (kind === "high") {
    low = Math.max(bar.o, bar.c);
    high = bar.h;
  } else {
    low = bar.l;
    high = Math.min(bar.o, bar.c);
  }
  if (high - low < minWidth) {
    const mid = (high + low) / 2;
    low = mid - minWidth / 2;
    high = mid + minWidth / 2;
  }
  return { low: roundToStep(low, tick, "down"), high: roundToStep(high, tick, "up") };
}

export function seedFromPivot(
  bars: Bar[],
  pivot: Pivot,
  tick: number,
  minWidthTicks: number,
  tier: "primary" | "execution",
): ZoneSeed | null {
  const bar = bars[pivot.barIndex];
  if (!bar) return null;
  const { low, high } = zoneFromPivot(bar, pivot.kind, tick, minWidthTicks);
  return {
    role: pivot.kind === "high" ? "resistance" : "support",
    low,
    high,
    origin: pivot.timeframe,
    provenance: { kind: "swing", timeframe: pivot.timeframe, pivotT: pivot.t },
    knownAt: pivot.knownAt,
    tier,
  };
}

/** A level line (prior day/week high or low) expressed as a minimum-width zone. */
export function seedFromLine(
  price: number,
  role: ZoneRole,
  origin: Timeframe,
  provenance: ZoneProvenance,
  knownAt: number,
  tick: number,
  minWidthTicks: number,
): ZoneSeed {
  const half = (minWidthTicks * tick) / 2;
  return {
    role,
    low: roundToStep(price - half, tick, "down"),
    high: roundToStep(price + half, tick, "up"),
    origin,
    provenance,
    knownAt,
    tier: "primary",
  };
}

export const zoneMid = (z: { low: number; high: number }) => (z.low + z.high) / 2;
export const zoneWidth = (z: { low: number; high: number }) => z.high - z.low;

/** The edge of a zone facing an approach from `from`. */
export const nearEdge = (z: { low: number; high: number }, from: "above" | "below") => (from === "above" ? z.high : z.low);
/** The far side — what a stop has to survive. */
export const farEdge = (z: { low: number; high: number }, from: "above" | "below") => (from === "above" ? z.low : z.high);

export const overlaps = (a: { low: number; high: number }, b: { low: number; high: number }) => a.low <= b.high && b.low <= a.high;

export function makeZone(seed: ZoneSeed, id: string, parentId: string, now: number): Zone {
  return {
    id,
    version: 1,
    parentId,
    role: seed.role,
    low: seed.low,
    high: seed.high,
    origin: seed.origin,
    provenance: seed.provenance,
    createdAt: now,
    knownAt: seed.knownAt,
    roleSince: seed.knownAt,
    previousRole: null,
    reactions: [],
    failedStops: 0,
    invalidatedAt: null,
    invalidReason: null,
    mergedFrom: [],
    tier: seed.tier,
  };
}

/**
 * Merge overlapping same-role zones whose midpoints sit within `mergeAtrMult x ATR` of one another.
 *
 * The survivor keeps the OLDEST id and parentId so a cross-timeframe copy of the same level cannot
 * present itself as a fresh, unvisited location. Bounds are the union, so merging never narrows a
 * zone. When the bounds actually change, the version increments — that is the signal to downstream
 * code that this is new geometry and any frozen reference is now historical.
 */
export function mergeZones(zones: Zone[], atrByTimeframe: Partial<Record<Timeframe, number>>, mergeAtrMult: number): Zone[] {
  const live = zones.filter((z) => z.invalidatedAt == null).slice().sort((a, b) => a.knownAt - b.knownAt || a.id.localeCompare(b.id));
  const out: Zone[] = [];

  for (const z of live) {
    const tolerance = (atrByTimeframe[z.origin] ?? 0) * mergeAtrMult;
    const host = out.find(
      (h) => h.role === z.role && (overlaps(h, z) || Math.abs(zoneMid(h) - zoneMid(z)) <= tolerance),
    );
    if (!host) {
      out.push({ ...z, reactions: [...z.reactions], mergedFrom: [...z.mergedFrom] });
      continue;
    }
    const low = Math.min(host.low, z.low);
    const high = Math.max(host.high, z.high);
    const changed = low !== host.low || high !== host.high;
    host.low = low;
    host.high = high;
    host.knownAt = Math.min(host.knownAt, z.knownAt);
    if (!host.mergedFrom.includes(z.id)) host.mergedFrom.push(z.id);
    host.reactions = dedupeReactions([...host.reactions, ...z.reactions]);
    host.failedStops = Math.max(host.failedStops, z.failedStops);
    if (changed) host.version += 1;
  }
  return out;
}

function dedupeReactions(rs: Reaction[]): Reaction[] {
  const m = new Map<string, Reaction>();
  for (const r of rs) m.set(`${r.at}|${r.extreme}|${r.from}`, r);
  return [...m.values()].sort((a, b) => a.at - b.at);
}

/**
 * Record COMPLETED reactions against a zone from a closed bar series.
 *
 * A reaction is only counted once price has both touched the zone and then moved away by
 * `separation`. Requiring the move-away to have already happened is what stops a "reaction" from
 * being labelled with hindsight: at the moment of the touch nobody knows whether it will bounce.
 */
export function collectReactions(
  bars: Bar[],
  zone: { low: number; high: number },
  separation: number,
  timeframe: Timeframe,
  asOf: number,
): Reaction[] {
  const barMs = TF_MS[timeframe];
  const out: Reaction[] = [];
  let open: { from: "above" | "below"; extreme: number; startIdx: number } | null = null;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.t + barMs > asOf) break;
    const touched = b.l <= zone.high && b.h >= zone.low;

    if (touched) {
      if (open) {
        // A visit already in progress keeps the side it started on; only its extreme deepens.
        open.extreme = open.from === "above" ? Math.min(open.extreme, b.l) : Math.max(open.extreme, b.h);
      } else {
        // First bar of a visit. The bar's open says which side price arrived from; a bar that opened
        // inside the zone falls back to where it closed relative to the midpoint.
        const from: "above" | "below" =
          b.o >= zone.high ? "above" : b.o <= zone.low ? "below" : b.c >= zoneMid(zone) ? "above" : "below";
        open = { from, extreme: from === "above" ? b.l : b.h, startIdx: i };
      }
      continue;
    }

    if (open) {
      const away = open.from === "above" ? b.h - zone.high : zone.low - b.l;
      if (away >= separation) {
        out.push({ at: b.t + barMs, extreme: open.extreme, from: open.from, movedAway: away });
        open = null;
      } else if (open.from === "above" ? b.h < zone.low : b.l > zone.high) {
        // Price left through the far side: the zone did not hold, so this is not a reaction.
        open = null;
      }
    }
  }
  return out;
}

/**
 * Role transition. Support becomes resistance once a completed bar closes beyond the far edge by the
 * break buffer; the reverse for resistance. A wick through is not a transition.
 *
 * Returns a NEW zone version. The old version is kept by the caller for audit and for any trade that
 * was planned against it.
 */
export function applyRoleTransition(zone: Zone, closedBar: Bar, breakBuffer: number, barMs: number): Zone | null {
  if (zone.role === "support" && closedBar.c < zone.low - breakBuffer) {
    return { ...zone, role: "resistance", previousRole: "support", roleSince: closedBar.t + barMs, version: zone.version + 1 };
  }
  if (zone.role === "resistance" && closedBar.c > zone.high + breakBuffer) {
    return { ...zone, role: "support", previousRole: "resistance", roleSince: closedBar.t + barMs, version: zone.version + 1 };
  }
  return null;
}

/**
 * Expire zones that have gone quiet. An execution zone with no new completed reaction for
 * `executionExpiryBars` of its own timeframe stops being tradable; primary zones live longer. The
 * row is marked, never deleted, because a trade may still reference it.
 */
export function expireStaleZones(
  zones: Zone[],
  now: number,
  executionExpiryBars: number,
  primaryExpiryBars: number,
): Zone[] {
  return zones.map((z) => {
    if (z.invalidatedAt != null) return z;
    const bars = z.tier === "execution" ? executionExpiryBars : primaryExpiryBars;
    const horizon = bars * TF_MS[z.origin];
    const lastActivity = z.reactions.length ? z.reactions[z.reactions.length - 1].at : z.knownAt;
    if (now - lastActivity > horizon) {
      return { ...z, invalidatedAt: now, invalidReason: `no completed reaction for ${bars} ${z.origin} bars` };
    }
    return z;
  });
}

/** Zones usable for a decision at `asOf`: knowable, live, and not suspended by repeated failures. */
export function eligibleZones(zones: Zone[], asOf: number, maxFailedStops: number): Zone[] {
  return zones.filter((z) => z.knownAt <= asOf && z.invalidatedAt == null && z.failedStops < maxFailedStops);
}

/** Levels that can CAP a target: primary zones, validated range boundaries, and twice-reacted execution zones. */
export function targetObstacles(zones: Zone[], asOf: number, minReactions = 2): Zone[] {
  return zones.filter((z) => {
    if (z.knownAt > asOf || z.invalidatedAt != null) return false;
    if (z.tier === "primary") return true;
    if (z.provenance.kind === "range_boundary") return true;
    return z.reactions.filter((r) => r.at <= asOf).length >= minReactions;
  });
}

/**
 * The nearest obstacle in the direction of travel. A single tiny micro-pivot is not an obstacle —
 * `targetObstacles` has already filtered for that — but the zone the trade is entering FROM is also
 * excluded, otherwise every trade would cap its target on its own level.
 */
export function nearestObstacle(
  obstacles: Zone[],
  from: number,
  dir: 1 | -1,
  excludeParentIds: string[],
): { zone: Zone; price: number } | null {
  let best: { zone: Zone; price: number } | null = null;
  for (const z of obstacles) {
    if (excludeParentIds.includes(z.parentId)) continue;
    const face = dir === 1 ? z.low : z.high;
    if (dir === 1 ? face <= from : face >= from) continue;
    if (!best || (dir === 1 ? face < best.price : face > best.price)) best = { zone: z, price: face };
  }
  return best;
}
