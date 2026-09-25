import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, withOverrides } from "../rapid/config/defaults";
import { decimalsOf, roundDownToStep, roundOutward, cmpAtTick, ticksBetween } from "../rapid/core/decimal";
import type { Bar, Zone } from "../rapid/core/types";
import { aggregate, atr, bodyRatio, closePosition, closedBars, mergeBars } from "../rapid/market/bars";
import { GOLD_SESSION, isSessionOpen, sessionState, splitSessionDays, tradingDay, tradingWeek } from "../rapid/market/session";
import { QuoteStream, BasisTracker } from "../rapid/market/quotes";
import { classifyRegime, findPivots, pivotsKnownBy, protectedSwing } from "../rapid/engine/structure";
import { collectReactions, eligibleZones, expireStaleZones, makeZone, mergeZones, nearestObstacle, targetObstacles, zoneFromPivot } from "../rapid/engine/zones";
import { validateRange } from "../rapid/engine/range";
import { freezeTolerances, requiredStopBuffer } from "../rapid/engine/tolerances";
import { associatedSwing, resolveStop, stopWithinCap } from "../rapid/engine/stops";
import { buildCostModel, costRatio, netRewardRisk, planTarget } from "../rapid/engine/targets";
import { approachBand, findBreak, gappedThrough } from "../rapid/engine/setups";
import { consume, startVisit, step, visitKey } from "../rapid/engine/visits";
import { arbitrate } from "../rapid/engine/arbitration";
import { breakevenStop, breakevenTrigger, changeOfCharacter, nextAction, tightenedStop, type ManagedTrade } from "../rapid/engine/manage";
import { reconcileExposure, sizePosition, valuePerPricePerLot } from "../rapid/risk/sizing";

const TICK = 0.01;
const M5 = 300_000;
const T0 = Date.UTC(2026, 8, 21, 14, 0, 0); // Monday 21 Sep 2026, 10:00 New York — market open

const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c });
/** A series of M5 bars from [o,h,l,c] tuples starting at T0. */
const series = (rows: Array<[number, number, number, number]>, start = T0): Bar[] =>
  rows.map((r, i) => bar(start + i * M5, r[0], r[1], r[2], r[3]));

// =================================================================================================
test("decimal: step arithmetic never lets float noise decide a comparison", () => {
  assert.equal(decimalsOf(0.01), 2);
  assert.equal(decimalsOf(0.001), 3);
  assert.equal(decimalsOf(0.05), 2);
  assert.equal(roundDownToStep(0.298, 0.01), 0.29, "a genuine remainder is truncated");
  assert.equal(roundDownToStep(0.3, 0.01), 0.3, "an exact multiple stays put");
  assert.equal(roundDownToStep(0.1 + 0.2, 0.01), 0.3, "0.1+0.2 noise must not round 0.30 down to 0.29");
  assert.equal(roundDownToStep(0.29999999999, 0.01), 0.3, "sub-nano noise resolves to the step it is really on");
  assert.equal(cmpAtTick(4316.001, 4316.004, 0.01), 0, "sub-tick differences are not differences");
  assert.equal(ticksBetween(4316.0, 4316.1, 0.01), 10);
});

test("decimal: protective rounding always moves AWAY from the entry", () => {
  // A long's stop rounds down (further away), a short's stop rounds up.
  assert.equal(roundOutward(4315.234, 0.01, -1), 4315.23);
  assert.equal(roundOutward(4315.236, 0.01, -1), 4315.23);
  assert.equal(roundOutward(4315.234, 0.01, 1), 4315.24);
});

// =================================================================================================
test("bars: a forming bucket is never returned as closed", () => {
  const m1: Bar[] = [];
  for (let i = 0; i < 7; i++) m1.push(bar(T0 + i * 60_000, 100, 101, 99, 100));
  // 7 one-minute bars = one complete 5m bucket plus 2 minutes of the next.
  const closed = aggregate(m1, 5, true, T0 + 7 * 60_000);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].t, T0);
  const all = aggregate(m1, 5, false);
  assert.equal(all.length, 2);
});

test("bars: a corrected historical bar is reported, not silently swallowed", () => {
  const a = series([[100, 101, 99, 100], [100, 102, 99, 101]]);
  const fix = [bar(T0 + M5, 100, 105, 99, 104)];
  const r = mergeBars(a, fix);
  assert.equal(r.corrected.length, 1);
  assert.equal(r.added, 0);
  assert.equal(r.bars[1].h, 105);
});

test("bars: ATR is null until there is enough history, and body/close ratios survive a doji", () => {
  const short = series([[100, 101, 99, 100], [100, 101, 99, 100]]);
  assert.equal(atr(short, 14), null);
  const flat = bar(T0, 100, 100, 100, 100);
  assert.equal(bodyRatio(flat), 0);
  assert.equal(closePosition(flat), 0.5, "a zero-range bar must not score as a strong close");
  const strong = bar(T0, 100, 110, 99, 109.5);
  assert.ok(bodyRatio(strong) > 0.8);
  assert.ok(closePosition(strong) > 0.9);
  assert.equal(closedBars(series([[1, 1, 1, 1], [1, 1, 1, 1]]), M5, T0 + M5).length, 1);
});

// =================================================================================================
test("session: the trading day rolls at 17:00 New York, not at UTC midnight", () => {
  const before = Date.UTC(2026, 8, 21, 20, 30); // 16:30 NY Monday
  const after = Date.UTC(2026, 8, 21, 21, 30); // 17:30 NY Monday
  assert.equal(tradingDay(before, GOLD_SESSION), "2026-09-21");
  assert.equal(tradingDay(after, GOLD_SESSION), "2026-09-22", "after the rollover the bar belongs to the next session day");
});

test("session: DST is handled because the rollover is expressed in local time", () => {
  // 1 Feb 2026 is EST (UTC-5): 17:00 NY = 22:00 UTC. 1 Jul 2026 is EDT (UTC-4): 17:00 NY = 21:00 UTC.
  assert.equal(tradingDay(Date.UTC(2026, 1, 2, 21, 59), GOLD_SESSION), "2026-02-02");
  assert.equal(tradingDay(Date.UTC(2026, 1, 2, 22, 1), GOLD_SESSION), "2026-02-03");
  assert.equal(tradingDay(Date.UTC(2026, 6, 2, 20, 59), GOLD_SESSION), "2026-07-02");
  assert.equal(tradingDay(Date.UTC(2026, 6, 2, 21, 1), GOLD_SESSION), "2026-07-03");
});

test("session: weekend, daily maintenance break and open are distinguished", () => {
  assert.equal(sessionState(Date.UTC(2026, 8, 19, 22, 0), GOLD_SESSION).reason, "weekend"); // Sat
  assert.equal(sessionState(Date.UTC(2026, 8, 21, 21, 30), GOLD_SESSION).reason, "daily_break"); // 17:30 NY
  assert.ok(isSessionOpen(Date.UTC(2026, 8, 21, 14, 0), GOLD_SESSION));
  assert.equal(tradingWeek(Date.UTC(2026, 8, 21, 14, 0), GOLD_SESSION).startsWith("2026-W"), true);
});

test("session: the developing day is never returned as a completed day", () => {
  const bars = [
    bar(Date.UTC(2026, 8, 21, 14, 0), 1, 1, 1, 1), // Mon, session day 2026-09-21
    bar(Date.UTC(2026, 8, 21, 22, 0), 1, 1, 1, 1), // after rollover, session day 2026-09-22
  ];
  const { completed, developing } = splitSessionDays(bars, Date.UTC(2026, 8, 21, 23, 0), GOLD_SESSION);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].day, "2026-09-21");
  assert.equal(developing?.day, "2026-09-22");
});

// =================================================================================================
test("quotes: two different quotes sharing a timestamp are both kept; exact duplicates are not", () => {
  const s = new QuoteStream("broker", 5000);
  const base = { source: "broker" as const, providerTs: null, providerTsPrecision: "none" as const, seq: null };
  assert.equal(s.accept({ ...base, bid: 4316.0, ask: 4316.2, receivedAt: 1000 }).status, "accepted");
  assert.equal(s.accept({ ...base, bid: 4316.1, ask: 4316.3, receivedAt: 1000 }).status, "accepted", "same timestamp, different prices: a real tick");
  assert.equal(s.accept({ ...base, bid: 4316.1, ask: 4316.3, receivedAt: 1000 }).status, "duplicate");
});

test("quotes: a crossed book is rejected and a late event cannot become the current quote", () => {
  const s = new QuoteStream("broker", 1000);
  const q = (bid: number, ask: number, ts: number, seq: string) => ({ source: "broker" as const, bid, ask, providerTs: ts, providerTsPrecision: "ms" as const, receivedAt: ts, seq });
  assert.equal(s.accept(q(4316.3, 4316.1, 1000, "a")).status, "invalid");
  assert.equal(s.accept(q(4316.0, 4316.2, 10_000, "b")).status, "accepted");
  assert.equal(s.accept(q(4300.0, 4300.2, 5_000, "c")).status, "late");
  assert.equal(s.current()?.bid, 4316.0, "the late event must not replace the current quote");
});

test("quotes: basis is only measurable with aligned samples and reports its own uncertainty", () => {
  const b = new BasisTracker();
  assert.equal(b.state(), null);
  assert.equal(b.add(4316.5, 4316.0, 1000, 9000), false, "misaligned samples are refused");
  for (let i = 0; i < 25; i++) b.add(4316.5 + (i % 2) * 0.02, 4316.0, 1000 + i, 1000 + i);
  const st = b.state();
  assert.ok(st && Math.abs(st.median - 0.5) < 0.05);
  assert.ok(b.translate(4300) != null);
});

// =================================================================================================
test("structure: a pivot is not knowable until its right-hand confirmation closes", () => {
  const bars = series([
    [100, 101, 99, 100],
    [100, 102, 99, 101],
    [101, 110, 100, 109], // the swing high, index 2
    [109, 108, 105, 106],
    [106, 107, 104, 105],
    [105, 106, 103, 104],
  ]);
  const pivots = findPivots(bars, "M5", 2, 2);
  const high = pivots.find((p) => p.kind === "high" && p.barIndex === 2);
  assert.ok(high, "the swing high must be found");
  assert.equal(high!.t, T0 + 2 * M5, "it is DRAWN at its own bar");
  assert.equal(high!.knownAt, T0 + 4 * M5 + M5, "it is KNOWABLE only when the second right-hand bar closes");
  assert.equal(pivotsKnownBy(pivots, high!.knownAt - 1).some((p) => p.barIndex === 2), false);
  assert.equal(pivotsKnownBy(pivots, high!.knownAt).some((p) => p.barIndex === 2), true);
});

test("structure: a plateau of equal highs produces exactly one pivot, deterministically the first", () => {
  const bars = series([
    [100, 101, 99, 100],
    [100, 102, 99, 101],
    [101, 110, 100, 109], // plateau member 1
    [109, 110, 105, 106], // plateau member 2, equal high
    [106, 107, 104, 105],
    [105, 106, 103, 104],
    [104, 105, 102, 103],
  ]);
  const highs = findPivots(bars, "M5", 2, 2).filter((p) => p.kind === "high");
  assert.equal(highs.length, 1, "one plateau, one pivot");
  assert.equal(highs[0].barIndex, 2, "the leftmost member wins");
});

test("structure: regime needs two confirmed swings per side and absorbs one-tick noise", () => {
  const empty = classifyRegime([], [], T0, { atrPeriod: 14, noiseTicks: 2, noiseAtrMult: 0.1, tickSize: TICK, minSwingsPerSide: 2 });
  assert.equal(empty.regime, "unknown");

  const up: Bar[] = [];
  let p = 4300;
  for (let i = 0; i < 40; i++) {
    const swingUp = i % 4 < 2;
    p += swingUp ? 3 : -1.5;
    up.push(bar(T0 + i * M5, p, p + 1, p - 1, p));
  }
  const piv = findPivots(up, "M5", 2, 2);
  const r = classifyRegime(up, piv, T0 + 100 * M5, { atrPeriod: 14, noiseTicks: 2, noiseAtrMult: 0.1, tickSize: TICK, minSwingsPerSide: 2 });
  assert.equal(r.regime, "up", `expected an uptrend, got ${r.regime} (${r.reason})`);
  assert.ok(r.tolerance > 0);
});

// =================================================================================================
test("zones: geometry preserves a broad wick rather than narrowing it to buy a smaller stop", () => {
  const wick = bar(T0, 4340, 4348, 4339, 4341); // long upper wick
  const z = zoneFromPivot(wick, "high", TICK, 2);
  assert.equal(z.low, 4341, "body top");
  assert.equal(z.high, 4348, "the full wick is kept");
  const doji = bar(T0, 4340, 4340, 4340, 4340);
  const dz = zoneFromPivot(doji, "high", TICK, 2);
  assert.ok(dz.high - dz.low >= 2 * TICK, "a zero-width zone is widened to the minimum");
});

const mkZone = (id: string, role: Zone["role"], low: number, high: number, origin: Zone["origin"] = "M5", tier: Zone["tier"] = "execution", knownAt = T0): Zone =>
  makeZone({ role, low, high, origin, provenance: { kind: "swing", timeframe: origin, pivotT: knownAt }, knownAt, tier }, id, id, T0);

test("zones: a cross-timeframe copy of one level cannot present itself as a separate location", () => {
  const a = mkZone("a", "support", 4315.0, 4316.0, "M5");
  const b = mkZone("b", "support", 4315.5, 4316.5, "M15");
  const merged = mergeZones([a, b], { M5: 1.0, M15: 1.5 }, 0.15);
  assert.equal(merged.length, 1, "overlapping same-role zones become one");
  assert.equal(merged[0].id, "a", "the oldest id survives so visit history is not reset");
  assert.equal(merged[0].low, 4315.0);
  assert.equal(merged[0].high, 4316.5, "the union, never a narrowing");
  assert.equal(merged[0].version, 2, "changed bounds mean a new version");
});

test("zones: a reaction is only counted once price has genuinely moved away", () => {
  const zone = { low: 4315, high: 4316 };
  // Touch, then drift 0.5 away — not enough. Then touch again and move 4 away.
  const bars = series([
    [4320, 4321, 4316, 4316.5],
    [4316.5, 4316.6, 4315.2, 4315.5], // inside the zone
    [4315.5, 4316.4, 4315.4, 4316.3], // barely away
    [4316.3, 4316.5, 4315.1, 4315.4], // back inside
    [4315.4, 4320.5, 4315.4, 4320.2], // decisively away
    [4320.2, 4321, 4319, 4320],
  ]);
  const rs = collectReactions(bars, zone, 2.0, "M5", T0 + 10 * M5);
  assert.equal(rs.length, 1, "one completed reaction, not two");
  assert.ok(rs[0].movedAway >= 2.0);
});

test("zones: stale execution zones expire, and suspended zones stop being eligible", () => {
  const z = mkZone("z", "support", 4315, 4316);
  const later = T0 + 200 * M5;
  const aged = expireStaleZones([z], later, 96, 240);
  assert.ok(aged[0].invalidatedAt != null);
  assert.equal(eligibleZones(aged, later, 2).length, 0);

  const suspended = { ...mkZone("s", "support", 4315, 4316), failedStops: 2 };
  assert.equal(eligibleZones([suspended], T0 + M5, 2).length, 0, "two failed stops suspends the zone");
  assert.equal(eligibleZones([{ ...suspended, failedStops: 1 }], T0 + M5, 2).length, 1);
});

test("zones: a single micro pivot is not a target obstacle, but a twice-reacted zone is", () => {
  const micro = mkZone("micro", "resistance", 4320, 4320.1);
  const real = { ...mkZone("real", "resistance", 4325, 4326), reactions: [
    { at: T0, extreme: 4325.5, from: "below" as const, movedAway: 3 },
    { at: T0 + M5, extreme: 4325.6, from: "below" as const, movedAway: 3 },
  ] };
  const primary = mkZone("h1", "resistance", 4330, 4331, "H1", "primary");
  const obstacles = targetObstacles([micro, real, primary], T0 + 10 * M5);
  assert.deepEqual(obstacles.map((z) => z.id).sort(), ["h1", "real"]);

  const nearest = nearestObstacle(obstacles, 4316, 1, []);
  assert.equal(nearest?.zone.id, "real");
  assert.equal(nearestObstacle(obstacles, 4316, 1, ["real"])?.zone.id, "h1", "the zone being traded from is excluded");
});

// =================================================================================================
test("range: validation refuses a pair without two completed reactions at each boundary", () => {
  const lower = mkZone("lo", "support", 4310, 4311);
  const upper = mkZone("hi", "resistance", 4325, 4326);
  const rows: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 60; i++) rows.push([4318, 4319, 4317, 4318]); // no touches at all
  const flat = series(rows);
  const r = validateRange(flat, [lower, upper], "M5", T0 + 200 * M5, 1.0, DEFAULT_CONFIG);
  assert.equal(r.range, null);
  assert.match(r.reason, /reactions|enclose/);
});

test("range: a valid oscillation validates, and a completed close beyond a boundary breaks it", () => {
  const lower = mkZone("lo", "support", 4310, 4311);
  const upper = mkZone("hi", "resistance", 4325, 4326);
  const rows: Array<[number, number, number, number]> = [];
  // Four clean traverses: touch support, run to resistance, touch it, come back.
  for (let cycle = 0; cycle < 4; cycle++) {
    rows.push([4315, 4315, 4310.5, 4311.5]); // into support
    rows.push([4311.5, 4318, 4311.5, 4317.5]); // away
    rows.push([4317.5, 4322, 4317, 4321]);
    rows.push([4321, 4325.5, 4321, 4325.2]); // into resistance
    rows.push([4325.2, 4325.2, 4319, 4319.5]); // away
    rows.push([4319.5, 4320, 4315, 4315.5]);
  }
  while (rows.length < 50) rows.push([4318, 4319, 4317, 4318]);
  const bars = series(rows);
  const asOf = T0 + (rows.length + 2) * M5;
  const r = validateRange(bars, [lower, upper], "M5", asOf, 1.0, DEFAULT_CONFIG);
  assert.ok(r.range, `expected a validated range: ${r.reason}`);
  assert.ok(r.range!.room >= DEFAULT_CONFIG.target.minUsd);
  assert.ok(r.range!.upperTouches >= 2 && r.range!.lowerTouches >= 2);

  // Now break it with a completed close above the upper far edge.
  const broken = [...bars, bar(T0 + rows.length * M5, 4325, 4332, 4325, 4331)];
  const r2 = validateRange(broken, [lower, upper], "M5", asOf + 2 * M5, 1.0, DEFAULT_CONFIG);
  assert.equal(r2.range, null, "a completed close outside the range invalidates it");
});

// =================================================================================================
test("tolerances: frozen at creation, and a widened spread demands a WIDER stop buffer", () => {
  const t = freezeTolerances(2.0, 0.3, TICK, DEFAULT_CONFIG);
  assert.equal(t.touchTolerance, Math.min(1.0, Math.max(0.25, 0.2, 0.02)));
  assert.equal(t.breakBuffer, Math.max(0.15, 0.2, 0.02));
  assert.equal(t.rearmDistance, Math.max(2.0, 1.0));
  const wider = requiredStopBuffer(2.0, 1.2, TICK, DEFAULT_CONFIG);
  assert.ok(wider > t.stopBuffer, "a wider spread must push the stop out, never shrink it");
});

// =================================================================================================
test("stops: the farther of zone edge and associated swing is the anchor, and the cap skips rather than compresses", () => {
  const bars = series([
    [4320, 4321, 4319, 4320],
    [4320, 4321, 4319, 4320],
    [4320, 4321, 4310, 4318], // the swing low at 4310
    [4318, 4319, 4317, 4318],
    [4318, 4322, 4317, 4321],
    [4321, 4323, 4320, 4322],
  ]);
  const pivots = findPivots(bars, "M5", 2, 2);
  const zone = mkZone("z", "support", 4314, 4315);
  const anchor = resolveStop(
    { side: "buy", zone, from: "above", pivots, bars, asOf: T0 + 10 * M5, tick: TICK, stopBuffer: 0.2, breakBuffer: 0.15, minStopDistance: null, refEntry: 4315 },
    DEFAULT_CONFIG,
  );
  assert.ok(anchor);
  assert.ok(anchor!.stop < 4310, `stop ${anchor!.stop} must sit beyond the 4310 swing, not just the 4314 zone edge`);

  assert.equal(stopWithinCap(9.9, DEFAULT_CONFIG).ok, true);
  const tooWide = stopWithinCap(12, DEFAULT_CONFIG);
  assert.equal(tooWide.ok, false);
  assert.match(tooWide.reason!, /exceeds the 10 Rapid cap/);
  // Configuration cannot raise the cap above the hard ceiling.
  const reckless = withOverrides(DEFAULT_CONFIG, "reckless", { protection: { stopCapUsd: 40 } });
  assert.equal(stopWithinCap(20, reckless).ok, false, "the hard 15 ceiling still applies");
  assert.equal(stopWithinCap(14, reckless).ok, true);
});

test("stops: an intervening opposite break disqualifies a swing anchor", () => {
  const bars = series([
    [4320, 4321, 4319, 4320],
    [4320, 4321, 4319, 4320],
    [4320, 4321, 4310, 4318],
    [4318, 4319, 4317, 4318],
    [4318, 4319, 4300, 4301], // closed well below the 4310 swing
    [4301, 4303, 4300, 4302],
  ]);
  const pivots = findPivots(bars, "M5", 2, 2);
  const a = associatedSwing("buy", pivots, bars, T0 + 10 * M5, 12, 0.15);
  assert.ok(a == null || a.price !== 4310, "a swing price has already been broken through cannot anchor the stop");
});

// =================================================================================================
test("targets: never reaches through nearer opposition, and a 7-dollar target has no 10-dollar partial", () => {
  const obstacle = { ...mkZone("op", "resistance", 4323, 4324), reactions: [
    { at: T0, extreme: 4323.5, from: "below" as const, movedAway: 3 },
    { at: T0 + M5, extreme: 4323.4, from: "below" as const, movedAway: 3 },
  ] };
  const { plan } = planTarget("buy", 4316, targetObstacles([obstacle], T0 + 5 * M5), [], 0.2, TICK, DEFAULT_CONFIG);
  assert.ok(plan);
  assert.ok(plan!.target < 4323, "the target stops in front of the obstacle");
  assert.ok(plan!.distance >= 5 && plan!.distance <= 7);
  assert.deepEqual(plan!.markers, [5], "no 10-dollar marker is promised on a 7-dollar target");

  const tooClose = planTarget("buy", 4320, targetObstacles([obstacle], T0 + 5 * M5), [], 0.2, TICK, DEFAULT_CONFIG);
  assert.equal(tooClose.plan, null);
  assert.match(tooClose.reason, /room/);

  const open = planTarget("buy", 4316, [], [], 0.2, TICK, DEFAULT_CONFIG);
  assert.equal(open.plan!.distance, 15, "with no known obstacle the product maximum is used, not infinity");
  assert.deepEqual(open.plan!.markers, [5, 10]);
});

test("targets: the spread is charged once, not twice, and the cost filter bites", () => {
  const costs = buildCostModel(0.3, TICK, 100, DEFAULT_CONFIG);
  // entry 4316, stop 4311 (5 risk), target 4326 (10 reward). Extra = 0.1 + 0.1 + 0 = 0.2
  const rr = netRewardRisk("buy", 4316, 4311, 4326, costs);
  assert.ok(Math.abs(rr - (10 - 0.2) / (5 + 0.2)) < 1e-9, "the spread is already inside the prices");
  assert.ok(costRatio(10, costs) < 0.15);
  assert.ok(costRatio(2, costs) > 0.15, "a small target cannot carry the costs");
});

// =================================================================================================
test("setups: a gap clean through the zone is not a touch", () => {
  const zone = { low: 4315, high: 4316 };
  assert.equal(gappedThrough("buy", 4315.5, zone, "above", 0.5), false, "inside the zone is a touch");
  assert.equal(gappedThrough("buy", 4314.7, zone, "above", 0.5), false, "just below, within tolerance");
  assert.equal(gappedThrough("buy", 4310, zone, "above", 0.5), true, "a hole, not a touch");
  const band = approachBand(zone, "above", 0.5);
  assert.equal(band.low, 4314.5);
  assert.equal(band.high, 4316.5);
});

test("setups: the breakout and its retest can never come from the same candle", () => {
  const zone = mkZone("r", "resistance", 4320, 4321);
  const bars = series([
    [4315, 4316, 4314, 4315],
    [4315, 4316, 4314, 4315],
    [4315, 4325, 4315, 4324.5], // the breakout close
  ]);
  const closeTime = T0 + 2 * M5 + M5;
  assert.equal(findBreak(bars, zone, "buy", 0.15, "M5", DEFAULT_CONFIG, closeTime - 1), null, "not knowable before the candle closes");
  const ev = findBreak(bars, zone, "buy", 0.15, "M5", DEFAULT_CONFIG, closeTime);
  assert.ok(ev, "knowable the moment it closes");
  assert.equal(ev!.closedAt, closeTime);
  assert.ok(ev!.bodyRatio >= 0.55);
});

test("setups: a wick through a level is not a break", () => {
  const zone = mkZone("r", "resistance", 4320, 4321);
  const wickOnly = series([
    [4315, 4316, 4314, 4315],
    [4315, 4316, 4314, 4315],
    [4315, 4326, 4314, 4316], // spiked through, closed back inside
  ]);
  assert.equal(findBreak(wickOnly, zone, "buy", 0.15, "M5", DEFAULT_CONFIG, T0 + 4 * M5), null);
});

// =================================================================================================
test("visits: hovering at a level cannot produce a second order", () => {
  const key = visitKey("broker:acct1", "zoneA", "buy");
  let v = startVisit(key, T0, 1, 2.0);
  const base = { zoneVersion: 1, expired: false, invalidReason: null, flatAndReconciled: true };

  let r = step(v, { ...base, now: T0, price: 4316, distanceToZone: 0.1, inBand: true, armable: true });
  assert.equal(r.triggered, true);
  v = consume(r.visit, T0, "intent-1");
  assert.equal(v.state, "consumed");

  // Twenty more ticks right at the level.
  for (let i = 1; i <= 20; i++) {
    r = step(v, { ...base, now: T0 + i * 1000, price: 4316, distanceToZone: 0.1, inBand: true, armable: true, flatAndReconciled: false });
    v = r.visit;
    assert.equal(r.triggered, false, `tick ${i} must not trigger again`);
  }
  assert.equal(v.state, "waiting_for_departure");
});

test("visits: a genuine departure and return opens a NEW visit with a new id", () => {
  const key = visitKey("broker:acct1", "zoneA", "buy");
  let v = consume(step(startVisit(key, T0, 1, 2.0), { now: T0, price: 4316, distanceToZone: 0, inBand: true, armable: true, expired: false, invalidReason: null, zoneVersion: 1, flatAndReconciled: true }).visit, T0, "i1");
  const firstId = v.visitId;

  v = step(v, { now: T0 + 1000, price: 4319, distanceToZone: 3.0, inBand: false, armable: false, expired: false, invalidReason: null, zoneVersion: 1, flatAndReconciled: false }).visit;
  assert.equal(v.visitId, firstId, "a departure while the trade is open does not re-arm");

  v = step(v, { now: T0 + 2000, price: 4316.2, distanceToZone: 0.2, inBand: true, armable: true, expired: false, invalidReason: null, zoneVersion: 1, flatAndReconciled: true }).visit;
  assert.notEqual(v.visitId, firstId, "flat, reconciled, departed and returned: a new visit");
  assert.equal(v.state, "watching");
});

test("visits: a new zone version ends the visit rather than inheriting its state", () => {
  const key = visitKey("c", "zoneA", "buy");
  const v = startVisit(key, T0, 1, 2.0);
  const r = step(v, { now: T0 + 1000, price: 4316, distanceToZone: 0, inBand: true, armable: true, expired: false, invalidReason: null, zoneVersion: 2, flatAndReconciled: true });
  assert.equal(r.visit.state, "invalidated");
  assert.equal(r.triggered, false);
});

test("visits: an expired setup cannot execute", () => {
  const v = startVisit(visitKey("c", "z", "buy"), T0, 1, 2.0);
  const r = step(v, { now: T0 + 1000, price: 4316, distanceToZone: 0, inBand: true, armable: true, expired: true, invalidReason: null, zoneVersion: 1, flatAndReconciled: true });
  assert.equal(r.triggered, false);
  assert.equal(r.visit.state, "expired");
});

// =================================================================================================
const fakeSetup = (over: Partial<import("../rapid/core/types").Setup>): import("../rapid/core/types").Setup => ({
  setupId: "s1", visitId: "v1", strategyVersion: "matty_rapid_v1", configVersion: "c", family: "range_reaction",
  side: "buy", state: "watching", timeframe: "M5", zoneId: "z", zoneVersion: 1, parentId: "p", createdAt: T0,
  stateAt: T0, expiresAt: T0 + M5, tolerances: { atrEntry: 1, touchTolerance: 0.3, breakBuffer: 0.15, stopBuffer: 0.2, rearmDistance: 2, spreadAtFreeze: 0.2 },
  entryBandLow: 4315, entryBandHigh: 4316, invalidation: 4314, stop: 4313, opposingLevelId: null, opposingPrice: null,
  refEntry: 4316, target: 4326, targetUsd: 10, stopUsd: 3, transitions: [], conditionsMet: [], conditionsPending: [],
  breakEvidence: null, ...over,
});

test("arbitration: the same level on 5m and 15m yields ONE setup", () => {
  const a = fakeSetup({ setupId: "a", timeframe: "M5", parentId: "level-1" });
  const b = fakeSetup({ setupId: "b", timeframe: "M15", parentId: "level-1" });
  const r = arbitrate([a, b], "unknown");
  assert.equal(r.selected.length, 1);
  assert.equal(r.selected[0].setupId, "b", "the higher source timeframe wins on structure quality");
  assert.equal(r.dropped.length, 1);
});

test("arbitration: a break/retest outranks a conflicting range fade, and no account ever holds both sides", () => {
  const fade = fakeSetup({ setupId: "fade", family: "range_reaction", side: "sell", parentId: "lvl-a" });
  const retest = fakeSetup({ setupId: "retest", family: "break_retest", side: "buy", parentId: "lvl-b" });
  const r = arbitrate([fade, retest], "unknown");
  assert.equal(r.selected.length, 1);
  assert.equal(r.selected[0].setupId, "retest");
  assert.match(r.dropped[0].reason, /one instrument cannot hold both sides/);
});

test("arbitration: the daily bias breaks ties but cannot create or veto a setup on its own", () => {
  const long = fakeSetup({ setupId: "long", side: "buy", parentId: "a" });
  const short = fakeSetup({ setupId: "short", side: "sell", parentId: "b" });
  assert.equal(arbitrate([long, short], "down").selected[0].setupId, "short");
  assert.equal(arbitrate([long, short], "up").selected[0].setupId, "long");
  // With no other candidate, a counter-daily setup still survives.
  assert.equal(arbitrate([long], "down").selected.length, 1);
});

// =================================================================================================
const trade = (over: Partial<ManagedTrade> = {}): ManagedTrade => ({
  side: "buy", entry: 4316, initialStop: 4310, currentStop: 4310, target: 4331, originalQty: 0.1, currentQty: 0.1,
  atrAtFill: 2, costPrice: 0.05, breakevenDone: false, partialDone: false, managementVersion: "m", protectedSwing: null, ...over,
});

test("management: the breakeven trigger is the largest of its three terms and sits above net cost", () => {
  const t = trade(); // D_stop = 6, ATR 2
  assert.equal(breakevenTrigger(t, DEFAULT_CONFIG), 3, "max(3, 0.5*6=3, 0.35*2=0.7)");
  const wide = trade({ initialStop: 4306 }); // D_stop = 10
  assert.equal(breakevenTrigger(wide, DEFAULT_CONFIG), 5);
  assert.ok(breakevenStop(t, TICK) > t.entry, "net breakeven is above the entry by the cost allowance");
});

test("management: protection only ever tightens and never sits through the market", () => {
  assert.equal(tightenedStop("buy", 4310, 4308, 4320, 4320.2, TICK, 0.1), null, "a looser stop is refused");
  assert.equal(tightenedStop("buy", 4310, 4316, 4320, 4320.2, TICK, 0.1), 4316);
  const clamped = tightenedStop("buy", 4310, 4319.9, 4320, 4320.2, TICK, 0.5);
  assert.ok(clamped != null && clamped <= 4319.5, "clamped to the broker's minimum distance");
  assert.equal(tightenedStop("sell", 4320, 4322, 4310, 4310.2, TICK, 0.1), null);
});

test("management: an ordinary pullback below the entry line is NOT a change of character", () => {
  // The case from the teaching examples: price dips under the entry but stays above the structure.
  const bars = series([
    [4320, 4321, 4319, 4320],
    [4320, 4320.5, 4315.5, 4315.8], // dipped below the 4316 entry, closed above the 4314 protected low
  ]);
  const t = trade({ protectedSwing: 4314 });
  const coc = changeOfCharacter(t, bars, [], T0 + 5 * M5, DEFAULT_CONFIG);
  assert.equal(coc.exit, false, coc.reason);

  const broken = [...bars, bar(T0 + 2 * M5, 4315.8, 4315.9, 4312, 4312.2)];
  const coc2 = changeOfCharacter(t, broken, [], T0 + 5 * M5, DEFAULT_CONFIG);
  assert.equal(coc2.exit, true, "a decisive close below the protected low does qualify");
});

test("management: a single opposite-colour candle with a small body does not exit", () => {
  const t = trade({ protectedSwing: 4314 });
  const weak = series([[4316, 4320, 4310.5, 4315.9]]); // closes below 4314? no — closes 4315.9
  assert.equal(changeOfCharacter(t, weak, [], T0 + M5, DEFAULT_CONFIG).exit, false);
  const smallBody = series([[4313.9, 4314.0, 4312.0, 4313.8]]); // below the swing, but body is tiny
  assert.equal(changeOfCharacter(t, smallBody, [], T0 + M5, DEFAULT_CONFIG).exit, false, "a 10% body is not a change of character");
});

test("management: the partial is skipped when the target is not strictly beyond it", () => {
  const sevenDollar = trade({ target: 4323 }); // 7 away
  const a = nextAction(sevenDollar, 4326.5, [], [], T0, TICK, 0.1, 4326.4, 4326.6, DEFAULT_CONFIG);
  assert.notEqual(a.kind, "partial", "a 7-dollar trade must not promise a 10-dollar partial");

  const fifteen = trade({ target: 4331, breakevenDone: true });
  const b = nextAction(fifteen, 4326.5, [], [], T0, TICK, 0.1, 4326.4, 4326.6, DEFAULT_CONFIG);
  assert.equal(b.kind, "partial");
  assert.ok(Math.abs((b as { qty: number }).qty - 0.05) < 1e-9);
});

// =================================================================================================
const spec = (over: Partial<import("../rapid/core/types").InstrumentSpec> = {}): import("../rapid/core/types").InstrumentSpec => ({
  tradableInstrumentId: "1", tradeRouteId: "t", infoRouteId: "i", brokerSymbol: "XAUUSD", contractSize: 100,
  lotStep: 0.01, minLot: 0.01, maxLot: 50, tickSize: 0.01, tickValue: 1, priceDecimals: 2, currency: "USD",
  minStopDistance: null, raw: null, ...over,
});

test("sizing: missing instrument metadata BLOCKS the trade instead of assuming gold is 100 ounces", () => {
  const r = sizePosition({ side: "buy", executable: 4316, stop: 4310, equity: 10_000, riskPct: 0.5, spec: spec({ contractSize: null, tickValue: null }), conversionRate: 1, cfg: DEFAULT_CONFIG });
  assert.equal(r.ok, false);
  const r2 = sizePosition({ side: "buy", executable: 4316, stop: 4310, equity: 10_000, riskPct: 0.5, spec: spec({ lotStep: null }), conversionRate: 1, cfg: DEFAULT_CONFIG });
  assert.equal(r2.ok, false);
  const r3 = sizePosition({ side: "buy", executable: 4316, stop: 4310, equity: 10_000, riskPct: 0.5, spec: spec(), conversionRate: null, cfg: DEFAULT_CONFIG });
  assert.equal(r3.ok, false, "no conversion rate means the risk is unknown");
});

test("sizing: tickValue is preferred over contractSize, and non-USD accounts convert", () => {
  const byTick = valuePerPricePerLot(spec({ tickValue: 1, tickSize: 0.01 }), 1);
  assert.equal(byTick?.value, 100);
  const byContract = valuePerPricePerLot(spec({ tickValue: null }), 1);
  assert.equal(byContract?.value, 100);
  const eur = valuePerPricePerLot(spec(), 0.9);
  assert.equal(eur?.value, 90, "converted into the account currency");
});

test("sizing: slippage allowances reduce the SIZE, never the stop, and the budget is respected", () => {
  const r = sizePosition({ side: "buy", executable: 4316, stop: 4310, equity: 10_000, riskPct: 0.5, spec: spec(), conversionRate: 1, cfg: DEFAULT_CONFIG });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.entryWorst > 4316, "the entry is modelled worse than the quote");
  assert.ok(r.stopWorst < 4310, "the exit is modelled worse than the stop");
  assert.ok(r.estimatedRisk <= 50 + 1e-6, `risk ${r.estimatedRisk} must not exceed the 0.5% of 10,000 budget`);
  assert.equal(r.qty, roundDownToStep(r.qty, 0.01));
});

test("sizing: a request above the operator ceiling is clamped, not honoured", () => {
  const r = sizePosition({ side: "buy", executable: 4316, stop: 4310, equity: 10_000, riskPct: 25, spec: spec(), conversionRate: 1, cfg: DEFAULT_CONFIG });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.riskBudget <= 10_000 * 0.02 + 1e-9, "clamped to the 2% ceiling");
  assert.ok(r.notes.some((n) => /clamped/.test(n)));
});

test("sizing: a small account whose minimum lot exceeds its risk budget is skipped", () => {
  const r = sizePosition({ side: "buy", executable: 4316, stop: 4306, equity: 200, riskPct: 0.25, spec: spec(), conversionRate: 1, cfg: DEFAULT_CONFIG });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /minimum quantity/);
});

test("sizing: the session allowance can bind tighter than the percentage", () => {
  const r = sizePosition({ side: "buy", executable: 4316, stop: 4310, equity: 10_000, riskPct: 2, spec: spec(), conversionRate: 1, remainingSessionRisk: 12, cfg: DEFAULT_CONFIG });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.riskBudget, 12);
  assert.ok(r.estimatedRisk <= 12 + 1e-6);
});

test("sizing: an overfill is reduced or closed, never absorbed by widening the stop", () => {
  assert.equal(reconcileExposure(0.1, 0.1, spec(), DEFAULT_CONFIG).action, "ok");
  assert.equal(reconcileExposure(0.102, 0.1, spec(), DEFAULT_CONFIG).action, "ok", "within the 5% tolerance");
  const over = reconcileExposure(0.2, 0.1, spec(), DEFAULT_CONFIG);
  assert.equal(over.action, "reduce");
  assert.ok(Math.abs((over.reduceBy ?? 0) - 0.1) < 1e-9);
  const tiny = reconcileExposure(0.011, 0.01, spec({ minLot: 0.01, lotStep: 0.01 }), DEFAULT_CONFIG);
  assert.equal(tiny.action, "close", "no valid partial reduction exists, so the position goes");
});
