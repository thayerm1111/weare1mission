import type { Side, Transition, VisitState } from "../core/types";

/**
 * The visit state machine.
 *
 * A level can produce many trades, but only one per ECONOMIC VISIT. A visit is keyed by
 * (cohort, parent level, direction) — deliberately by `parentId` rather than `zoneId`, so the 5m and
 * 15m copies of the same level cannot each claim a fresh visit to the same place.
 *
 *   watching -> approaching -> armed -> triggered -> consumed
 *                          -> invalidated | expired
 *   consumed -> waiting_for_departure -> watching (NEW visitId)
 *
 * Re-arming requires price to leave by the frozen `rearmDistance` and then come back on a LATER
 * event. Hovering at a level, however many ticks it generates, cannot hit the account twice.
 */

export type VisitKey = string;

export const visitKey = (cohort: string, parentId: string, side: Side): VisitKey => `${cohort}|${parentId}|${side}`;

export type VisitRecord = {
  key: VisitKey;
  visitId: string;
  state: VisitState;
  stateAt: number;
  /** Zone version this visit is bound to. A new version forces a new visit. */
  zoneVersion: number;
  /** Frozen at creation; a later config change cannot shorten the departure a live visit needs. */
  rearmDistance: number;
  /** Furthest price has travelled from the zone since the visit was consumed. */
  departedBy: number;
  /** Set when the visit produced a filled trade that then stopped out. */
  stoppedOut: boolean;
  /** Set once the account is flat and reconciled after this visit's trade. */
  flatAndReconciled: boolean;
  consumedAt: number | null;
  transitions: Transition[];
};

export type StepInput = {
  now: number;
  /** Executable price for this evaluation. */
  price: number;
  /** Distance from the zone's nearest edge; negative means inside the zone. */
  distanceToZone: number;
  /** True when the approach band test passes on this event. */
  inBand: boolean;
  /** True when every remaining condition for this family is satisfied. */
  armable: boolean;
  /** True when the setup's expiry has passed. */
  expired: boolean;
  /** Non-null when something has structurally invalidated the idea. */
  invalidReason: string | null;
  /** Current zone version; a change forces the visit to end. */
  zoneVersion: number;
  /** True when the account has no Rapid exposure from this visit and reconciliation is complete. */
  flatAndReconciled: boolean;
};

let counter = 0;
export function newVisitId(key: VisitKey, now: number): string {
  counter = (counter + 1) % 1_000_000;
  return `${key}@${now}.${counter.toString(36)}`;
}

export function startVisit(key: VisitKey, now: number, zoneVersion: number, rearmDistance: number): VisitRecord {
  return {
    key,
    visitId: newVisitId(key, now),
    state: "watching",
    stateAt: now,
    zoneVersion,
    rearmDistance,
    departedBy: 0,
    stoppedOut: false,
    flatAndReconciled: true,
    consumedAt: null,
    transitions: [],
  };
}

function move(v: VisitRecord, to: VisitState, at: number, reason: string, evidence: Record<string, number | string | boolean | null>): VisitRecord {
  if (v.state === to) return v;
  return {
    ...v,
    state: to,
    stateAt: at,
    transitions: [...v.transitions, { from: v.state, to, at, reason, evidence }],
  };
}

/**
 * Advance one visit by one market event. Pure: the caller persists whatever comes back.
 *
 * `triggered` is reported separately from the state so the caller knows THIS event is the one that
 * should produce an order intent — exactly one, for exactly this visit.
 */
export function step(v: VisitRecord, inp: StepInput): { visit: VisitRecord; triggered: boolean } {
  const ev = { price: inp.price, distance: inp.distanceToZone, zoneVersion: inp.zoneVersion };

  // A new zone version is new geometry. The old visit ends; the caller opens a fresh one.
  if (inp.zoneVersion !== v.zoneVersion && v.state !== "consumed" && v.state !== "waiting_for_departure") {
    return { visit: move(v, "invalidated", inp.now, `zone moved to version ${inp.zoneVersion}`, ev), triggered: false };
  }

  if (v.state === "consumed" || v.state === "waiting_for_departure") {
    const next = v.state === "consumed" ? move(v, "waiting_for_departure", inp.now, "trade taken; waiting for a real departure", ev) : v;
    const departed = Math.max(next.departedBy, Math.max(0, inp.distanceToZone));
    const withDeparture = { ...next, departedBy: departed, flatAndReconciled: inp.flatAndReconciled };
    // Re-arming needs BOTH a genuine departure and the account settled. A departure recorded while
    // the trade is still open is kept, but it cannot open a second entry.
    if (departed >= next.rearmDistance && inp.flatAndReconciled && inp.distanceToZone < next.rearmDistance) {
      const fresh = startVisit(v.key, inp.now, inp.zoneVersion, next.rearmDistance);
      fresh.transitions = [
        ...withDeparture.transitions,
        { from: "waiting_for_departure", to: "watching", at: inp.now, reason: `departed ${departed.toFixed(2)} >= ${next.rearmDistance.toFixed(2)} and returned`, evidence: ev },
      ];
      return { visit: fresh, triggered: false };
    }
    return { visit: withDeparture, triggered: false };
  }

  if (inp.invalidReason) return { visit: move(v, "invalidated", inp.now, inp.invalidReason, ev), triggered: false };
  if (inp.expired) return { visit: move(v, "expired", inp.now, "setup expired", ev), triggered: false };

  if (v.state === "watching") {
    if (inp.inBand) {
      const approaching = move(v, "approaching", inp.now, "entered the approach band", ev);
      if (inp.armable) {
        const armed = move(approaching, "armed", inp.now, "all conditions met", ev);
        return { visit: move(armed, "triggered", inp.now, "entry event on this quote", ev), triggered: true };
      }
      return { visit: approaching, triggered: false };
    }
    return { visit: v, triggered: false };
  }

  if (v.state === "approaching") {
    if (!inp.inBand) return { visit: move(v, "watching", inp.now, "left the approach band", ev), triggered: false };
    if (inp.armable) {
      const armed = move(v, "armed", inp.now, "all conditions met", ev);
      return { visit: move(armed, "triggered", inp.now, "entry event on this quote", ev), triggered: true };
    }
    return { visit: v, triggered: false };
  }

  if (v.state === "armed") {
    if (inp.inBand) return { visit: move(v, "triggered", inp.now, "entry event on this quote", ev), triggered: true };
    return { visit: v, triggered: false };
  }

  // triggered: waiting for the caller to report the order outcome.
  return { visit: v, triggered: false };
}

/** The caller calls this once an intent exists for the visit, so no second intent can be created. */
export function consume(v: VisitRecord, at: number, intentKey: string): VisitRecord {
  return { ...move(v, "consumed", at, "order intent created", { intentKey }), consumedAt: at, flatAndReconciled: false };
}

/**
 * A stop-out at a zone is remembered. Two of them at one zone version in a session suspends the zone
 * entirely — repeated hovering at a level that keeps failing should stop costing the account money.
 */
export function recordStopOut(v: VisitRecord): VisitRecord {
  return { ...v, stoppedOut: true };
}
