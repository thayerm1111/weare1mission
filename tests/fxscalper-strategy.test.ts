import test from "node:test";
import assert from "node:assert/strict";
import { atrWilder, ema, sma, stochastic } from "../src/lib/fxscalper/indicators";
import { aggregateM5, evaluate, warmupNeeds, type Bar } from "../src/lib/fxscalper/strategy";
import { DEFAULT_SETTINGS } from "../src/lib/fxscalper/settings";

/**
 * FX Scalper: the indicator arithmetic and the seven entry rules, on hand-built candles. These check
 * that the code does what the owner specified; they say nothing about whether the strategy makes money.
 */

const S = DEFAULT_SETTINGS.strategy;
const t0 = Date.UTC(2026, 9, 20, 8, 0);

/** A long steady trend (dir), a pullback of `pull` candles, then one signal candle. */
function build(dir: 1 | -1, pull = 5, pullStep = 0.0001, sigMove = 0.0004): Bar[] {
  const bars: Bar[] = [];
  let c = 1.1;
  for (let i = 0; i < 1500; i++) {
    const o = c;
    c = o + dir * 0.00002;
    bars.push({ t: t0 + i * 60_000, o, h: Math.max(o, c) + 0.00003, l: Math.min(o, c) - 0.00003, c });
  }
  for (let i = 0; i < pull; i++) {
    const o = c;
    c = o - dir * pullStep;
    bars.push({ t: t0 + bars.length * 60_000, o, h: Math.max(o, c) + 0.00001, l: Math.min(o, c) - 0.00001, c });
  }
  const o = c;
  c = o + dir * sigMove;
  bars.push({ t: t0 + bars.length * 60_000, o, h: Math.max(o, c) + 0.00001, l: Math.min(o, c) - 0.00001, c });
  return bars;
}

test("EMA is seeded with the simple average, then 2/(n+1) smoothing", () => {
  const e = ema([1, 2, 3, 4, 5, 6], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.equal(e[2], 2);                    // (1+2+3)/3
  assert.equal(e[3], 2 + 0.5 * (4 - 2));    // α = 2/(3+1) = 0.5
  assert.equal(e[4], 3 + 0.5 * (5 - 3));
});

test("SMA is null while any value in its window is null", () => {
  assert.deepEqual(sma([null, 1, 2, 3], 2), [null, null, 1.5, 2.5]);
});

test("Stochastic: raw %K over the last 5 candles (current included), slow %K = SMA3, %D = SMA3 of slow %K", () => {
  const high = [10, 11, 12, 13, 14, 15, 16, 17, 18];
  const low = [9, 10, 11, 12, 13, 14, 15, 16, 17];
  const close = [9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5];
  const st = stochastic(high, low, close, 5, 3, 3);
  // Candle 4: highest 14, lowest 9 → (13.5 − 9) / 5 × 100 = 90.
  assert.equal(st.raw[4], 90);
  assert.equal(st.k[6], 90);
  assert.equal(st.d[8], 90);
  assert.equal(st.k[5], null, "slow %K needs three raw values");
});

test("Stochastic: a flat window (highest = lowest) gives no value, so no signal can use it", () => {
  const flat = [1, 1, 1, 1, 1, 1, 1, 1];
  const st = stochastic(flat, flat, flat, 5, 3, 3);
  assert.ok(st.raw.every((v) => v === null));
  assert.ok(st.k.every((v) => v === null));
});

test("ATR is Wilder's: first = average true range, then (prev × 13 + TR) / 14", () => {
  const n = 20;
  const high = Array.from({ length: n }, (_, i) => 1 + i * 0.001 + 0.002);
  const low = Array.from({ length: n }, (_, i) => 1 + i * 0.001);
  const close = Array.from({ length: n }, (_, i) => 1 + i * 0.001 + 0.001);
  const atr = atrWilder(high, low, close, 14);
  assert.equal(atr[12], null);
  // Every true range here is max(0.002, |h − prevC| = 0.002, |l − prevC| = 0) = 0.002.
  assert.ok(Math.abs((atr[13] as number) - 0.002) < 1e-12);
  assert.ok(Math.abs((atr[19] as number) - 0.002) < 1e-12);
});

test("5-minute candles are built from 1-minute candles, completed windows only", () => {
  const m1: Bar[] = Array.from({ length: 12 }, (_, i) => ({ t: t0 + i * 60_000, o: 1 + i, h: 2 + i, l: i, c: 1.5 + i }));
  const closeT = t0 + 12 * 60_000;
  const m5 = aggregateM5(m1, closeT);
  assert.equal(m5.length, 2, "the third window (minutes 10–11) has not closed");
  assert.deepEqual(m5[0], { t: t0, o: 1, h: 6, l: 0, c: 5.5 });
  assert.equal(m5[1].c, 10.5);
});

test("BUY: every rule met on a trend, a pullback into the EMA band and a bullish Stochastic cross", () => {
  const e = evaluate(build(1), S);
  assert.equal(e.status, "signal");
  assert.equal(e.side, "buy");
  assert.ok(Object.values(e.buy).every(Boolean));
  assert.ok((e.values.kPrev as number) <= 20 && (e.values.k as number) > 20, "slow %K crossed up through 20");
  assert.ok((e.values.k as number) > (e.values.d as number));
});

test("SELL is the mirror", () => {
  const e = evaluate(build(-1), S);
  assert.equal(e.status, "signal");
  assert.equal(e.side, "sell");
  assert.ok(Object.values(e.sell).every(Boolean));
  assert.ok((e.values.kPrev as number) >= 80 && (e.values.k as number) < 80);
});

test("each rule matters: break one and there is no signal", () => {
  // 7. A bearish signal candle (closes below its open) — no BUY.
  const bars = build(1);
  const last = bars[bars.length - 1];
  bars[bars.length - 1] = { ...last, o: last.c + 0.00001, h: last.c + 0.00002 };
  const e = evaluate(bars, S);
  assert.notEqual(e.status, "signal");
  assert.equal(e.buy.candle, false);

  // 5. No Stochastic cross: the signal candle too weak to lift slow %K over 20.
  const weak = evaluate(build(1, 5, 0.0001, 0.00004), S);
  assert.notEqual(weak.status, "signal");
  assert.equal(weak.buy.stochCross, false);

  // 4. A pullback too shallow to reach the EMA50–EMA100 band.
  const shallow = evaluate(build(1, 2, 0.00001, 0.0004), S);
  assert.notEqual(shallow.status, "signal");
});

test("a higher timeframe pointing the other way blocks the entry", () => {
  // The trend leg is down for the last 2 hours: M5 EMA20 falls below EMA50 and is no longer rising.
  const bars = build(1);
  const n = bars.length;
  let c = bars[n - 1].c;
  const tail: Bar[] = [];
  for (let i = 0; i < 120; i++) {
    const o = c;
    c = o - 0.00006;
    tail.push({ t: bars[n - 1].t + (i + 1) * 60_000, o, h: o + 0.00002, l: c - 0.00002, c });
  }
  const e = evaluate([...bars, ...tail], S);
  assert.notEqual(e.side, "buy");
  assert.equal(e.buy.m5Trend && e.buy.m5Slope && e.buy.m1Trend, false);
});

test("missing minutes in the recent candles: no signal (the 'previous candle' would mean something else)", () => {
  const bars = build(1);
  const gapped = [...bars.slice(0, -3), ...bars.slice(-2).map((b) => ({ ...b }))];
  const e = evaluate(gapped, S);
  assert.equal(e.status, "gap");
});

test("not enough history: warming up, no signal", () => {
  const need = warmupNeeds(S);
  assert.ok(need.m1 >= 300 && need.m5 >= 150);
  const e = evaluate(build(1).slice(-200), S);
  assert.equal(e.status, "warming_up");
});

test("the same candles always give the same answer", () => {
  const a = evaluate(build(1), S);
  const b = evaluate(build(1), S);
  assert.deepEqual(a, b);
});
