import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGate } from "../src/lib/genx/qualityGate";
import { chochOfBars } from "../src/lib/genx/choch";
import { structuralStop as goldStructuralStop } from "../src/lib/flow/sizing";
import { readFileSync } from "node:fs";
import { noiseRoomFromBars, GOLD_NOISE_FALLBACK, GOLD_NOISE_MULT } from "../src/lib/flow/autoExec";
import { PAIRS, type FxPair } from "../src/lib/genfx/pairs";
import {
  stopSane, qualityGate, slopeFrom15m, chasedAt, noiseRoom, structuralStop, stopWideEnough, fxChoch, chochBlocks,
  fxLossEvents, fxBreaker, judgeSignal, MIN_RR, BREAKER_LOSSES, type Market, type Signal, type StopRow,
} from "../src/lib/genfx/guards";
import { rng } from "./_genfx_fixture";

/*
 * The checks between "the scanner says enter" and "an order leaves". As in genfx-decide: on a pair
 * whose unit is $1 each must agree with gold's own function; on the real pairs the numbers are pips.
 */
const GOLDISH: FxPair = { ...PAIRS.EURUSD, pip: 0.1, dec: 2, unit: 1 };
const E = PAIRS.EURUSD, J = PAIRS.GBPJPY;

test("quality gate: gold's verdict on gold's numbers, wherever gold's 100-pip stop cap is not in play", () => {
  const r = rng(21);
  let n = 0; const verdicts = new Set<string>();
  for (let i = 0; i < 900; i++) {
    const side = r() < 0.5 ? "buy" : "sell";
    const mid = 4300 + r() * 60, w = 0.5 + r() * 3;
    const entryLow = +(mid - w / 2).toFixed(2), entryHigh = +(mid + w / 2).toFixed(2);
    const risk = 2 + r() * 6;                                    // stop within $9 of the worst fill: the cap never binds
    const stop = +(side === "sell" ? entryLow - 1 + risk : entryHigh + 1 - risk).toFixed(2);
    const tp = +(side === "sell" ? entryLow - risk * (0.5 + r() * 2.5) : entryHigh + risk * (0.5 + r() * 2.5)).toFixed(2);
    const slope = r() < 0.15 ? null : +((r() - 0.5) * 8).toFixed(2);
    const o = { side: side as "buy" | "sell", entryLow, entryHigh, stop, tp, slope };
    const fx = qualityGate(GOLDISH, o), gx = decideGate({ ...o, minSlope: 1, minRr: 1 });
    assert.equal(fx.ok, gx.ok, JSON.stringify(o));
    if (fx.rr != null || gx.rr != null) assert.ok(Math.abs((fx.rr as number) - (gx.rr as number)) < 1e-9);
    verdicts.add(`${fx.ok}`); n++;
  }
  assert.equal(n, 900);
  assert.equal(verdicts.size, 2);
  assert.equal(MIN_RR, 1);
});

test("quality gate on EUR/USD: the chase is one pip and the slope one pip, said in pips", () => {
  // SELL 1.0840–1.0842, stop 1.0855, target 1.0810. Worst fill: one pip under the zone = 1.0839.
  const ok = qualityGate(E, { side: "sell", entryLow: 1.0840, entryHigh: 1.0842, stop: 1.0855, tp: 1.0810, slope: -0.0004 });
  assert.equal(ok.ok, true);
  assert.ok(Math.abs((ok.rr as number) - 29 / 16) < 1e-6);        // 29 pips of reward over 16 of risk
  // Reward under 1:1 at the worst fill.
  const thin = qualityGate(E, { side: "sell", entryLow: 1.0840, entryHigh: 1.0842, stop: 1.0855, tp: 1.0826, slope: -0.0004 });
  assert.equal(thin.ok, false);
  assert.match(thin.reason, /worst allowed fill/);
  // The 20-hour average is rising 3 pips: no selling it.
  const up = qualityGate(E, { side: "sell", entryLow: 1.0840, entryHigh: 1.0842, stop: 1.0855, tp: 1.0810, slope: 0.0003 });
  assert.equal(up.ok, false);
  assert.match(up.reason, /\+3\.0 pips in 3 hours — not falling enough/);
  // Flat (under one pip) is not a trend either.
  assert.equal(qualityGate(E, { side: "buy", entryLow: 1.0840, entryHigh: 1.0842, stop: 1.0827, tp: 1.0872, slope: 0.00005 }).ok, false);
  // Unknown slope (a page setup, or a feed gap) skips the trend half.
  assert.equal(qualityGate(E, { side: "sell", entryLow: 1.0840, entryHigh: 1.0842, stop: 1.0855, tp: 1.0810, slope: null }).ok, true);
  // GBP/JPY: the slope must be 2.5 pips.
  assert.equal(qualityGate(J, { side: "buy", entryLow: 201.40, entryHigh: 201.46, stop: 201.10, tp: 202.10, slope: 0.02 }).ok, false);
  assert.equal(qualityGate(J, { side: "buy", entryLow: 201.40, entryHigh: 201.46, stop: 201.10, tp: 202.10, slope: 0.03 }).ok, true);
});

test("the 20-hour slope from 15-minute closes", () => {
  assert.equal(slopeFrom15m(Array.from({ length: 91 }, () => 1.08)), null);                  // not enough history
  assert.ok(Math.abs(slopeFrom15m(Array.from({ length: 100 }, () => 1.08)) as number) < 1e-12);   // flat
  const rising = Array.from({ length: 100 }, (_, i) => 1.08 + i * 0.0001);                   // +1 pip a bar
  assert.ok(Math.abs((slopeFrom15m(rising) as number) - 0.0012) < 1e-9);                     // the window moved 12 bars = 12 pips
  assert.ok((slopeFrom15m(rising.slice().reverse()) as number) < 0);
  assert.equal(slopeFrom15m([...rising.slice(0, 80), NaN, 0, ...rising.slice(80, 90)]), null);   // junk is dropped, not averaged
});

test("chased: gold's rule", () => {
  // Gold's version is private to autoExec, so it cannot be called here. It has no dollars in it — the
  // rule is a ratio — and this pins the three lines GEN FX's copy is a copy of.
  const gold = readFileSync("src/lib/flow/autoExec.ts", "utf8");
  assert.match(gold, /function goldChasedAt\(side: "buy" \| "sell", stop: number \| null, tp: number \| null, lp: number \| null\): boolean \{\s+if \(stop == null \|\| tp == null \|\| lp == null\) return false;[^\n]*\n\s+if \(side === "buy" && lp >= tp\) return true;[^\n]*\n\s+if \(side === "sell" && lp <= tp\) return true;\s+const rr = rewardRisk\(lp, stop, tp\);\s+return rr != null && rr < GOLD_MIN_PLACEMENT_RR;/);
  assert.match(gold, /const GOLD_MIN_PLACEMENT_RR = 0\.8;/);
  assert.equal(chasedAt("buy", 4290, 4310, 4300), false);            // 1:1 left
  assert.equal(chasedAt("buy", 4290, 4310, 4302), true);             // 8 of reward on 12 of risk
  assert.equal(chasedAt("buy", 4290, 4310, 4310), true);
  assert.equal(chasedAt("sell", 1.0855, 1.0810, 1.0840), false);     // 2:1 left
  assert.equal(chasedAt("sell", 1.0855, 1.0810, 1.0822), true);      // 12 pips of reward on 33 of risk
  assert.equal(chasedAt("sell", 1.0855, 1.0810, 1.0809), true);      // through the target
  assert.equal(chasedAt("sell", 1.0855, 1.0810, null), false);       // no feed is not "chased"
});

test("noise room and the structural stop: gold's on gold, the pair's precision on a pair", () => {
  const r = rng(13);
  for (let i = 0; i < 200; i++) {
    const bars = Array.from({ length: Math.floor(r() * 14) }, () => { const l = 4300 + r() * 5; return { h: l + r() * 6, l }; });
    assert.equal(noiseRoom(GOLDISH, bars), noiseRoomFromBars(bars));
    const side = r() < 0.5 ? "buy" : "sell";
    const o = { side: side as "buy" | "sell", ref: +(4300 + r() * 10).toFixed(2), anchor: +(4300 + r() * 10).toFixed(2), minRoom: +(1 + r() * 7).toFixed(2) };
    assert.equal(structuralStop(GOLDISH, o), goldStructuralStop(o));
  }
  assert.equal(noiseRoom(GOLDISH, []), GOLD_NOISE_FALLBACK);
  assert.equal(GOLD_NOISE_MULT, 1.3);
  // EUR/USD: never under 4 pips; 6 with no bars to measure; 1.3 × the average bar otherwise.
  assert.ok(Math.abs(noiseRoom(E, []) - 0.0006) < 1e-12);
  assert.ok(Math.abs(noiseRoom(E, Array.from({ length: 12 }, () => ({ h: 1.0802, l: 1.0800 }))) - 0.0004) < 1e-12);
  assert.ok(Math.abs(noiseRoom(E, Array.from({ length: 12 }, () => ({ h: 1.0805, l: 1.0800 }))) - 0.00065) < 1e-12);
  assert.ok(Math.abs(noiseRoom(J, Array.from({ length: 12 }, () => ({ h: 201.05, l: 201.00 }))) - 0.1) < 1e-12);    // floor: 4 units = 10 pips
  // The strategy's stop is kept; only a fill sitting ON it gets room, pushed beyond the level.
  assert.equal(structuralStop(E, { side: "sell", ref: 1.0840, anchor: 1.0855, minRoom: 0.0006 }), 1.0855);
  assert.equal(structuralStop(E, { side: "sell", ref: 1.0853, anchor: 1.0855, minRoom: 0.0006 }), 1.0859);       // gold's 2-decimal rounding would give 1.09
  assert.equal(structuralStop(E, { side: "buy", ref: 1.0827, anchor: 1.0825, minRoom: 0.0006 }), 1.0821);
  assert.equal(structuralStop(J, { side: "buy", ref: 201.42, anchor: 201.40, minRoom: 0.1 }), 201.32);
});

test("GEN FX's own rule: a stop under the minimum is not traded", () => {
  assert.deepEqual(stopWideEnough(E, 1.0843, 1.0833, 10), { ok: true, pips: 10 });     // exactly ten is ten, whatever floating point says
  assert.deepEqual(stopWideEnough(E, 1.0843, 1.08335, 10), { ok: false, pips: 9.5 });
  assert.deepEqual(stopWideEnough(J, 201.50, 201.30, 20), { ok: true, pips: 20 });
  assert.deepEqual(stopWideEnough(J, 201.50, 201.33, 20), { ok: false, pips: 17 });
  assert.equal(PAIRS.EURUSD.minStopPips, 10);
  assert.equal(PAIRS.GBPJPY.minStopPips, 20);
});

test("a corrupt stop is refused by horizon, in units", () => {
  assert.equal(stopSane(E, "quick", 1.0840, 1.0864).ok, true);        // 24 pips ≤ 25
  assert.equal(stopSane(E, "quick", 1.0840, 1.0867).ok, false);       // 27 pips
  assert.equal(stopSane(E, "intraday", 1.0840, 1.0879).ok, true);     // 39 ≤ 40
  assert.equal(stopSane(E, "swing", 1.0840, 1.0919).ok, true);        // 79 ≤ 80
  assert.equal(stopSane(E, "swing", 1.0840, 1.0925).ok, false);
  assert.equal(stopSane(J, "quick", 201.40, 202.02).ok, true);        // 62 pips = 24.8 units
  assert.equal(stopSane(J, "quick", 201.40, 202.05).ok, false);       // 65 pips = 26 units
  assert.equal(stopSane(J, "swing", 201.40, 203.39).ok, true);        // 199 pips = 79.6 units
});

test("change of character: gold's read on gold's bars; the swing is measured in the pair's units", () => {
  const r = rng(31);
  const flips = new Set<string>();
  for (let i = 0; i < 400; i++) {
    let px = 4300; const drift = (r() - 0.5) * 1.2;
    const bars = Array.from({ length: 6 + Math.floor(r() * 26) }, (_, k) => { const turn = k > 12 ? -drift * 2.2 : drift; px += turn + (r() - 0.5) * 1.6; const h = px + r() * 1.2, l = px - r() * 1.2; return { h, l, c: l + (h - l) * r() }; });
    const a = fxChoch(GOLDISH, bars), b = chochOfBars(bars);
    assert.equal(a, b);
    flips.add(String(a));
  }
  assert.ok(flips.has("bullish") && flips.has("bearish") && flips.has("null"), [...flips].join(","));
  assert.equal(chochBlocks("sell", "bullish"), true);
  assert.equal(chochBlocks("buy", "bearish"), true);
  assert.equal(chochBlocks("buy", "bullish"), false);
  assert.equal(chochBlocks("sell", null), false);
  // The same shape of move at EUR/USD scale (÷10,000) reads the same.
  const shape = [0, -2, -4, -6, -8, -9, -7, -4, -1, 2, 4].map((d, k) => ({ h: 4300 + d + 1, l: 4300 + d - 1, c: 4300 + d + (k > 5 ? 0.8 : -0.8) }));
  const fx = shape.map((b) => ({ h: 1.08 + (b.h - 4300) * 0.0001, l: 1.08 + (b.l - 4300) * 0.0001, c: 1.08 + (b.c - 4300) * 0.0001 }));
  assert.equal(chochOfBars(shape), "bullish");
  assert.equal(fxChoch(E, fx), "bullish");
});

test("the desk breaker counts TRADES, at the pair's precision", () => {
  const at = (minAgo: number) => new Date(1_760_000_000_000 - minAgo * 60_000).toISOString();
  const now = 1_760_000_000_000;
  const row = (side: string, stop: number, minAgo: number, pips = -14): StopRow => ({ side, init_stop: stop, resolved_at: at(minAgo), result_pips: pips, partial_taken: false });
  // One call stopped out on five accounts is ONE loss.
  assert.equal(fxLossEvents(E, [row("buy", 1.08321, 50), row("buy", 1.08321, 49), row("buy", 1.08321, 48), row("buy", 1.08321, 47), row("buy", 1.08321, 46)]).length, 1);
  // Two different stops four pips apart are two trades. (Keyed to gold's two decimals they would both be "1.08".)
  assert.equal(fxLossEvents(E, [row("buy", 1.08321, 50), row("buy", 1.08361, 20)]).length, 2);
  // A scratch (under half a pip) is not a loss — nor a stop-out a banked partial pulled above that line.
  assert.equal(fxLossEvents(E, [row("buy", 1.0832, 50, -0.3), { ...row("sell", 1.0861, 40, 6), partial_taken: true }]).length, 0);
  // But one that banked a partial and still lost real money is (10-08: a partial can come without break-even).
  assert.equal(fxLossEvents(E, [{ ...row("sell", 1.0861, 40, -14), partial_taken: true }]).length, 1);
  assert.equal(fxLossEvents(J, [row("buy", 201.31, 50, -1.0)]).length, 0);     // GBP/JPY: under 1.25 pips is a scratch
  assert.equal(fxLossEvents(J, [row("buy", 201.31, 50, -1.5)]).length, 1);
  // Three inside six hours pause the pair for four hours from the last one.
  const three = [row("buy", 1.0832, 200), row("sell", 1.0861, 120), row("buy", 1.0829, 30)];
  assert.equal(BREAKER_LOSSES, 3);
  assert.equal(fxBreaker(E, three, now).paused, true);
  assert.equal(fxBreaker(E, three, now + 4 * 3600_000).paused, false);
  assert.equal(fxBreaker(E, three.slice(0, 2), now).paused, false);
  assert.equal(fxBreaker(E, [row("buy", 1.0832, 500), row("sell", 1.0861, 120), row("buy", 1.0829, 30)], now).paused, false);   // one is older than six hours
});

const SELL: Signal = { side: "sell", mode: "quick", entryLow: 1.0840, entryHigh: 1.0842, stop: 1.0855, tp: 1.0810, setup: "scanner" };
const MKT: Market = { live: 1.0841, room: 0.0006, slope: -0.0004, choch: null, breakerPaused: false, minStopPips: 10 };

test("judgeSignal: a good call passes with the levels it will be placed at", () => {
  const v = judgeSignal(E, SELL, MKT);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.ok(Math.abs(v.entry - 1.0841) < 1e-9);
  assert.equal(v.sizeEntry, 1.0841);     // sized from where the market is, not from the middle of the zone
  assert.equal(v.stop, 1.0855);          // the strategy's stop, untouched
  assert.equal(v.tp, 1.0810);
  assert.equal(v.stopPips, 14);
  assert.ok(Math.abs((v.rr as number) - 31 / 14) < 1e-6);
  // With no live price it falls back to the zone's own middle.
  const noFeed = judgeSignal(E, SELL, { ...MKT, live: null });
  assert.ok(noFeed.ok && Math.abs(noFeed.sizeEntry - 1.0841) < 1e-9);
});

test("judgeSignal: every way to say no, and the order they are checked in", () => {
  const code = (sig: Signal, m: Market) => { const v = judgeSignal(E, sig, m); return v.ok ? "ok" : v.code; };
  assert.equal(code({ ...SELL, stop: null }, MKT), "bad_levels");
  assert.equal(code({ ...SELL, tp: null }, MKT), "bad_levels");
  assert.equal(code({ ...SELL, entryLow: null, entryHigh: null }, MKT), "bad_levels");
  assert.equal(code({ ...SELL, stop: 1.0830 }, MKT), "bad_levels");                       // stop on the wrong side
  assert.equal(code({ ...SELL, tp: 1.0828 }, MKT), "quality_gate");                       // under 1:1 at the worst fill
  assert.equal(code(SELL, { ...MKT, slope: 0.0005 }), "quality_gate");                    // selling a rising average
  assert.equal(code({ ...SELL, setup: "zone" }, { ...MKT, slope: 0.0005 }), "ok");        // a page setup does not use the slope
  assert.equal(code(SELL, { ...MKT, breakerPaused: true }), "desk_breaker");
  assert.equal(code(SELL, { ...MKT, choch: "bullish" }), "change_of_character");
  assert.equal(code(SELL, { ...MKT, choch: "bearish" }), "ok");
  assert.equal(code(SELL, { ...MKT, live: 1.0856 }), "through_stop");
  assert.equal(code({ ...SELL, mode: "quick", stop: 1.0870, tp: 1.0780 }, MKT), "stop_data_insane");  // 29 pips on Quick
  assert.equal(code({ ...SELL, mode: "intraday", stop: 1.0870, tp: 1.0780 }, MKT), "ok");
  assert.equal(code({ ...SELL, stop: 1.0849, tp: 1.0820 }, MKT), "stop_too_tight");       // 8 pips
  assert.equal(code({ ...SELL, stop: 1.0849, tp: 1.0820 }, { ...MKT, minStopPips: 6 }), "ok");
  assert.equal(code(SELL, { ...MKT, live: 1.0822 }), "chased");                           // 12 pips left against 33 of risk
  // Quality comes before the breaker, the breaker before structure, structure before the stop checks.
  assert.equal(code({ ...SELL, tp: 1.0828 }, { ...MKT, breakerPaused: true, choch: "bullish" }), "quality_gate");
  assert.equal(code(SELL, { ...MKT, breakerPaused: true, choch: "bullish" }), "desk_breaker");
  assert.equal(code({ ...SELL, stop: 1.0849, tp: 1.0820 }, { ...MKT, choch: "bullish" }), "change_of_character");
});

test("judgeSignal: a fill sitting on the stop gets room beyond it, and the minimum is measured on the stop that will be placed", () => {
  // Price has run up to within 2 pips of the stop. The stop is pushed out until there are 6 pips of room…
  const v = judgeSignal(E, { ...SELL, tp: 1.0780 }, { ...MKT, live: 1.0853, minStopPips: 5 });
  assert.equal(v.ok, true);
  if (v.ok) { assert.equal(v.stop, 1.0859); assert.equal(v.stopPips, 6); }
  // …and at the normal 10-pip minimum that is still too tight to trade.
  const tight = judgeSignal(E, { ...SELL, tp: 1.0780 }, { ...MKT, live: 1.0853 });
  assert.equal(tight.ok, false);
  if (!tight.ok) { assert.equal(tight.code, "stop_too_tight"); assert.match(tight.reason, /6 pips — under the 10-pip minimum for EUR\/USD/); }
  // Every refusal carries a sentence a member can read.
  for (const m of [{ ...MKT, breakerPaused: true }, { ...MKT, choch: "bullish" as const }, { ...MKT, live: 1.0856 }, { ...MKT, live: 1.0822 }]) {
    const x = judgeSignal(E, SELL, m);
    assert.ok(!x.ok && x.reason.length > 20 && !/undefined|NaN/.test(x.reason), JSON.stringify(x));
  }
});

test("judgeSignal on GBP/JPY: twenty pips minimum, sixty-two and a half on Quick", () => {
  const buy: Signal = { side: "buy", mode: "quick", entryLow: 201.40, entryHigh: 201.46, stop: 201.20, tp: 201.95, setup: "zone" };
  const m: Market = { live: 201.44, room: 0.1, slope: null, choch: null, breakerPaused: false, minStopPips: 20 };
  const v = judgeSignal(J, buy, m);
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.stopPips, 24);
  assert.equal((judgeSignal(J, { ...buy, stop: 201.28 }, m) as { code: string }).code, "stop_too_tight");     // 16 pips
  assert.equal((judgeSignal(J, { ...buy, stop: 200.70, tp: 203.0 }, m) as { code: string }).code, "stop_data_insane");   // 73 pips on Quick
});
