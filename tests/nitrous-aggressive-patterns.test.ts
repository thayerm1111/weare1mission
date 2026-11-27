import assert from "node:assert/strict";
import test from "node:test";
import { NITROUS_AGGRESSIVE_CONFIG as cfg } from "../nitrous/config";
import { aggressiveEvidenceSane, aggressiveRegimeEligible, aggressiveTriggerConfirmed, buildAggressivePatterns } from "../nitrous/aggressive-patterns";
import type { Bar, Regime, Setup, Side, Timeframe } from "../rapid/core/types";
import type { EngineContext } from "../rapid/engine/setups";
import { makeZone } from "../rapid/engine/zones";

const M5 = 300_000, T = Date.UTC(2026, 9, 1, 12);
type Family = "range_edge_rejection" | "compression_breakout";
function fixture(family: Family, side: Side = "buy"): EngineContext {
  const bars: Bar[] = [];
  const add = (o: number, h: number, l: number, c: number) => bars.push({ t: T + bars.length * M5, o, h, l, c });
  for (let i = 0; i < 66; i++) add(3503, 3505, 3501, 3503);
  if (family === "compression_breakout") {
    for (let i = 0; i < 6; i++) add(3502, 3504, 3501, 3503);
    add(3503, 3507.2, 3502.8, 3507);
  } else {
    for (let i = 0; i < 24; i++) {
      const j = i % 8;
      if (j === 1) add(3502, 3504, 3498, 3501);
      else if (j === 5) add(3509, 3512, 3506, 3509);
      else add(3505, 3507, 3503, 3505);
    }
    add(3499.5, 3501.5, 3498.1, 3501.3);
  }
  const actual = side === "buy" ? bars : bars.map(b => ({ ...b, o: 7000 - b.o, h: 7000 - b.l, l: 7000 - b.h, c: 7000 - b.c }));
  return { bars: { M5: actual }, asOf: actual.at(-1)!.t + M5 + 1, refPrice: actual.at(-1)!.c,
    zones: [], pivots: {}, atr: { M5: 4 }, range: null, spread: .12, tick: .01, minStopDistance: null,
    contractSize: 100, executionTimeframes: ["M5"], cfg };
}
function get(ctx: EngineContext, family: Family): Setup | undefined {
  return buildAggressivePatterns(ctx).setups.find(s => s.family === family);
}
function candle(ctx: EngineContext, index: number, patch: Partial<Bar>): EngineContext {
  const bars = ctx.bars.M5!.slice();
  bars[index] = { ...bars[index], ...patch };
  return { ...ctx, bars: { M5: bars }, refPrice: bars.at(-1)!.c };
}
const regimes = (H1: Regime, M15: Regime) => ({ H1, M15 }) as Record<Timeframe, Regime>;

test("sideways hourly structure enables two independently confirmed alternatives; opposing or unknown structure still disqualifies", () => {
  for (const side of ["buy", "sell"] as const) {
    for (const family of ["range_edge_rejection", "compression_breakout"] as const) {
      assert.ok(aggressiveRegimeEligible(family, side, regimes("sideways", "sideways")));
      assert.equal(aggressiveRegimeEligible(family, side, regimes("unknown", "sideways")), false);
      assert.equal(aggressiveRegimeEligible(family, side, regimes("sideways", "unknown")), false);
    }
    const aligned = side === "buy" ? "up" : "down";
    const opposite = side === "buy" ? "down" : "up";
    assert.ok(aggressiveRegimeEligible("compression_breakout", side, regimes(aligned, "sideways")));
    assert.equal(aggressiveRegimeEligible("compression_breakout", side, regimes(aligned, opposite)), false);
    assert.equal(aggressiveRegimeEligible("range_edge_rejection", side, regimes(aligned, "sideways")), false);
  }
});

test("both directions and families freeze the prior box, enter after the close and keep a structural stop and achievable target", () => {
  for (const family of ["range_edge_rejection", "compression_breakout"] as const) for (const side of ["buy", "sell"] as const) {
    const ctx = fixture(family, side), s = get(ctx, family)!;
    assert.ok(s, JSON.stringify(buildAggressivePatterns(ctx).rejections));
    assert.equal(s.side, side);
    assert.equal(s.refEntry, ctx.refPrice);
    assert.equal(s.configVersion, cfg.configVersion);
    assert.ok(s.targetUsd >= 6 && s.targetUsd <= 15 + 1e-8);
    assert.ok(side === "buy" ? s.stop < s.invalidation && s.invalidation < s.refEntry : s.stop > s.invalidation && s.invalidation > s.refEntry);
    const e = s.aggressiveEvidence!;
    assert.equal(e.rangeEndedAt, e.candleOpenedAt);
    assert.ok(e.edgeTime >= e.rangeStartedAt && e.edgeTime < e.rangeEndedAt);
    if (family === "range_edge_rejection") assert.ok(side === "buy" ? s.target < e.rangeHigh : s.target > e.rangeLow);
    assert.ok(aggressiveEvidenceSane(s));
    assert.ok(aggressiveTriggerConfirmed(s, ctx.bars.M5!, ctx.asOf));
    assert.equal(aggressiveTriggerConfirmed(s, ctx.bars.M5!, e.candleClosedAt), false);
    assert.equal(aggressiveTriggerConfirmed(s, ctx.bars.M5!, s.expiresAt), false);
    assert.equal(get({ ...ctx, asOf: e.candleClosedAt }, family), undefined);
    assert.equal(get({ ...ctx, asOf: s.expiresAt }, family), undefined);
    assert.equal(get({ ...ctx, refPrice: s.entryBandHigh + .01 }, family), undefined);
    assert.equal(get({ ...ctx, asOf: ctx.asOf + 60000 }, family)!.setupId, s.setupId);
    const forming = { ...ctx.bars.M5!.at(-1)!, t: e.candleClosedAt, h: 3700, l: 3000 };
    assert.deepEqual(get({ ...ctx, bars: { M5: [...ctx.bars.M5!, forming] } }, family), s);
  }
});

test("a loose breakout box, a wick-only break or a late chase do not generate entries", () => {
  const ctx = fixture("compression_breakout"), last = ctx.bars.M5!.length - 1;
  for (const patch of [{ h: 3507, c: 3504.1 }, { c: 3504.8 }, { h: 3513, c: 3512.9 }, { o: 3505.5 }, { c: 3503.1 }]) {
    assert.equal(get(candle(ctx, last, patch), "compression_breakout"), undefined, JSON.stringify(patch));
  }
  assert.equal(get(candle(ctx, last - 5, { l: 3489 }), "compression_breakout"), undefined);
  const s = get(ctx, "compression_breakout")!;
  assert.equal(aggressiveTriggerConfirmed(s, candle(ctx, last - 4, { h: 3504.1 }).bars.M5!, ctx.asOf), false);
  assert.equal(aggressiveTriggerConfirmed(s, candle(ctx, last, { h: 3507.3 }).bars.M5!, ctx.asOf), false);
});

test("a first touch beyond the observed edge, a mid-box candle or a gap invalidates the fade", () => {
  const ctx = fixture("range_edge_rejection"), last = ctx.bars.M5!.length - 1;
  const one = candle(ctx, last - 23, { l: 3490 });
  assert.equal(get(one, "range_edge_rejection"), undefined);
  assert.equal(get(candle(ctx, last, { o: 3503.3, l: 3502.9, h: 3505.2, c: 3505 }), "range_edge_rejection"), undefined);
  assert.equal(get(candle(ctx, last, { o: 3497.9, l: 3497.8 }), "range_edge_rejection"), undefined);
  const s = get(ctx, "range_edge_rejection")!;
  const gap = ctx.bars.M5!.filter((_, i) => i !== last - 15);
  assert.equal(aggressiveTriggerConfirmed(s, gap, ctx.asOf), false);
  assert.equal(get({ ...ctx, bars: { M5: gap } }, "range_edge_rejection"), undefined);
});

test("a second visit can qualify after one prior touch and a completed departure; camping on the edge cannot", () => {
  for (const side of ["buy", "sell"] as const) {
    const ctx = fixture("range_edge_rejection", side);
    const bars = ctx.bars.M5!, start = bars.length - 25, lastClosed = bars.length - 2;
    const reflect = (p: number) => side === "buy" ? p : 7000 - p;
    const shape = (price: number, high: number, low: number) => ({
      o: reflect(price), c: reflect(price), h: reflect(side === "buy" ? high : low), l: reflect(side === "buy" ? low : high),
    });
    const oneVisit = bars.map((bar, i) => {
      if (i < start || i > lastClosed) return bar;
      const prices = i === start + 2 ? shape(3500, 3502, 3498) : i === start + 13 ? shape(3510, 3512, 3508) : shape(3505, 3507, 3503);
      return { ...bar, ...prices };
    });
    const qualified = { ...ctx, bars: { M5: oneVisit } };
    const setup = get(qualified, "range_edge_rejection");
    assert.ok(setup && aggressiveTriggerConfirmed(setup, oneVisit, ctx.asOf));
    const stalled = candle(qualified, lastClosed, shape(3499.5, 3502, 3498.1));
    assert.equal(get(stalled, "range_edge_rejection"), undefined);
    assert.equal(aggressiveTriggerConfirmed(setup, stalled.bars.M5!, ctx.asOf), false, "an undeparted touch voids a frozen signal on recheck");
    const first = candle(qualified, start + 2, shape(3505, 3507, 3503));
    assert.equal(get(first, "range_edge_rejection"), undefined, "the signal cannot define its own first edge");
  }
});

test("broker minimum stop, finite reference, spread, costs, suspended edge and opposing structure remain binding", () => {
  const ctx = fixture("compression_breakout"), s = get(ctx, "compression_breakout")!;
  for (const patch of [{ minStopDistance: 20 }, { refPrice: NaN }, { spread: 2 }, { contractSize: 1 }]) {
    assert.equal(get({ ...ctx, ...patch }, "compression_breakout"), undefined);
  }
  const obstacle = makeZone({ low: s.refEntry + 3, high: s.refEntry + 3.1, tier: "primary", role: "resistance", origin: "H1",
    knownAt: T, provenance: { kind: "swing", timeframe: "H1", pivotT: T - 3_600_000 } }, "opposition", "opposition", T);
  assert.equal(get({ ...ctx, zones: [obstacle] }, "compression_breakout"), undefined);
  const merged = { ...obstacle, id: "existing", parentId: "same-economic-level", mergedFrom: [s.zoneId] };
  assert.equal(get({ ...ctx, zoneHistory: [merged] }, "compression_breakout")?.parentId, merged.parentId);
  assert.equal(get({ ...ctx, zoneHistory: [{ ...merged, failedStops: cfg.range.maxFailedStopsPerZone }] }, "compression_breakout"), undefined);
  assert.equal(get({ ...ctx, zoneHistory: [{ ...merged, invalidatedAt: T }] }, "compression_breakout"), undefined);
});

test("revalidating a range rejection or breakout outside its band cannot authorize a new entry", () => {
  for (const family of ["range_edge_rejection", "compression_breakout"] as const) {
    for (const side of ["buy", "sell"] as const) {
      const ctx = fixture(family, side), plan = get(ctx, family)!;
      const waiting: Setup[] = [];
      const reference = side === "buy" ? plan.entryBandHigh+.01 : plan.entryBandLow-.01;
      const scan = (extra: Partial<EngineContext>) => buildAggressivePatterns({ ...ctx, refPrice: reference, ...extra }, s => waiting.push(s));
      assert.equal(scan({}).setups.length, 0);
      assert.deepEqual(waiting, [plan]);
      scan({refPrice:plan.invalidation}); scan({refPrice:plan.target}); scan({asOf:plan.expiresAt}); scan({spread:5});
      assert.equal(waiting.length, 1);
    }
  }
});
