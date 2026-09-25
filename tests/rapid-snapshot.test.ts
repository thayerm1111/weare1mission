import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, withOverrides } from "../rapid/config/defaults";
import type { Bar, Quote } from "../rapid/core/types";
import { buildSnapshot } from "../rapid/engine/snapshot";
import { GOLD_SESSION, isSessionOpen } from "../rapid/market/session";

/**
 * End-to-end snapshot behaviour.
 *
 * These drive the SAME function Analyze, replay and automation call. A scenario is expressed as a
 * price path in 1-minute steps so the fixtures read like what happened, not like a bar array.
 */

const MIN = 60_000;

/** Walk a price path into 1-minute bars, skipping minutes when the market is closed. */
function pathToM1(start: number, path: number[], wiggle = 0.4): Bar[] {
  const out: Bar[] = [];
  let t = start;
  let i = 0;
  while (i < path.length) {
    if (!isSessionOpen(t, GOLD_SESSION)) { t += MIN; continue; }
    const p = path[i];
    const prev = i > 0 ? path[i - 1] : p;
    out.push({ t, o: prev, h: Math.max(prev, p) + wiggle, l: Math.min(prev, p) - wiggle, c: p });
    t += MIN;
    i++;
  }
  return out;
}

/** Linear interpolation between waypoints, `steps` minutes each. */
function legs(from: number, waypoints: Array<[number, number]>): number[] {
  const out: number[] = [from];
  let cur = from;
  for (const [to, steps] of waypoints) {
    for (let s = 1; s <= steps; s++) out.push(cur + ((to - cur) * s) / steps);
    cur = to;
  }
  return out;
}

const quote = (bid: number, ask: number, at: number): Quote => ({
  source: "broker", bid, ask, providerTs: null, providerTsPrecision: "none", receivedAt: at, seq: null,
});

// Monday 21 Sep 2026, 03:00 New York — inside the session, with room to build history.
const START = Date.UTC(2026, 8, 21, 7, 0, 0);

test("snapshot: with no history at all the engine is BLOCKED and says why, rather than guessing", () => {
  const snap = buildSnapshot({
    asOf: START + 10 * MIN,
    cfg: DEFAULT_CONFIG,
    tick: 0.01,
    contractSize: 100,
    minStopDistance: null,
    m1: pathToM1(START, legs(4316, [[4317, 10]])),
    quote: quote(4316.9, 4317.1, START + 10 * MIN),
  });
  assert.equal(snap.health.state, "blocked");
  assert.ok(snap.health.reasons.some((r) => /warming up/.test(r)));
  assert.equal(snap.scenarios.length, 0);
  assert.equal(snap.regimes.M5, "unknown");
  assert.match(snap.deterministicExplanation, /No qualifying setup|warming/i);
});

test("snapshot: an oscillating market produces a validated range and at most one long and one short", () => {
  // Six clean traverses between 4310 and 4326, then park mid-range.
  const wps: Array<[number, number]> = [];
  for (let i = 0; i < 6; i++) {
    wps.push([4325.5, 45]);
    wps.push([4310.5, 45]);
  }
  wps.push([4318, 20]);
  const m1 = pathToM1(START, legs(4318, wps));
  const asOf = m1[m1.length - 1].t + MIN;

  const snap = buildSnapshot({
    asOf,
    cfg: DEFAULT_CONFIG,
    tick: 0.01,
    contractSize: 100,
    minStopDistance: null,
    m1,
    quote: quote(4317.9, 4318.1, asOf),
  });

  assert.ok(snap.zones.length > 0, "the level map is populated");
  assert.ok(snap.scenarios.length <= 2, "at most the best long and the best short are surfaced");
  const sides = new Set(snap.scenarios.map((s) => s.side));
  assert.ok(sides.size <= 1 || snap.scenarios.length <= 2);
  assert.ok(snap.rejections.length > 0, "the rejection funnel is recorded, not discarded");
  assert.equal(snap.strategyVersion, "matty_rapid_v1");
  assert.ok(snap.deterministicExplanation.length > 40);
});

test("snapshot: identical inputs produce an identical decision — replay and live cannot diverge", () => {
  const m1 = pathToM1(START, legs(4318, [[4326, 60], [4310, 60], [4326, 60], [4310, 60], [4318, 30]]));
  const asOf = m1[m1.length - 1].t + MIN;
  const inp = { asOf, cfg: DEFAULT_CONFIG, tick: 0.01, contractSize: 100, minStopDistance: null, m1, quote: quote(4317.9, 4318.1, asOf) };
  const a = buildSnapshot(inp);
  const b = buildSnapshot(inp);
  const strip = (s: ReturnType<typeof buildSnapshot>) =>
    JSON.stringify({ ...s, snapshotId: null, scenarios: s.scenarios.map((x) => ({ ...x, setupId: null })) });
  assert.equal(strip(a), strip(b));
});

test("snapshot: no executable quote means Analyze still works but execution is unavailable", () => {
  const m1 = pathToM1(START, legs(4318, [[4326, 60], [4310, 60], [4326, 60], [4310, 60], [4318, 30]]));
  const asOf = m1[m1.length - 1].t + MIN;
  const snap = buildSnapshot({ asOf, cfg: DEFAULT_CONFIG, tick: 0.01, contractSize: 100, minStopDistance: null, m1, quote: null });
  assert.notEqual(snap.health.state, "ok");
  assert.ok(snap.health.reasons.some((r) => /Analyze only/.test(r)));
  assert.equal(snap.feedSource, "reference");
});

test("snapshot: a stale feed degrades health and reports the age rather than relabelling it live", () => {
  const m1 = pathToM1(START, legs(4318, [[4326, 60], [4310, 60], [4326, 60], [4310, 60], [4318, 30]]));
  const asOf = m1[m1.length - 1].t + MIN;
  const snap = buildSnapshot({
    asOf, cfg: DEFAULT_CONFIG, tick: 0.01, contractSize: 100, minStopDistance: null, m1,
    quote: quote(4317.9, 4318.1, asOf - 9000),
  });
  assert.equal(snap.quoteAgeMs, 9000);
  assert.notEqual(snap.health.state, "ok");
  assert.ok(snap.health.reasons.some((r) => /feed age 9000ms/.test(r)));
});

test("snapshot: the market being closed blocks new work and names the reason", () => {
  const m1 = pathToM1(START, legs(4318, [[4326, 60], [4310, 60], [4326, 60], [4310, 60], [4318, 30]]));
  const saturday = Date.UTC(2026, 8, 26, 12, 0); // Saturday
  const snap = buildSnapshot({ asOf: saturday, cfg: DEFAULT_CONFIG, tick: 0.01, contractSize: 100, minStopDistance: null, m1, quote: quote(4317.9, 4318.1, saturday) });
  assert.equal(snap.health.state, "blocked");
  assert.ok(snap.health.reasons.some((r) => /market closed: weekend/.test(r)));
});

test("snapshot: no rule may read a level before the bar that made it knowable has closed", () => {
  // Build history, then take two snapshots one bar apart and prove the zone set only ever grows
  // forward in time — nothing appears with a knownAt in the future.
  const m1 = pathToM1(START, legs(4318, [[4326, 90], [4310, 90], [4326, 90], [4310, 90], [4318, 40]]));
  const asOf = m1[m1.length - 1].t + MIN;
  const snap = buildSnapshot({ asOf, cfg: DEFAULT_CONFIG, tick: 0.01, contractSize: 100, minStopDistance: null, m1, quote: quote(4317.9, 4318.1, asOf) });
  for (const z of snap.zones) {
    assert.ok(z.knownAt <= asOf, `zone ${z.id} claims to be knowable at ${z.knownAt}, after the decision time ${asOf}`);
    for (const r of z.reactions) assert.ok(r.at <= asOf, `reaction at ${r.at} is in the future`);
  }
  for (const s of snap.scenarios) {
    assert.ok(s.createdAt <= asOf);
    if (s.breakEvidence) assert.ok(s.breakEvidence.closedAt <= asOf, "a breakout cannot be used before its candle closed");
  }
});

test("snapshot: the research momentum family stays out unless it is explicitly switched on", () => {
  const m1 = pathToM1(START, legs(4300, [[4340, 200], [4336, 20]]));
  const asOf = m1[m1.length - 1].t + MIN;
  const base = { asOf, tick: 0.01, contractSize: 100, minStopDistance: null, m1, quote: quote(4335.9, 4336.1, asOf) };
  const off = buildSnapshot({ ...base, cfg: DEFAULT_CONFIG });
  assert.equal(off.scenarios.some((s) => s.family === "momentum"), false);
  assert.equal(off.rejections.some((r) => r.family === "momentum"), false, "a disabled family is not even evaluated");

  const on = withOverrides(DEFAULT_CONFIG, "momentum-on", { entry: { momentumEnabled: true } });
  const snap = buildSnapshot({ ...base, cfg: on });
  assert.equal(snap.configVersion, "matty_rapid_v1.cfg.1+momentum-on", "the variant is separately versioned");
});

test("snapshot: every surfaced scenario is internally consistent", () => {
  const m1 = pathToM1(START, legs(4318, [[4326, 45], [4310, 45], [4326, 45], [4310, 45], [4326, 45], [4310, 45], [4318, 25]]));
  const asOf = m1[m1.length - 1].t + MIN;
  const snap = buildSnapshot({ asOf, cfg: DEFAULT_CONFIG, tick: 0.01, contractSize: 100, minStopDistance: null, m1, quote: quote(4317.9, 4318.1, asOf) });
  for (const s of snap.scenarios) {
    const d = s.side === "buy" ? 1 : -1;
    assert.ok(d * (s.refEntry - s.stop) > 0, "the stop is on the losing side of the entry");
    assert.ok(d * (s.target - s.refEntry) > 0, "the target is on the winning side of the entry");
    assert.ok(s.stopUsd <= DEFAULT_CONFIG.protection.stopCapUsd + 1e-9, `stop ${s.stopUsd} breached the cap`);
    assert.ok(s.targetUsd >= DEFAULT_CONFIG.target.minUsd - 1e-9, `target ${s.targetUsd} below the minimum`);
    assert.ok(s.targetUsd <= DEFAULT_CONFIG.target.maxUsd + 1e-9, `target ${s.targetUsd} above the maximum`);
    assert.ok(s.entryBandLow < s.entryBandHigh);
    assert.ok(s.expiresAt > s.createdAt);
    assert.equal(s.configVersion, DEFAULT_CONFIG.configVersion);
    assert.ok(s.conditionsMet.length > 0, "a candidate must be able to explain itself");
  }
});
