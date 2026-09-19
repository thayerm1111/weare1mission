/**
 * THE SNAPSHOT DIFFERENCE ENGINE.
 *
 * "What is true now?" is the deterministic core's job. This file answers the other half — "what changed?" —
 * and that is the half that makes an intelligence feel awake rather than merely correct.
 *
 * Every number here is a subtraction between two real snapshots. Nothing is estimated, smoothed or invented.
 * Where a horizon has no snapshot old enough to compare against, it returns nothing rather than guessing.
 */
import type { MarketSnapshot, TfState, Timeframe } from "../core/types";
import { PIP } from "../core/types";
import type { Horizon, SnapshotDiff } from "./types";
import { HORIZONS, HORIZON_MS } from "./types";

/** Bullish at the top, bearish at the bottom, so a transition has a direction we can name. */
const STATE_RANK: Record<TfState, number> = {
  strong_uptrend: 6, uptrend: 5, weak_uptrend: 4, bullish_transition: 3,
  breakout: 2, volatility_expansion: 1, range: 0, compression: 0, chaotic: 0,
  bearish_transition: -3, weak_downtrend: -4, downtrend: -5, strong_downtrend: -6,
};

const EXEC: Timeframe = "5m";

/** How far a horizon's snapshot may miss its target before it is not that horizon any more. */
const TOLERANCE = 0.6;

/**
 * Pick, for each horizon, the snapshot closest to that many milliseconds ago.
 * A horizon with nothing near enough is simply absent — an intelligence that says "15 minutes ago"
 * while comparing against a 90-second-old reading is lying with a straight face.
 */
export function pickHistory(
  now: number,
  history: MarketSnapshot[],
  horizons: Horizon[] = HORIZONS,
): { horizon: Horizon; snapshot: MarketSnapshot }[] {
  const out: { horizon: Horizon; snapshot: MarketSnapshot }[] = [];
  for (const h of horizons) {
    const target = now - HORIZON_MS[h];
    let best: MarketSnapshot | null = null;
    let bestGap = Infinity;
    for (const s of history) {
      if (s.at >= now) continue;
      const gap = Math.abs(s.at - target);
      if (gap < bestGap) { bestGap = gap; best = s; }
    }
    if (best && bestGap <= HORIZON_MS[h] * TOLERANCE) out.push({ horizon: h, snapshot: best });
  }
  return out;
}

const num = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function diffSnapshots(from: MarketSnapshot, to: MarketSnapshot, horizon: Horizon): SnapshotDiff {
  const fe = from.timeframes[EXEC];
  const te = to.timeframes[EXEC];

  const priceMove = to.price - from.price;
  const atrTo = num(te?.features.atr ?? null);
  const atrFrom = num(fe?.features.atr ?? null);

  const tfChanges: SnapshotDiff["tfChanges"] = [];
  for (const tf of Object.keys(to.timeframes) as Timeframe[]) {
    const a = from.timeframes[tf]?.state;
    const b = to.timeframes[tf]?.state;
    if (!a || !b || a === b) continue;
    const d = STATE_RANK[b] - STATE_RANK[a];
    tfChanges.push({ tf, from: a, to: b, direction: d > 0 ? "more_bullish" : d < 0 ? "more_bearish" : "sideways" });
  }

  const pFrom = from.pressure.net;
  const pTo = to.pressure.net;

  return {
    horizon,
    actualMs: to.at - from.at,
    fromAt: from.at,
    toAt: to.at,

    priceFrom: from.price,
    priceTo: to.price,
    priceMove: +priceMove.toFixed(3),
    pipsMove: Math.round(priceMove / PIP),
    moveAtr: atrTo && atrTo > 0 ? +(priceMove / atrTo).toFixed(2) : null,

    pressureFrom: pFrom,
    pressureTo: pTo,
    pressureChange: +(pTo - pFrom).toFixed(1),
    pressureFlipped: (pFrom >= 0) !== (pTo >= 0) && Math.abs(pTo - pFrom) >= 8,

    velocityFrom: num(fe?.features.velocity ?? null),
    velocityTo: num(te?.features.velocity ?? null),
    velocityChange:
      num(te?.features.velocity ?? null) != null && num(fe?.features.velocity ?? null) != null
        ? +((te!.features.velocity as number) - (fe!.features.velocity as number)).toFixed(4)
        : null,

    atrFrom,
    atrTo,
    atrRatio: atrFrom && atrFrom > 0 && atrTo != null ? +(atrTo / atrFrom).toFixed(3) : null,

    regimeFrom: from.regime,
    regimeTo: to.regime,
    regimeChanged: from.regime !== to.regime,

    sessionFrom: from.session,
    sessionTo: to.session,
    sessionChanged: from.session !== to.session,

    tfChanges,

    // Structure flags describe the CURRENT read; they matter here when they were not set before.
    brokeStructure: te?.structure.brokeStructure && !fe?.structure.brokeStructure ? te.structure.brokeStructure : null,
    failedBreak: te?.structure.failedBreak && !fe?.structure.failedBreak ? te.structure.failedBreak : null,
    reclaimed: !!te?.structure.reclaimed && !fe?.structure.reclaimed,
    positionInRangeFrom: num(fe?.structure.positionInRange ?? null),
    positionInRangeTo: num(te?.structure.positionInRange ?? null),
  };
}

/** Every horizon that has a real comparison available, newest window first. */
export function diffSet(now: MarketSnapshot, history: MarketSnapshot[]): SnapshotDiff[] {
  return pickHistory(now.at, history).map(({ horizon, snapshot }) => diffSnapshots(snapshot, now, horizon));
}

/** Convenience for the UI and for answering "what changed in the last five minutes". */
export const diffFor = (diffs: SnapshotDiff[], h: Horizon): SnapshotDiff | null => diffs.find((d) => d.horizon === h) ?? null;
