import test from "node:test";
import assert from "node:assert/strict";
import { atlasPlayChart } from "../src/lib/atlas/chart";
import { atlasPlayResult, restoreAtlasSignalResult } from "../src/lib/atlas/signals";
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
