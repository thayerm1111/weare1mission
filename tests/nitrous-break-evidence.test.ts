import test from "node:test";
import assert from "node:assert/strict";
import type { Bar, Side, Timeframe, Zone } from "../rapid/core/types";
import { DEFAULT_CONFIG, type RapidConfig } from "../rapid/config/defaults";
import { buildSetups, findBreak, type EngineContext } from "../rapid/engine/setups";
import { TF_MS } from "../rapid/market/bars";
import { NITROUS_CONFIG, NITROUS_FAST_CONFIG } from "../nitrous/config";
import { triggerConfirmed } from "../nitrous/logic";

const T = Date.UTC(2026, 10, 25, 12);
const zone = (side: Side, tf: Timeframe): Zone => ({
  id: "test-level", parentId: "test-level", version: 1,
  role: side === "buy" ? "resistance" : "support", low: 3500, high: 3501,
  origin: tf, tier: "execution", provenance: { kind: "swing", timeframe: tf, pivotT: T - 70 * TF_MS[tf] },
  createdAt: T - 65 * TF_MS[tf], knownAt: T - 65 * TF_MS[tf], roleSince: T - 65 * TF_MS[tf],
  previousRole: null, reactions: [], failedStops: 0, invalidatedAt: null, invalidReason: null, mergedFrom: [],
});
const series = (side: Side, tf: Timeframe, rows: number[][]): Bar[] => rows.map(([o, h, l, c], i) =>
  side === "buy" ? { t: T + i * TF_MS[tf], o, h, l, c }
    : { t: T + i * TF_MS[tf], o: 7001 - o, h: 7001 - l, l: 7001 - h, c: 7001 - c });
const breakoutRows = [
  [3500.1, 3500.8, 3499.9, 3500.5],
  [3500.5, 3502.2, 3500.4, 3502], // Actual crossing.
  [3502, 3503.2, 3501.9, 3503], // Strong continuation, not another crossing.
  [3503, 3503.1, 3500.9, 3501.1], // Return to the entry band.
];
function context(bars: Bar[], side: Side, tf: Timeframe, cfg: RapidConfig, asOf: number): EngineContext {
  const warmup = Array.from({ length: cfg.feed.warmupBars }, (_, i) => ({
    t: T - (cfg.feed.warmupBars - i) * TF_MS[tf], o: 3500.5, h: 3500.6, l: 3500.4, c: 3500.5,
  }));
  return { asOf, tick: .01, bars: { [tf]: [...warmup, ...bars] }, pivots: { [tf]: [] }, atr: { [tf]: 1 },
    zones: [zone(side, tf)], range: null, refPrice: bars.at(-1)!.c, spread: .1,
    minStopDistance: null, contractSize: 100, executionTimeframes: [tf], cfg };
}

test("Nitrous preserves the genuine break through a continuation and retest on either side and timeframe", () => {
  for (const cfg of [NITROUS_CONFIG, NITROUS_FAST_CONFIG]) {
    for (const side of ["buy", "sell"] as const) {
      for (const tf of ["M5", "M15"] as const) {
        const bars = series(side, tf, breakoutRows);
        const now = T + 4 * TF_MS[tf] + 1;
        const built = buildSetups(context(bars, side, tf, cfg, now));
        const setup = built.setups.find(s => s.family === "break_retest" && s.side === side);
        assert.ok(setup, JSON.stringify(built.rejections));
        assert.equal(setup.breakEvidence?.closedAt, T + 2 * TF_MS[tf]);
        assert.equal(setup.expiresAt, T + (2 + cfg.entry.retestExpiryBars) * TF_MS[tf]);
        assert.equal(triggerConfirmed(setup, bars, now), true);
        assert.ok(bars.at(-1)!.c >= setup.entryBandLow && bars.at(-1)!.c <= setup.entryBandHigh);
      }
    }
  }
});

test("Rapid keeps its existing evidence choice unless the fresh-cross requirement is enabled", () => {
  const bars = series("buy", "M5", breakoutRows);
  const now = T + 4 * TF_MS.M5 + 1;
  const legacy = findBreak(bars, zone("buy", "M5"), "buy", .15, "M5", DEFAULT_CONFIG, now);
  const nitrous = findBreak(bars, zone("buy", "M5"), "buy", .15, "M5", NITROUS_CONFIG, now);
  assert.equal(legacy?.closedAt, T + 3 * TF_MS.M5);
  assert.equal(nitrous?.closedAt, T + 2 * TF_MS.M5);
});

test("continuations cannot restart the six-bar expiry and the boundary predecessor remains available", () => {
  const rows = breakoutRows.slice(0, 2);
  for (let i = 0; i < 6; i++) rows.push([3502 + i, 3503.2 + i, 3501.9 + i, 3503 + i]);
  for (const side of ["buy", "sell"] as const) {
    const bars = series(side, "M5", rows);
    const expiresAt = T + 8 * TF_MS.M5;
    const evidence = findBreak(bars, zone(side, "M5"), side, .15, "M5", NITROUS_FAST_CONFIG, expiresAt);
    assert.equal(evidence?.closedAt, T + 2 * TF_MS.M5, "the first searched bar uses its predecessor outside the window");
    const built = buildSetups(context(bars, side, "M5", NITROUS_FAST_CONFIG, expiresAt));
    assert.equal(built.setups.some(s => s.family === "break_retest" && s.side === side), false);
    assert.ok(built.rejections.some(r => r.code === "expired" && r.family === "break_retest"));
  }
});

test("an opposite break on the next candle still cancels a Nitrous retest", () => {
  for (const side of ["buy", "sell"] as const) {
    const bars = series(side, "M5", [...breakoutRows.slice(0, 2), [3502, 3502.1, 3498.8, 3499]]);
    const built = buildSetups(context(bars, side, "M5", NITROUS_CONFIG, T + 3 * TF_MS.M5 + 1));
    assert.equal(built.setups.some(s => s.family === "break_retest" && s.side === side), false);
    assert.ok(built.rejections.some(r => r.code === "opposite_break" && r.family === "break_retest"));
  }
});

test("Nitrous cannot infer a fresh crossing without a predecessor or before the break closes", () => {
  for (const side of ["buy", "sell"] as const) {
    const bars = series(side, "M5", breakoutRows.slice(0, 2));
    const closedAt = T + 2 * TF_MS.M5;
    assert.equal(findBreak(bars, zone(side, "M5"), side, .15, "M5", NITROUS_CONFIG, closedAt - 1), null);
    assert.equal(findBreak(bars.slice(1), zone(side, "M5"), side, .15, "M5", NITROUS_CONFIG, closedAt + 1), null);
    const setup = buildSetups(context(bars, side, "M5", NITROUS_CONFIG, closedAt)).setups.find(s => s.family === "break_retest");
    assert.ok(setup);
    assert.equal(triggerConfirmed(setup, bars, closedAt), false, "an entry must arrive after the break closes");
    assert.equal(triggerConfirmed(setup, bars, closedAt + 1), true);
  }
});
