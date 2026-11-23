import test from "node:test";
import assert from "node:assert/strict";
import { atlasGenxChart, atlasPlayChart } from "../src/lib/atlas/chart";
import { atlasGenxResult, atlasPlayResult, restoreAtlasSignalResult, type AtlasGenxResult } from "../src/lib/atlas/signals";
import type { PlayView } from "../src/components/om/plays/PlayDetail";

const candles = [
  { t: "2026-11-20 10:00:00", o: 3500, h: 3504, l: 3498, c: 3502 },
  { t: "2026-11-20 11:00:00", o: 3502, h: 3508, l: 3501, c: 3506 },
];
const play = (extra: Partial<PlayView> = {}): PlayView => ({
  id: 1_800_000_000_000, symbol: "XAU/USD", name: "Gold", market: "Metals", td: "XAU/USD",
  interval: "1h", orderType: "limit", price: 3506, asOf: "2026-11-20 11:00:00", as_of: "2026-11-20T11:15:00Z",
  status: "open", candles,
  signal: { direction: "LONG", status: "setup", entry: 3503, stopLoss: 3480, takeProfits: [3520, 3530, 3540],
    confidence: "High", riskReward: "1:2", timeframe: "Intraday", rationale: "Saved setup", invalidation: "Below the stop" },
  ...extra,
});

test("new and retained OM plays show the exact saved candles, interval and levels without treating feed times as UTC", () => {
  const original = atlasPlayResult(play(), play().id)!;
  const restored = restoreAtlasSignalResult(JSON.parse(JSON.stringify({ kind: "plays", result: original, saved: "synced" })))!;
  assert.equal(restored.kind, "plays");
  if (restored.kind !== "plays") return;
  const chart = atlasPlayChart(original), retained = atlasPlayChart(restored.result);
  assert.deepEqual(retained, chart);
  assert.equal(chart.tfLabel, "1H");
  assert.equal(chart.tfMs, 3_600_000);
  assert.equal(chart.timeKnown, false, "OM generation snapshots do not declare a candle timezone");
  assert.deepEqual(chart.bars.map(({ o, h, l, c }) => ({ o, h, l, c })), candles.map(({ o, h, l, c }) => ({ o, h, l, c })));
  assert.deepEqual(chart.levels.map(({ kind, price, label }) => ({ kind, price, label })), [
    { kind: "entry", price: 3503, label: "Limit entry" }, { kind: "stop", price: 3480, label: "Stop" },
    { kind: "target", price: 3520, label: "Target 1" }, { kind: "target", price: 3530, label: "Target 2" },
    { kind: "target", price: 3540, label: "Target 3" },
  ]);
});

test("waiting ideas retain reference annotations and a neutral no-setup read gains no invented trade levels", () => {
  const idea = play({ signal: { ...play().signal, status: "no_trade" } });
  const before = JSON.stringify(idea), chart = atlasPlayChart(idea);
  assert.equal(chart.reference, true);
  assert.ok(chart.levels.every((level) => level.label.startsWith("Reference ")));
  assert.deepEqual(chart.levels.map((level) => level.price), [3503, 3480, 3520, 3530, 3540]);
  assert.equal(JSON.stringify(idea), before);
  const neutral = atlasPlayChart(play({ signal: { ...play().signal, direction: "NEUTRAL", status: "no_trade" } }));
  assert.equal(neutral.levels.length, 0);
  assert.equal(neutral.bars.length, 2, "market candles remain readable without an actionable trade");
});

test("malformed saved candles are dropped safely instead of repaired or fabricated", () => {
  const raw = [null, 5, { ...candles[0], t: { toString: 0 } }, { ...candles[0], t: "not a date" },
    { ...candles[0], h: 3400 }, { ...candles[0], c: Infinity }, candles[1], candles[0], { ...candles[1], c: 3507 }];
  const chart = atlasPlayChart(play({ candles: raw as unknown as PlayView["candles"] }));
  assert.equal(chart.bars.length, 2);
  assert.ok(chart.bars[0].t < chart.bars[1].t);
  assert.equal(chart.bars[1].c, 3507, "the last recorded copy of a real candle is retained");
  assert.equal(atlasPlayChart(play({ candles: undefined })).bars.length, 0);
  assert.equal(atlasPlayChart(play({ candles: "damaged" as unknown as PlayView["candles"] })).bars.length, 0);
});

test("unknown intervals never become a fabricated hourly chart and invalid prices fall back only to real candle closes", () => {
  for (const interval of ["", "unknown", "__proto__", { toString: 0 }] as unknown[]) {
    const chart = atlasPlayChart(play({ interval: interval as string, price: NaN, live_price: Infinity }));
    assert.equal(chart.tfLabel, "Saved candles");
    assert.equal(chart.tfMs, 0);
    assert.equal(chart.price, 3506);
  }
  assert.equal(atlasPlayChart(play({ candles: [], price: NaN, live_price: Infinity })).price, null);
  assert.equal(atlasPlayChart(play({ interval: "15min" })).tfLabel, "15M");
  assert.equal(atlasPlayChart(play({ interval: "1day" })).tfLabel, "1D");
});

test("oversized saved history stays bounded and a different play receives an independent chart view", () => {
  const raw = Array.from({ length: 800 }, (_, i) => ({ ...candles[0], t: new Date(1_800_000_000_000 + i * 60_000).toISOString() }));
  const original = play({ candles: raw }), chart = atlasPlayChart(original);
  assert.equal(chart.bars.length, 500);
  assert.equal(chart.bars[0].t, Date.parse(raw[300].t));
  assert.equal(raw.length, 800, "display bounds never rewrite the retained play");
  assert.notEqual(atlasPlayChart(play({ id: original.id + 1 })).viewKey, chart.viewKey);
  assert.notEqual(atlasPlayChart(play({ interval: "15min" })).viewKey, chart.viewKey);
});

const genx = (extra: Partial<AtlasGenxResult> = {}, read: Partial<AtlasGenxResult["genx"]> = {}): AtlasGenxResult => atlasGenxResult({
  ok: true, signal_id: "saved-genx-read", symbol: "XAU/USD", mode: "quick", price: 3506,
  asOf: "2026-11-20T11:15:00Z", data_status: "live", candles,
  genx: {
    action: "WAIT_FOR_SELL_TRIGGER", mode: "quick", lifecycle: "waiting_for_trigger", directional_bias: "bearish",
    entry: 3507, entry_low: 3506, entry_high: 3508, stop_loss: 3514,
    tp1: 3495, tp2: 3488, tp3: 3480, closest_support: null, closest_resistance: null,
    market_story: ["Gold is testing resistance."], trigger_condition: "Wait for a closed rejection candle.",
    invalidation_reason: "A close above resistance.", trade_reasoning: [], risk_factors: [], ...read,
  },
  ...extra,
})!;

test("GENX uses the actual snapshot interval metadata or the exact legacy mode mapping, without claiming UTC or live time", () => {
  for (const [mode, label, ms] of [["quick", "5M", 300_000], ["intraday", "15M", 900_000], ["swing", "1H", 3_600_000]] as const) {
    const chart = atlasGenxChart(genx({ mode }));
    assert.equal(chart.tfLabel, label);
    assert.equal(chart.tfMs, ms);
    assert.equal(chart.symbol, "XAU/USD");
    assert.equal(chart.timeKnown, false, "asOf UTC and a generation-time live price do not declare the candle clock");
    assert.deepEqual(chart.bars.map(({ o, h, l, c }) => ({ o, h, l, c })), candles.map(({ o, h, l, c }) => ({ o, h, l, c })));
  }
  const explicit = atlasGenxChart(genx({ mode: "quick", candles_tf: "15min" }));
  assert.equal(explicit.tfLabel, "15M", "explicit candle provenance takes precedence over the legacy slot mapping");
  assert.equal(explicit.tfMs, 900_000);
  for (const candles_tf of ["", "unknown", "__proto__", { toString: 0 }] as unknown[]) {
    const chart = atlasGenxChart(genx({ candles_tf: candles_tf as string }));
    assert.equal(chart.tfLabel, "Saved candles");
    assert.equal(chart.tfMs, 0);
  }
  for (const mode of ["unknown", "", "__proto__"]) assert.equal(atlasGenxChart(genx({ mode })).tfLabel, "Saved candles");
});

test("new and legacy restored GENX reads retain their own exact candles, levels, mode and chart identity", () => {
  for (const extra of [{}, { candles_tf: "5min" }]) {
    const result = genx(extra);
    const restored = restoreAtlasSignalResult(JSON.parse(JSON.stringify({ kind: "genx", result, saved: "synced" })))!;
    assert.equal(restored.kind, "genx");
    if (restored.kind !== "genx") continue;
    assert.deepEqual(atlasGenxChart(restored.result), atlasGenxChart(result));
    assert.equal(restored.result.genx.action, "WAIT_FOR_SELL_TRIGGER");
  }
  const restoredWithoutCandles = restoreAtlasSignalResult({ kind: "genx", result: genx({ candles: undefined }), saved: "synced" })!;
  assert.equal(restoredWithoutCandles.kind, "genx");
  if (restoredWithoutCandles.kind === "genx") assert.deepEqual(atlasGenxChart(restoredWithoutCandles.result).bars, []);
});

test("GENX waiting, limit and stop setups keep every exact trade annotation unconfirmed and preserve the actual entry zone", () => {
  for (const action of ["WAIT_FOR_SELL_TRIGGER", "WAIT_FOR_BUY_TRIGGER", "SELL_LIMIT", "BUY_LIMIT", "SELL_STOP", "BUY_STOP"]) {
    const result = genx({}, { action }), before = JSON.stringify(result), chart = atlasGenxChart(result);
    assert.equal(chart.reference, true);
    assert.deepEqual(chart.levels, [
      { kind: "entry", price: 3507, label: "Reference entry" },
      { kind: "stop", price: 3514, label: "Reference stop" },
      { kind: "target", price: 3495, label: "Reference target 1" },
      { kind: "target", price: 3488, label: "Reference target 2" },
      { kind: "target", price: 3480, label: "Reference target 3" },
    ]);
    assert.deepEqual(chart.zone, { low: 3506, high: 3508 });
    assert.equal(JSON.stringify(result), before, "the chart never promotes or adjusts the engine's saved setup");
  }
});

test("GENX BUY_NOW and SELL_NOW retain confirmed read labels without changing execution state or source prices", () => {
  for (const action of ["BUY_NOW", "SELL_NOW"]) {
    const read = action === "BUY_NOW" ? { entry: 3500, entry_low: 3499, entry_high: 3501, stop_loss: 3490, tp1: 3510, tp2: 3520, tp3: 3530 } : {};
    const result = genx({}, { action, lifecycle: "active", ...read }), before = JSON.stringify(result), chart = atlasGenxChart(result);
    assert.equal(chart.reference, false);
    assert.deepEqual(chart.levels.map((l) => l.label), ["Entry", "Stop", "Target 1", "Target 2", "Target 3"]);
    assert.deepEqual(chart.levels.map((l) => l.price), [result.genx.entry, result.genx.stop_loss, result.genx.tp1, result.genx.tp2, result.genx.tp3]);
    assert.equal(chart.price, result.price);
    assert.equal(JSON.stringify(result), before);
  }
});

test("GENX HOLD and unknown actions show real market structure without turning directional bias or stored levels into a trade", () => {
  for (const action of ["HOLD", "NO_TRADE", "WAIT", "unknown", ""]) {
    const chart = atlasGenxChart(genx({}, { action, closest_support: 3498, closest_resistance: 3510 }));
    assert.equal(chart.bars.length, 2);
    assert.equal(chart.reference, false);
    assert.deepEqual(chart.levels, [{ kind: "support", price: 3498, label: "Support" }, { kind: "resistance", price: 3510, label: "Resistance" }]);
    assert.equal(chart.zone, null);
  }
});

test("GENX malformed candles and timestamps are dropped safely, missing history remains unavailable, and retained arrays stay bounded", () => {
  const raw = [null, 8, [], { ...candles[0], t: { toString: 0 } }, { ...candles[0], t: "invalid" },
    { ...candles[0], o: "3500" }, { ...candles[0], h: 3400 }, { ...candles[0], c: Infinity }, candles[1], candles[0], { ...candles[1], c: 3507 }];
  const chart = atlasGenxChart(genx({ candles: raw as unknown as AtlasGenxResult["candles"] }));
  assert.equal(chart.bars.length, 2);
  assert.ok(chart.bars[0].t < chart.bars[1].t);
  assert.equal(chart.bars[1].c, 3507);
  for (const missing of [undefined, null, "damaged", []]) {
    assert.equal(atlasGenxChart(genx({ candles: missing as AtlasGenxResult["candles"] })).bars.length, 0);
  }
  const long = Array.from({ length: 800 }, (_, i) => ({ ...candles[0], t: new Date(1_800_000_000_000 + i * 300_000).toISOString() }));
  const bounded = atlasGenxChart(genx({ candles: long }));
  assert.equal(bounded.bars.length, 500);
  assert.equal(bounded.bars[0].t, Date.parse(long[300].t));
  assert.equal(long.length, 800);
});

test("GENX discards damaged optional levels or zones and uses only a saved quote or a real final candle for price", () => {
  const result = genx();
  const broken = {
    ...result, price: Infinity,
    genx: { ...result.genx, entry: NaN, stop_loss: Infinity, tp1: null, tp2: "3488", tp3: {}, closest_support: NaN, closest_resistance: "3510", entry_low: 3508, entry_high: 3506 },
  } as unknown as AtlasGenxResult;
  const chart = atlasGenxChart(broken);
  assert.deepEqual(chart.levels, []);
  assert.equal(chart.zone, null);
  assert.equal(chart.price, 3506);
  assert.equal(atlasGenxChart({ ...broken, candles: [] }).price, null, "entry or target cannot be substituted for a market price");
  for (const [low, high] of [[null, 3508], [3506, null], [3506, 3506], [3508, 3506], [NaN, 3508], [3506, Infinity], ["3506", 3508]]) {
    assert.equal(atlasGenxChart({ ...result, genx: { ...result.genx, entry_low: low, entry_high: high } } as AtlasGenxResult).zone, null);
  }
});

test("GENX chart views stay separate across saved ids, modes, frames and unsaved analysis times", () => {
  const base = atlasGenxChart(genx()).viewKey;
  for (const extra of [{ signal_id: "another-read" }, { mode: "swing" }, { candles_tf: "15min" }, { asOf: "2026-11-20T12:00:00Z" }]) {
    assert.notEqual(atlasGenxChart(genx(extra)).viewKey, base);
  }
  assert.notEqual(atlasGenxChart(genx({ signal_id: null })).viewKey, atlasGenxChart(genx({ signal_id: null, asOf: "2026-11-20T12:00:00Z" })).viewKey);
});
