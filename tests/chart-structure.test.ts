import test from "node:test";
import assert from "node:assert/strict";
import { candleInSessionBreak, priceBand, validStructureZone } from "../src/lib/chart/structure";
import { isOpen } from "../src/lib/cashtrap/marketHours";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const metal = (at: number) => isOpen("metal", at);
const fx = (at: number) => isOpen("fx", at);

test("structural bands retain exact price bounds while clipping at either edge", () => {
  assert.deepEqual(priceBand(104, 106, 100, 110, 300), { top: 120, height: 60 });
  assert.deepEqual(priceBand(108, 112, 100, 110, 300), { top: 0, height: 60 });
  assert.deepEqual(priceBand(98, 102, 100, 110, 300), { top: 240, height: 60 });
  assert.deepEqual(priceBand(98, 112, 100, 110, 300), { top: 0, height: 300 });
  // Moving the price viewport projects the same data; it cannot turn the zone into a different price range.
  assert.deepEqual(priceBand(104, 106, 102, 112, 300), { top: 180, height: 60 });
  const thin = priceBand(104, 104.001, 100, 110, 300)!;
  assert.ok(Math.abs(thin.height - 0.03) < 1e-9, "subpixel zones are not inflated to decorative minimum heights");
});

test("invalid, inverted, zero-width and offscreen zones are not fabricated", () => {
  for (const [low, high] of [[0, 100], [106, 104], [104, 104], [NaN, 106], [104, Infinity], [98, 100], [110, 112]]) {
    assert.equal(priceBand(low, high, 100, 110, 300), null);
  }
  assert.equal(priceBand(104, 106, 100, 100, 300), null);
  assert.equal(priceBand(104, 106, 100, 110, 0), null);
  const zone = Object.freeze({ low: 104, high: 106, kind: "support" as const });
  assert.equal(validStructureZone(zone), true);
  assert.equal(validStructureZone({ ...zone, kind: "entry" as never }), false);
  assert.equal(validStructureZone({ ...zone, low: 108 }), false);
  assert.deepEqual(zone, { low: 104, high: 106, kind: "support" });
});

test("only a complete gold session-break interval is shaded", () => {
  // Tuesday 17:00–18:00 New York, after the autumn DST change.
  const close = Date.parse("2026-11-24T22:00:00Z");
  assert.equal(candleInSessionBreak(close, 5 * MINUTE, metal), true);
  assert.equal(candleInSessionBreak(close + 30 * MINUTE, 15 * MINUTE, metal), true);
  assert.equal(candleInSessionBreak(close, HOUR, metal), true, "the reopening boundary belongs to the next candle");
  assert.equal(candleInSessionBreak(close - MINUTE, 5 * MINUTE, metal), false);
  assert.equal(candleInSessionBreak(close + 58 * MINUTE, 5 * MINUTE, metal), false);
  assert.equal(candleInSessionBreak(close, 4 * HOUR, metal), false, "a 4h candle starting closed later trades");
  assert.equal(candleInSessionBreak(close + 30 * MINUTE, DAY, metal), false, "a daily candle can start and end closed but trade in between");
});

test("weekend intervals and reopenings honor each calendar and New York DST", () => {
  const saturday = Date.parse("2026-11-28T05:00:00Z");
  assert.equal(candleInSessionBreak(saturday, DAY, metal), true);
  assert.equal(candleInSessionBreak(saturday, DAY, fx), true);
  for (const sunday17 of ["2026-03-08T21:00:00Z", "2026-11-01T22:00:00Z"]) {
    const at = Date.parse(sunday17);
    assert.equal(candleInSessionBreak(at, HOUR, metal), true, "gold reopens an hour after FX");
    assert.equal(candleInSessionBreak(at, HOUR, fx), false);
    assert.equal(candleInSessionBreak(at, 4 * HOUR, metal), false);
    assert.equal(candleInSessionBreak(at - 22 * HOUR, DAY, metal), false, "a Sunday daily bar includes the reopening");
  }
});

test("session checks stay bounded and do not assert closures for unsupported intervals", () => {
  let calls = 0;
  const closed = () => { calls++; return false; };
  assert.equal(candleInSessionBreak(0, DAY, closed), true);
  assert.ok(calls <= 290);
  for (const [at, duration] of [[NaN, HOUR], [0, NaN], [0, 0], [0, -HOUR], [0, 7 * DAY], [9e15, HOUR]]) {
    calls = 0;
    assert.equal(candleInSessionBreak(at, duration, closed), false);
    assert.equal(calls, 0);
  }
});
