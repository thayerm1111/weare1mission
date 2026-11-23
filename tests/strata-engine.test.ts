import test from "node:test";
import assert from "node:assert/strict";
import { validBars, completedBars, pivotsOf, analyzePriceAction, type Bar } from "../src/lib/strata/engine";
import { readFileSync } from "node:fs";

const base = Date.parse("2026-11-20T00:00:00.000Z");
const candle = (i: number, close: number, span = .7, tf = 900_000): Bar => ({
  t: base + i * tf, o: close - .12, h: close + span, l: close - span, c: close,
});
test("STRATA rejects malformed OHLC, sorts candles and keeps only the latest duplicate stamp", () => {
  const earlier = candle(0, 3500);
  const later = candle(1, 3501);
  const duplicate = { ...later, c: 3501.2 };
  const invalid = { ...candle(2, 3502), h: 3400 };
  assert.deepEqual(validBars([later,invalid,earlier,duplicate]), [earlier,duplicate]);
});
test("STRATA never evaluates unfinished candles as confirmed", () => {
  const rows = [candle(0, 3500), candle(1, 3501), candle(2, 3502)];
  assert.equal(completedBars(rows, 900_000, base + 2*900_000 + 500).length, 1);
  assert.equal(completedBars(rows, 900_000, base + 3*900_000 + 1500).length, 3);
});
test("STRATA pivots require two fully confirmed candles on both sides", () => {
  const values = [3498, 3499, 3506, 3499, 3498, 3499, 3497];
  const bars = values.map((v,i) => candle(i,v,.1));
  assert.equal(pivotsOf(bars.slice(0,4)).filter((p)=>p.side==="high").length, 0);
  const high = pivotsOf(bars).find((p)=>p.side==="high");
  assert.equal(high?.index, 2);
  assert.equal(high?.price, 3506.1);
});
test("STRATA does not generate a trade from insufficient market history", () => {
  assert.equal(analyzePriceAction({
    m5: [candle(0,3500)],m15: [],h1: [],h4: [],
    now: base + 4*900_000,open:true,
  }), null);
});
test("range read is based on repeated edges, not a forced bullish or bearish trend", () => {
  const make=(n:number,tf:number,amplitude:number,cycle:number) =>
    Array.from({length:n},(_,i)=>candle(i,3500+amplitude*Math.sin(2*Math.PI*i/cycle),.7,tf));
  const m5=make(200,300_000,3,23);
  const m15=make(190,900_000,6.5,16);
  const h1=make(125,3_600_000,1.7,11);
  const h4=make(85,14_400_000,1.5,16);
  const actual = analyzePriceAction({
    m5,m15,h1,h4,now:base+191*900_000,open:true,
  });
  assert.ok(actual);
  assert.ok(["range","transition"].includes(actual.regime));
  if (actual.regime === "range") {
    assert.equal(actual.primary?.type, "range_fade");
    assert.equal(actual.secondary?.type, "range_fade");
    assert.notEqual(actual.primary?.side, actual.secondary?.side);
  } else {
    assert.equal(actual.primary,null);
    assert.equal(actual.status,"NO_SETUP");
  }
});
test("paper automation does not import execution functions or change broker permissions", () => {
  const worker=readFileSync("worker/strata.ts","utf8");
  assert.match(worker,/strata_paper_positions/);
  assert.doesNotMatch(worker,/from ["']@\/lib\/flow\/executor/);
  assert.doesNotMatch(worker,/placeMarketOrder\s*\(|placeOnActiveAccounts\s*\(|placeFixedLotFollower\s*\(/);
  assert.doesNotMatch(worker,/autotrade_enabled\s*:\s*true/);
  const policy=readFileSync("src/lib/flow/automationPolicy.ts","utf8");
  assert.match(policy,/return source === 'genx'/);
});
