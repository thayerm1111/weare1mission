import test from "node:test";
import assert from "node:assert/strict";
import type { Bar, Setup, Side, Zone } from "../rapid/core/types";
import { DEFAULT_CONFIG } from "../rapid/config/defaults";
import { TF_MS } from "../rapid/market/bars";
import { findPivots } from "../rapid/engine/structure";
import { buildSnapshot } from "../rapid/engine/snapshot";
import { arbitrate } from "../rapid/engine/arbitration";
import { makeZone } from "../rapid/engine/zones";
import type { EngineContext } from "../rapid/engine/setups";
import { NITROUS_CONFIG, NITROUS_FAST_CONFIG, NITROUS_SWEEP_CONFIG, configFor, isFastSetup, isSweepSetup } from "../nitrous/config";
import { buildSweepReclaim } from "../nitrous/sweep-reclaim";

const T = Date.UTC(2026, 10, 25, 12);
const reflect = (b: Bar): Bar => ({ ...b, o: 7000 - b.o, h: 7000 - b.l, l: 7000 - b.h, c: 7000 - b.c });
function fixture(side: Side = "buy", tf: "M5" | "M15" = "M5"): EngineContext {
  const ms = TF_MS[tf];
  const bars: Bar[] = Array.from({ length: 61 }, (_, i) => ({ t: T + i * ms, o: 3505, h: 3506, l: 3504, c: 3505 }));
  bars[54] = { ...bars[54], l: 3500 }; // A swing low, confirmed at the close of bar 56.
  bars[60] = { ...bars[60], o: 3502.5, h: 3505.2, l: 3499.4, c: 3504.8 };
  const actual = side === "buy" ? bars : bars.map(reflect);
  return { asOf: T + 61 * ms + 1, tick: .01, bars: { [tf]: actual },
    pivots: { [tf]: findPivots(actual, tf, 2, 2) }, atr: { [tf]: 4 }, zones: [], range: null,
    refPrice: actual.at(-1)!.c, spread: .1, minStopDistance: null, contractSize: 100,
    executionTimeframes: [tf], cfg: NITROUS_SWEEP_CONFIG };
}
function withCandle(ctx: EngineContext, changes: Partial<Bar>): EngineContext {
  const tf = ctx.executionTimeframes[0];
  const bars = ctx.bars[tf]!.map((b, i, all) => i === all.length - 1 ? { ...b, ...changes } : b);
  return { ...ctx, bars: { [tf]: bars }, refPrice: bars.at(-1)!.c };
}
function obstacle(price: number): Zone {
  return makeZone({ role: "resistance", low: price, high: price + .2, origin: "H1", tier: "primary",
    knownAt: T, provenance: { kind: "swing", timeframe: "H1", pivotT: T - TF_MS.H1 } }, "opposition", "opposition", T);
}
const codes = (ctx: EngineContext): string[] => buildSweepReclaim(ctx).rejections.map(r => r.code);

test("sweep config is an immutable, explicit Nitrous variant with existing fast risk limits", () => {
  assert.equal(NITROUS_SWEEP_CONFIG.configVersion, "matty_rapid_v1.cfg.1+nitrous.1+fast.2+sweep.1");
  assert.ok(Object.isFrozen(NITROUS_SWEEP_CONFIG) && Object.isFrozen(NITROUS_SWEEP_CONFIG.entry));
  assert.deepEqual(NITROUS_SWEEP_CONFIG.protection, NITROUS_FAST_CONFIG.protection);
  assert.deepEqual(NITROUS_SWEEP_CONFIG.target, NITROUS_FAST_CONFIG.target);
  assert.deepEqual(NITROUS_SWEEP_CONFIG.risk, NITROUS_FAST_CONFIG.risk);
  assert.equal(isSweepSetup(NITROUS_SWEEP_CONFIG), true);
  assert.equal(isFastSetup(NITROUS_SWEEP_CONFIG), false);
  assert.equal(configFor("nitrous", "sweep").configVersion, NITROUS_SWEEP_CONFIG.configVersion);
  assert.equal(configFor("slow_drip", "sweep").configVersion, NITROUS_CONFIG.configVersion);
  assert.equal(configFor("nitrous", true).configVersion, NITROUS_FAST_CONFIG.configVersion);
  assert.equal(configFor("nitrous", false).configVersion, NITROUS_CONFIG.configVersion);
});

test("confirmed buy and sell sweeps create close-centered entries on M5 and M15 without a retest", () => {
  for (const side of ["buy", "sell"] as const) for (const tf of ["M5", "M15"] as const) {
    const ctx = fixture(side, tf);
    const before = JSON.stringify(ctx);
    const result = buildSweepReclaim(ctx);
    assert.equal(result.setups.length, 1, JSON.stringify(result.rejections));
    const s = result.setups[0], b = ctx.bars[tf]!.at(-1)!;
    assert.equal(s.family, "sweep_reclaim");
    assert.equal(s.side, side);
    assert.equal(s.refEntry, b.c);
    assert.equal(s.entryBandLow, b.c - s.tolerances.touchTolerance);
    assert.equal(s.entryBandHigh, b.c + s.tolerances.touchTolerance);
    assert.equal(s.invalidation, side === "buy" ? b.l : b.h);
    assert.ok(side === "buy" ? s.stop <= b.l - s.tolerances.stopBuffer : s.stop >= b.h + s.tolerances.stopBuffer);
    assert.equal(s.expiresAt, b.t + 2 * TF_MS[tf]);
    assert.equal(s.breakEvidence, null);
    assert.ok(s.sweepEvidence!.pivotKnownAt <= b.t);
    assert.equal(s.sweepEvidence!.candleClosedAt, b.t + TF_MS[tf]);
    assert.equal(s.sweepEvidence!.confirmationThreshold, 3500);
    assert.equal(s.configVersion, NITROUS_SWEEP_CONFIG.configVersion);
    assert.equal(JSON.stringify(ctx), before, "the builder must not mutate market inputs");
    assert.deepEqual(buildSweepReclaim(ctx), result, "same inputs produce identical evidence and IDs");
  }
});

test("forming candles, same-close entries and hindsight pivots cannot create sweep signals", () => {
  const ctx = fixture(), b = ctx.bars.M5!.at(-1)!;
  assert.equal(buildSweepReclaim({ ...ctx, asOf: b.t + TF_MS.M5 - 1 }).setups.length, 0);
  assert.ok(codes({ ...ctx, asOf: b.t + TF_MS.M5 }).includes("forming_candle"));
  const hindsight = { ...ctx, pivots: { M5: ctx.pivots.M5!.map(p => ({ ...p, knownAt: b.t + TF_MS.M5 })) } };
  assert.ok(codes(hindsight).includes("no_anchor"));
  assert.equal(buildSweepReclaim(hindsight).setups.length, 0);
  const future = { t: b.t + TF_MS.M5, o: 3504.8, h: 3510, l: 3490, c: 3509 };
  assert.deepEqual(buildSweepReclaim({ ...ctx, bars: { M5: [...ctx.bars.M5!, future] } }), buildSweepReclaim(ctx));
});

test("a touch, insufficient penetration or prior close outside the level is not a sweep", () => {
  const ctx = fixture();
  for (const low of [3500, 3499.6]) {
    const insufficient = withCandle(ctx, { l: low });
    assert.equal(buildSweepReclaim(insufficient).setups.length, 0);
    assert.ok(codes(insufficient).includes("no_sweep"));
  }
  const bars = ctx.bars.M5!.map((b, i) => i === 59 ? { ...b, o: 3499, l: 3498, c: 3499 } : b);
  assert.ok(codes({ ...ctx, bars: { M5: bars } }).includes("no_sweep"));
  assert.ok(codes(withCandle(ctx, { o: 3499.4 })).includes("no_sweep"), "opening at the candle low creates no swept lower wick");
  const flatPrior = ctx.bars.M5!.map((b, i) => i === 59 ? { ...b, o: 3505, h: 3505, l: 3505, c: 3505 } : b);
  assert.equal(buildSweepReclaim({ ...ctx, bars: { M5: flatPrior } }).setups.length, 1, "a valid inside close may come from a flat preceding candle");
});

test("penetration alone is insufficient without a directional close back inside the swing", () => {
  const ctx = fixture();
  for (const candle of [{ o: 3499.5, c: 3499.8 }, { o: 3505, c: 3504.8 }, { o: 3500.1, c: 3500.2 }]) {
    const failed = withCandle(ctx, candle);
    assert.equal(buildSweepReclaim(failed).setups.length, 0);
    assert.ok(codes(failed).includes("no_reclaim"));
  }
});

test("the reclaim entry expires after one candle and cannot chase price outside its frozen band", () => {
  for (const tf of ["M5", "M15"] as const) {
    const ctx = fixture("buy", tf);
    const s = buildSweepReclaim(ctx).setups[0];
    assert.ok(codes({ ...ctx, asOf: s.expiresAt }).includes("expired"));
    assert.equal(buildSweepReclaim({ ...ctx, asOf: s.expiresAt }).setups.length, 0);
    assert.ok(codes({ ...ctx, refPrice: s.entryBandHigh + .01 }).includes("outside_band"));
    assert.ok(codes({ ...ctx, refPrice: s.invalidation - .01 }).includes("outside_band"));
  }
});

test("an earlier swept wick does not turn a later ordinary candle into another reclaim signal", () => {
  const ctx = fixture();
  const signal = ctx.bars.M5!.at(-1)!;
  const later = { t: signal.t + TF_MS.M5, o: 3504.8, h: 3505.2, l: 3504.5, c: 3505 };
  const after = { ...ctx, asOf: later.t + TF_MS.M5 + 1, bars: { M5: [...ctx.bars.M5!, later] }, refPrice: later.c };
  assert.equal(buildSweepReclaim(after).setups.length, 0);
  assert.ok(codes(after).includes("no_sweep"));
});

test("the full swept wick and broker minimum are preserved even when they exceed the stop cap", () => {
  const tooWide = withCandle(fixture(), { l: 3488 });
  assert.equal(buildSweepReclaim(tooWide).setups.length, 0);
  assert.ok(codes(tooWide).includes("stop_too_wide"));
  assert.ok(codes({ ...fixture(), minStopDistance: 12.5 }).includes("stop_too_wide"));
  const widened = buildSweepReclaim({ ...fixture(), minStopDistance: 7 }).setups[0];
  assert.ok(widened.stopUsd >= 7 && widened.stop < widened.invalidation);
});

test("target obstacles, net reward/risk, costs and spread remain mandatory", () => {
  const ctx = fixture();
  assert.ok(codes({ ...ctx, zones: [obstacle(3510)] }).includes("target_room_short"));
  const lowReward = withCandle(ctx, { l: 3493.8 });
  assert.ok(codes({ ...lowReward, zones: [obstacle(3512)] }).includes("reward_risk_short"));
  assert.ok(codes({ ...ctx, contractSize: 1 }).includes("cost_too_high"));
  assert.ok(codes({ ...ctx, spread: 1 }).includes("spread_too_wide"));
});

test("a swept pivot shares its existing merged parent identity and cannot resurrect a suspended level", () => {
  const ctx = fixture();
  const pivot = ctx.pivots.M5!.find(p => p.kind === "low")!;
  const id = `sw:M5:low:${pivot.t}`;
  const parent = makeZone({ role: "support", low: 3420, high: 3505, origin: "H4", tier: "primary",
    knownAt: T, provenance: { kind: "swing", timeframe: "H4", pivotT: T - TF_MS.H4 } }, "existing-zone", "existing-parent", T);
  parent.mergedFrom = [id];
  parent.version = 7;
  const s = buildSweepReclaim({ ...ctx, zones: [parent] }).setups[0];
  assert.equal(s.parentId, "existing-parent");
  assert.equal(s.zoneId, "existing-zone");
  assert.equal(s.zoneVersion, 7);
  assert.ok(s.stopUsd < 12, "this distinct strategy anchors to the whole sweep wick, not the old retest zone");
  const suspended = { ...parent, failedStops: NITROUS_SWEEP_CONFIG.range.maxFailedStopsPerZone };
  assert.ok(codes({ ...ctx, zones: [suspended] }).includes("zone_suspended"));
  assert.ok(codes({ ...ctx, zones: [], zoneHistory: [suspended] }).includes("zone_suspended"), "filtered-out parent identity cannot be bypassed with a new pivot key");
  const result = arbitrate([s, { ...s, family: "range_reaction", setupId: "old-range" }], "up");
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].family, "sweep_reclaim");
});

test("the snapshot hook runs before candidate filtering and generic Rapid never builds sweeps by default", () => {
  const ctx = fixture();
  const base = { asOf: ctx.asOf, cfg: DEFAULT_CONFIG, tick: ctx.tick, contractSize: ctx.contractSize,
    minStopDistance: ctx.minStopDistance, m1: [], higher: ctx.bars, quote: null };
  assert.equal(buildSnapshot(base).scenarios.some(s => s.family === "sweep_reclaim"), false);
  const sweep = buildSnapshot({ ...base, cfg: NITROUS_SWEEP_CONFIG, candidateBuilder: buildSweepReclaim });
  assert.ok(sweep.scenarios.some(s => s.family === "sweep_reclaim"));
  let filtered = false;
  let rejectionCalls = 0;
  const blocked = buildSnapshot({ ...base, cfg: NITROUS_SWEEP_CONFIG, candidateBuilder: buildSweepReclaim,
    candidateFilter: s => { filtered ||= s.family === "sweep_reclaim"; return false; },
    candidateRejection: () => { rejectionCalls++; return { code: "regime_conflict", detail: "The hourly direction does not support this side." }; } });
  assert.equal(filtered, true);
  assert.equal(blocked.scenarios.length, 0);
  assert.equal(rejectionCalls, 1);
  assert.ok(blocked.rejections.some(r => r.stage === "qualification" && r.code === "regime_conflict" && r.zoneId));
  assert.ok(blocked.rejections.every(r => r.family === "sweep_reclaim"), "a dedicated sweep snapshot must not report other-family failures");
  buildSnapshot({ ...base, cfg: NITROUS_SWEEP_CONFIG, candidateBuilder: buildSweepReclaim,
    candidateFilter: () => true, candidateRejection: () => { throw new Error("accepted candidates must not invoke rejection diagnostics"); } });
});

test("sweep recheck emits price-only waits while enforcing invalidation, expiry and target room", () => {
  for (const side of ["buy", "sell"] as const) {
    const ctx = fixture(side);
    const plan = buildSweepReclaim(ctx).setups[0];
    const price = side === "buy" ? plan.entryBandHigh+1 : plan.entryBandLow-1;
    const waiting: Setup[] = [];
    const scan = (extra: Partial<EngineContext>) => buildSweepReclaim({ ...ctx, refPrice: price, ...extra }, s => waiting.push(s));
    assert.equal(scan({}).setups.length, 0);
    assert.deepEqual(waiting, [plan]);
    scan({refPrice:plan.invalidation}); scan({refPrice:plan.target}); scan({asOf:plan.expiresAt});
    scan({ spread: 5 });
    assert.equal(waiting.length, 1);
  }
});
