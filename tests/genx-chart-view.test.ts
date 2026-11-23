import { test } from "node:test";
import assert from "node:assert/strict";
import { genxChartView } from "../src/lib/genx/chartView";

const own = [
  { t: "2026-11-20 09:00:00", o: 2600, h: 2608, l: 2598, c: 2605 },
  { t: "2026-11-20 10:00:00", o: 2605, h: 2610, l: 2602, c: 2607 },
];
const live = [
  { t: "2026-11-22T15:00:00Z", o: 2700, h: 2708, l: 2698, c: 2705 },
  { t: "2026-11-22T15:05:00Z", o: 2705, h: 2710, l: 2702, c: 2707 },
];
const input = {
  mode: "quick", hasRead: true, saved: true, savedMode: "swing", readMode: "swing",
  readCandles: own, readPrice: 2606, liveCandles: live, livePrice: 2709, liveTimezone: "UTC",
};

test("a reopened GENX read uses its recorded candles, quote and interval despite a current market response", () => {
  const before = JSON.stringify(input), view = genxChartView(input);
  assert.equal(view.source, "saved");
  assert.equal(view.snapshot, true);
  assert.equal(view.price, 2606);
  assert.equal(view.tf.ms, 3_600_000);
  assert.equal(view.tf.label, "1h");
  assert.equal(view.timeKnown, false, "UTC on the current market never labels a saved feed clock");
  assert.deepEqual(view.bars.map(({ o, h, l, c }) => ({ o, h, l, c })), own.map(({ o, h, l, c }) => ({ o, h, l, c })));
  assert.equal(JSON.stringify(input), before);
});

test("legacy saved reads without candles never borrow today's chart or today's quote", () => {
  const view = genxChartView({ ...input, readCandles: undefined });
  assert.equal(view.source, "missing_saved");
  assert.equal(view.bars.length, 0);
  assert.equal(view.price, input.readPrice);
  assert.equal(view.snapshot, true);
  assert.equal(genxChartView({ ...input, readCandles: [], readPrice: undefined }).price, null);
});

test("the ordinary workstation keeps the current free candles and their explicit UTC clock", () => {
  const view = genxChartView({ ...input, saved: false, hasRead: false });
  assert.equal(view.source, "current");
  assert.equal(view.snapshot, false);
  assert.equal(view.price, 2709);
  assert.equal(view.tf.label, "5m");
  assert.equal(view.timeKnown, true);
  assert.deepEqual(view.bars.map((bar) => bar.c), live.map((bar) => bar.c));
});

test("a generated read keeps its own candles and interval after current prices or the horizon selector change", () => {
  const view = genxChartView({ ...input, saved: false, mode: "intraday", readMode: "quick" });
  assert.equal(view.source, "read");
  assert.equal(view.snapshot, true);
  assert.equal(view.tf.ms, 300_000);
  assert.equal(view.price, 2606);
  assert.deepEqual(view.bars.map((bar) => bar.c), own.map((bar) => bar.c));
  assert.equal(view.timeKnown, false);
  assert.equal(genxChartView({ ...input, readMode: undefined, savedMode: "intraday" }).tf.ms, 900_000);
});

test("a generated read with missing candles does not turn today's market into its snapshot", () => {
  const view = genxChartView({ ...input, saved: false, readCandles: [] });
  assert.equal(view.source, "missing_read");
  assert.equal(view.snapshot, true);
  assert.equal(view.bars.length, 0);
  assert.equal(view.price, 2606);
});

test("explicit recorded intervals take precedence and unknown metadata never invents an hour", () => {
  assert.equal(genxChartView({ ...input, readInterval: "15min" }).tf.ms, 900_000);
  const invalid = genxChartView({ ...input, readInterval: "unknown" });
  assert.equal(invalid.tf.ms, 0);
  assert.equal(invalid.tf.label, "Saved candles");
  assert.equal(genxChartView({ ...input, readMode: "legacy", savedMode: undefined }).tf.ms, 0);
});

test("malformed stored bars are discarded without altering valid OHLC or coercing objects", () => {
  const raw = [own[1], { ...own[0], t: { toString() { throw new Error("unsafe timestamp"); } } },
    { ...own[0], h: 2500 }, own[0], { ...own[1], c: 2608 }];
  const view = genxChartView({ ...input, readCandles: raw, readPrice: NaN });
  assert.equal(view.bars.length, 2);
  assert.ok(view.bars[0].t < view.bars[1].t);
  assert.equal(view.bars[0].h, own[0].h);
  assert.equal(view.bars[1].c, 2608);
  assert.equal(view.price, 2608, "only an actual saved close may stand in for a missing saved quote");
  assert.equal(view.priceFrom, "candle");
});
