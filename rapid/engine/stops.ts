import type { Bar, Pivot, Side, Zone } from "../core/types";
import { dirOf } from "../core/types";
import { roundOutward } from "../core/decimal";
import { pivotsKnownBy } from "./structure";
import { farEdge } from "./zones";
import type { RapidConfig } from "../config/defaults";

/**
 * Structural stops.
 *
 * The invalidation point is chosen BEFORE any sizing happens, and sizing never gets to argue with it.
 * When both the zone and a swing have to survive for the idea to be alive, the FARTHER of the two is
 * the anchor. If no identifiable anchor exists the setup is skipped — an arbitrary recent extreme
 * picked to squeeze under a cap is not a stop, it is a guess wearing one.
 */

export type StopAnchor = {
  /** The raw structural price, before the buffer. */
  invalidation: number;
  /** The buffered, tick-rounded, broker-legal stop. */
  stop: number;
  distance: number;
  sources: string[];
};

export type AnchorInputs = {
  side: Side;
  /** The zone being traded, at its frozen version. */
  zone: Zone;
  /** Which side price approached the zone from. */
  from: "above" | "below";
  /** Confirmed pivots on the execution timeframe. */
  pivots: Pivot[];
  /** Closed execution bars, oldest first. */
  bars: Bar[];
  /** The moment the setup is being created. Nothing later may be read. */
  asOf: number;
  tick: number;
  stopBuffer: number;
  /** Frozen break buffer, used to decide whether a swing has been broken through. */
  breakBuffer: number;
  /** Broker's minimum stop distance from the reference price, when it reports one. */
  minStopDistance: number | null;
  /** Reference entry used to measure distance and to respect the broker minimum. */
  refEntry: number;
};

/**
 * The associated structural swing: the latest same-direction confirmed swing before the visit,
 * within `anchorLookbackBars`, with no intervening opposite qualifying break.
 */
export function associatedSwing(
  side: Side,
  pivots: Pivot[],
  bars: Bar[],
  asOf: number,
  lookbackBars: number,
  breakBuffer: number,
): { price: number; t: number } | null {
  const known = pivotsKnownBy(pivots, asOf);
  const wantLow = side === "buy";
  const cutoffIdx = Math.max(0, bars.length - lookbackBars);
  const cutoffT = bars[cutoffIdx]?.t ?? -Infinity;

  const candidates = known
    .filter((p) => (wantLow ? p.kind === "low" : p.kind === "high"))
    .filter((p) => p.t >= cutoffT)
    .sort((a, b) => b.t - a.t);

  for (const c of candidates) {
    // An opposite qualifying break between the swing and now disqualifies it.
    const intervening = bars.some((b) => {
      if (b.t <= c.t) return false;
      return wantLow ? b.c < c.price - breakBuffer : b.c > c.price + breakBuffer;
    });
    if (!intervening) return { price: c.price, t: c.t };
  }
  return null;
}

/**
 * Resolve the stop for a setup. Returns null when there is no anchor, and the caller records the
 * `no_anchor` rejection rather than substituting something convenient.
 */
export function resolveStop(inp: AnchorInputs, cfg: RapidConfig): StopAnchor | null {
  const d = dirOf(inp.side);
  const sources: string[] = [];

  // The zone must survive: the stop sits beyond its far edge.
  const zoneEdge = farEdge(inp.zone, inp.from);
  sources.push(`zone ${inp.zone.id}v${inp.zone.version} far edge ${zoneEdge.toFixed(2)}`);

  const swing = associatedSwing(
    inp.side,
    inp.pivots,
    inp.bars,
    inp.asOf,
    cfg.entry.anchorLookbackBars,
    inp.breakBuffer,
  );

  let invalidation = zoneEdge;
  if (swing) {
    sources.push(`associated ${inp.side === "buy" ? "low" : "high"} ${swing.price.toFixed(2)}`);
    // Take the farther of the two — both have to survive.
    invalidation = d === 1 ? Math.min(invalidation, swing.price) : Math.max(invalidation, swing.price);
  }

  // The buffer pushes the stop further from the entry, never closer.
  let stop = invalidation - d * inp.stopBuffer;
  stop = roundOutward(stop, inp.tick, d === 1 ? -1 : 1);

  // Respect the broker's minimum distance by widening, never by pulling the entry around.
  if (inp.minStopDistance != null && inp.minStopDistance > 0) {
    const gap = Math.abs(inp.refEntry - stop);
    if (gap < inp.minStopDistance) {
      stop = roundOutward(inp.refEntry - d * inp.minStopDistance, inp.tick, d === 1 ? -1 : 1);
      sources.push(`widened to broker minimum ${inp.minStopDistance}`);
    }
  }

  const distance = Math.abs(inp.refEntry - stop);
  if (!(distance > 0)) return null;
  return { invalidation, stop, distance, sources };
}

/**
 * The Rapid stop cap. A structurally correct stop wider than the cap does not get compressed — the
 * setup is skipped. `stopCeilingUsd` is a hard operational ceiling that configuration cannot exceed
 * without a separately reviewed strategy version.
 */
export function stopWithinCap(distance: number, cfg: RapidConfig): { ok: boolean; cap: number; reason?: string } {
  const cap = Math.min(cfg.protection.stopCapUsd, cfg.protection.stopCeilingUsd);
  if (distance > cap + 1e-9) {
    return { ok: false, cap, reason: `structural stop ${distance.toFixed(2)} exceeds the ${cap} Rapid cap` };
  }
  return { ok: true, cap };
}
