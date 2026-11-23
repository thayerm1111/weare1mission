import test from "node:test";
import assert from "node:assert/strict";
import { replay } from "../command-center/engines/replay";
import { buildIdea, type BuildIdeaInput } from "../command-center/engines/idea";

const market = replay(40, false, 33);
const input = (): BuildIdeaInput => ({
  snapshot: market.snapshot, setup: market.state.setup, takeable: true, read: market.state.read,
  scenarios: market.state.scenarios, marketOpen: true, now: market.endedAt,
  bars5m: market.state.bars.map((bar) => ({ ...bar })),
});

test("Atlas keeps the original five-minute chart with its idea without sharing mutable feed objects", () => {
  const source = input();
  const result = buildIdea(source);
  const expected = source.bars5m!.filter((bar) => bar.t <= source.now).slice(-160)
    .map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
  assert.equal(result.chart?.tf, "5m");
  assert.ok(expected.length >= 5);
  assert.deepEqual(result.chart?.candles, expected);
  assert.notEqual(result.chart?.candles.at(-1), source.bars5m!.at(-1));
  source.bars5m![source.bars5m!.length - 1].c += 100;
  assert.deepEqual(result.chart?.candles, expected, "a later feed update must not change the original chart");
  const restored = JSON.parse(JSON.stringify(result));
  assert.deepEqual(restored.chart, result.chart, "the stored idea JSON keeps its exact chart");
  assert.deepEqual(restored.entry, result.entry);
  assert.deepEqual(restored.stop, result.stop);
  assert.deepEqual(restored.targets, result.targets);
});

test("an Atlas snapshot cannot contain a candle from after the idea or invalid price data", () => {
  const source = input();
  const future = { ...source.bars5m!.at(-1)!, t: source.now + 300_000 };
  // The decision receives its usual valid data. The extra bars here exercise the recording boundary.
  const emptyMarket = { ...source, snapshot: null, bars5m: [
    ...source.bars5m!, future,
    { t: source.now - 1, o: 10, h: 5, l: 9, c: 11 },
    { t: source.now - 2, o: 10, h: Infinity, l: 9, c: 11 },
  ] };
  const result = buildIdea(emptyMarket);
  assert.equal(result.kind, "stand_aside");
  assert.ok(result.chart?.candles.length);
  assert.ok(result.chart!.candles.every((bar) => bar.t <= source.now && Number.isFinite(bar.h) && bar.h >= Math.max(bar.o, bar.c)));
  assert.ok(result.chart!.candles.length <= 160);
  assert.equal(result.entry, null, "recording candles cannot create a trade plan");
  assert.equal(result.stop, null);
});

test("an Atlas read without source candles does not invent a historical chart", () => {
  const result = buildIdea({ ...input(), bars5m: [] });
  assert.equal(result.chart, undefined);
  assert.ok(result.headline);
});
