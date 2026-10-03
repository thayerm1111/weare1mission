import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { momentumBreakout, CONFIRM_IV, MOMENTUM_MAX_EXT } from "../src/lib/genxConfirm";
import { PAIRS } from "../src/lib/genfx/pairs";
import { confirmFromCandles, fxMomentumBreakout, type Candle } from "../src/lib/genfx/confirm";
import { rng } from "./_genfx_fixture";

/*
 * "Is it time to enter yet?" — GENX's closed-candle confirmation, for a pair. The last candle handed
 * in is the one still forming and must never decide anything.
 */
const E = PAIRS.EURUSD;
const k = (o: number, h: number, l: number, c: number): Candle => ({ o, h, l, c });
// A quiet drift well above a buy zone at 1.0840–1.0842 (invalidation 1.0828).
const calm = [k(1.0860, 1.0862, 1.0858, 1.0861), k(1.0861, 1.0863, 1.0859, 1.0860), k(1.0860, 1.0862, 1.0857, 1.0859), k(1.0859, 1.0861, 1.0856, 1.0858), k(1.0858, 1.0860, 1.0855, 1.0857)];
const forming = k(1.0857, 1.0858, 1.0856, 1.0857);
const buy = { side: "buy" as const, zoneLo: 1.0840, zoneHi: 1.0842, inv: 1.0828 };
const sell = { side: "sell" as const, zoneLo: 1.0840, zoneHi: 1.0842, inv: 1.0855 };

test("the breakout rule is GENX's, with the 20-cent floor as 0.2 units", () => {
  const r = rng(17);
  let hits = 0;
  for (let i = 0; i < 1500; i++) {
    const side = r() < 0.5 ? "buy" : "sell";
    const base = 4300 + r() * 20;
    const mk = () => { const o = base + (r() - 0.5) * 6, c = o + (r() - 0.5) * 5; return { o, c, h: Math.max(o, c) + r() * 1.5, l: Math.min(o, c) - r() * 1.5 }; };
    const o = { side: side as "buy" | "sell", lastClosed: mk(), priorClosed: Array.from({ length: Math.floor(r() * 5) }, mk), zoneLo: base - 1, zoneHi: base + r() * 2, inv: side === "buy" ? base - 5 : base + 6, price: base + (r() - 0.5) * 16, maxExtMult: MOMENTUM_MAX_EXT };
    const a = fxMomentumBreakout({ ...o, floor: 0.2 }), b = momentumBreakout(o);
    assert.equal(a, b);
    if (a) hits++;
  }
  assert.ok(hits > 10, `the sample must include real breakouts (saw ${hits})`);
  assert.deepEqual(CONFIRM_IV, { quick: "5min", intraday: "15min", swing: "1h" });
});

test("BUY: wait → at the zone → confirmed on a green CLOSE off it", () => {
  assert.equal(confirmFromCandles(E, { ...buy, candles: [...calm, forming], live: 1.0857 }).state, "WAIT");
  // Price dips into the zone but the last closed candle is red: at the zone, not confirmed.
  const dip = [...calm.slice(1), k(1.0857, 1.0858, 1.0841, 1.0843)];
  const at = confirmFromCandles(E, { ...buy, candles: [...dip, k(1.0843, 1.0844, 1.0841, 1.0842)], live: 1.0842 });
  assert.equal(at.state, "AT_ZONE");
  assert.equal(at.enter, null);
  // The next candle closes green with a real body, having tested the zone: BUY is live at the price of the moment.
  const turn = [...dip.slice(1), k(1.0842, 1.0849, 1.0840, 1.0848)];
  const ok = confirmFromCandles(E, { ...buy, candles: [...turn, k(1.0848, 1.0849, 1.0847, 1.08485)], live: 1.08485 });
  assert.equal(ok.state, "CONFIRMED");
  assert.equal(ok.enter, 1.08485);
  assert.match(ok.detail, /1\.08400–1\.08420/);       // prices at the pair's precision
});

test("a wick is not a confirmation, and neither is the candle still forming", () => {
  // A long lower wick into the zone that closes back where it opened: no body, no entry.
  const wick = [...calm.slice(1), k(1.0857, 1.0858, 1.0841, 1.08572)];
  assert.equal(confirmFromCandles(E, { ...buy, candles: [...wick, k(1.0857, 1.0858, 1.0856, 1.0857)], live: 1.0857 }).state, "AT_ZONE");
  // The forming candle is green and reacting — but it has not closed. The closed ones say WAIT/AT_ZONE.
  const live = confirmFromCandles(E, { ...buy, candles: [...calm, k(1.0841, 1.0850, 1.0840, 1.0849)], live: 1.0849 });
  assert.notEqual(live.state, "CONFIRMED");
});

test("a close through the invalidation ends the setup, whatever came after", () => {
  const broke = [...calm.slice(2), k(1.0857, 1.0858, 1.0825, 1.0826), k(1.0826, 1.0845, 1.0825, 1.0844)];
  const v = confirmFromCandles(E, { ...buy, candles: [...broke, k(1.0844, 1.0845, 1.0843, 1.0844)], live: 1.0844 });
  assert.equal(v.state, "INVALIDATED");
  assert.match(v.detail, /1\.08280/);
});

test("SELL mirrors BUY", () => {
  const low = [k(1.0820, 1.0822, 1.0818, 1.0819), k(1.0819, 1.0823, 1.0817, 1.0822), k(1.0822, 1.0825, 1.0820, 1.0824), k(1.0824, 1.0827, 1.0822, 1.0826), k(1.0826, 1.0829, 1.0824, 1.0828)];
  assert.equal(confirmFromCandles(E, { ...sell, candles: [...low, k(1.0828, 1.0829, 1.0827, 1.0828)], live: 1.0828 }).state, "WAIT");
  const rally = [...low.slice(1), k(1.0828, 1.0842, 1.0827, 1.0841)];
  assert.equal(confirmFromCandles(E, { ...sell, candles: [...rally, k(1.0841, 1.0842, 1.0840, 1.0841)], live: 1.0841 }).state, "AT_ZONE");
  const reject = [...rally.slice(1), k(1.0841, 1.0843, 1.0833, 1.0834)];
  const ok = confirmFromCandles(E, { ...sell, candles: [...reject, k(1.0834, 1.0835, 1.0833, 1.0834)], live: 1.0834 });
  assert.equal(ok.state, "CONFIRMED");
  assert.equal(ok.enter, 1.0834);
  const blown = [...rally.slice(1), k(1.0841, 1.0858, 1.0840, 1.0857)];
  assert.equal(confirmFromCandles(E, { ...sell, candles: [...blown, k(1.0857, 1.0858, 1.0856, 1.0857)], live: 1.0857 }).state, "INVALIDATED");
});

test("a decisive break that never came back can confirm — unless the caller turns that off", () => {
  // Price never reaches the 1.0840 zone; a strong green candle breaks to a new high within reach of it.
  const base = [k(1.0850, 1.0852, 1.0848, 1.0851), k(1.0851, 1.0853, 1.0849, 1.0850), k(1.0850, 1.0852, 1.0848, 1.0851), k(1.0851, 1.0853, 1.0849, 1.0852), k(1.0852, 1.0860, 1.0851, 1.0859)];
  const o = { ...buy, candles: [...base, k(1.0859, 1.0860, 1.0858, 1.0859)], live: 1.0859 };
  assert.equal(confirmFromCandles(E, o).state, "CONFIRMED");
  assert.match(confirmFromCandles(E, o).detail, /momentum BUY/);
  assert.equal(confirmFromCandles(E, { ...o, noMomentum: true }).state, "WAIT");
  // Too far extended from the zone: not chased.
  assert.equal(confirmFromCandles(E, { ...o, live: 1.0875 }).state, "WAIT");
});

test("too little data is said, not guessed; a swapped zone is put right", () => {
  assert.equal(confirmFromCandles(E, { ...buy, candles: calm.slice(0, 3), live: 1.0857 }).state, "NO_DATA");
  const a = confirmFromCandles(E, { ...buy, zoneLo: 1.0842, zoneHi: 1.0840, candles: [...calm, forming], live: 1.0857 });
  const b = confirmFromCandles(E, { ...buy, candles: [...calm, forming], live: 1.0857 });
  assert.deepEqual(a, b);
  // No live price: the forming candle's close stands in.
  assert.equal(confirmFromCandles(E, { ...buy, candles: [...calm, forming], live: null }).price, 1.0857);
});

test("the page, the scanner and the replay all use this one rule", () => {
  assert.match(readFileSync("src/app/api/genfx/confirm/route.ts", "utf8"), /confirmFxEntry\(/);
  assert.match(readFileSync("src/lib/genfx/scan.ts", "utf8"), /const confirm = o\.confirm \?\? confirmFxEntry,/);
  assert.match(readFileSync("src/lib/genfx/watch.ts", "utf8"), /const confirm = deps\.confirm \?\? confirmFxEntry;/);
  assert.match(readFileSync("src/lib/genfx/replay.ts", "utf8"), /confirmFromCandles\(/);
  const src = readFileSync("src/lib/genfx/confirm.ts", "utf8");
  assert.match(src, /const d = confirmFromCandles\(pair,/);      // the fetching version decides with the pure one
  assert.ok(!/XAU/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "no gold symbol in the code");
});
