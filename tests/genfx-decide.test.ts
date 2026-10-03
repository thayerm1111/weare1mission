import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGoldEntry, sameSetupZone as goldSameSetup } from "../src/lib/genx/watchTick";
import { zoneOf as goldZoneOf, zoneAction as goldZoneAction, ZONE_TOUCH_USD, ZONE_TTL_MS as GOLD_ZONE_TTL } from "../src/lib/genx/zoneSetups";
import { PAIRS, U, units, pairOf, pipsBetween, fmtPx, type FxPair } from "../src/lib/genfx/pairs";
import { oneCallPerIdea } from "../src/lib/genfx/decide";
import { byIds } from "../src/lib/genfx/db";
import { decideFxEntry, sameSetupZone, zoneOf, zoneAction, zoneBand, scanKey, zoneKey, isZoneKey, rewardRisk, throughStop, gradeCall, lastReopenMs, ENTRY_FLOOR_RR, ARM_MAX_MS, ZONE_TTL_MS, SAME_SETUP_WINDOW_MS, FORMING_TTL_MS, GRADE_EXPIRY_MS } from "../src/lib/genfx/decide";
import { inScanQuietWindow, inWeekendCloseWindow } from "../src/lib/flow/autoExec";
import { touchConfirmed, TOUCH_CONFIRM_MS, TOUCH_STALE_MS } from "../src/lib/genfx/watch";
import { rng } from "./_genfx_fixture";

/*
 * GEN FX's decisions are GENX's decisions with gold's dollars turned into the pair's units. Two kinds
 * of test: (1) with a pair whose unit is $1 — gold itself — every function must agree with GENX's on
 * the same inputs; (2) on the real pairs, the numbers must come out in pips, not in gold's digits.
 */
const GOLDISH: FxPair = { ...PAIRS.EURUSD, pip: 0.1, dec: 2, unit: 1 };
const E = PAIRS.EURUSD, J = PAIRS.GBPJPY;

test("the units table still holds GENX's numbers", () => {
  assert.equal(U.zoneTouch, ZONE_TOUCH_USD);
  assert.equal(ZONE_TTL_MS, GOLD_ZONE_TTL);
  assert.equal(units(GOLDISH, U.zoneTouch), 0.3);
  assert.ok(Math.abs(units(E, U.zoneTouch) - 0.00003) < 1e-12);      // 0.3 pips
  assert.ok(Math.abs(units(J, U.zoneTouch) - 0.0075) < 1e-12);       // 0.75 pips
  assert.ok(Math.abs(units(E, U.sameSetup) - 0.0006) < 1e-12);       // 6 pips
  assert.ok(Math.abs(units(J, U.sameSetup) - 0.15) < 1e-12);         // 15 pips
});

test("enter / arm / wait / abandon — the same answer GENX gives on a thousand gold situations, except through the stop and past an armed setup's five minutes", () => {
  const r = rng(42);
  const states = ["CONFIRMED", "WAIT", "AT_ZONE", "INVALIDATED", "NO_DATA", "BUSY"];
  let n = 0, through = 0, goldEnteredThere = 0, late = 0, goldEnteredLate = 0; const seen = new Set<string>();
  for (let i = 0; i < 1200; i++) {
    const sell = r() < 0.5;
    const mid = 4300 + r() * 80, w = r() * 4;
    const entryLow = +(mid - w / 2).toFixed(2), entryHigh = +(mid + w / 2).toFixed(2);
    const risk = 2 + r() * 9, reward = risk * (0.6 + r() * 2.6);
    const stop = +(sell ? entryHigh + risk : entryLow - risk).toFixed(2);
    const tp1 = +(sell ? entryLow - reward : entryHigh + reward).toFixed(2);
    const lp = r() < 0.05 ? null : +(mid + (r() - 0.5) * 14).toFixed(2);
    const armed = r() < 0.4;
    const nowMs = 1_760_000_000_000, armedAtMs = nowMs - Math.floor(r() * 9 * 60_000);
    const o = { armed, confState: states[Math.floor(r() * states.length)], lp, entryLow: r() < 0.03 ? null : entryLow, entryHigh, stop, tp1: r() < 0.03 ? null : tp1, armedAtMs, nowMs };
    const fx = decideFxEntry(GOLDISH, o), gold = decideGoldEntry(o);
    if (o.confState !== "INVALIDATED" && o.armed && o.nowMs - o.armedAtMs > ARM_MAX_MS) {
      // THE SECOND DIFFERENCE. An armed setup past its five minutes is let go — whatever the price says.
      // GENX asks the price first, and would enter one that qualifies however long ago it was armed.
      late++;
      if (gold.do === "enter") goldEnteredLate++;
      assert.deepEqual(fx, { do: "invalidate", reason: "arm_expired_5min" });
    } else if (o.confState !== "INVALIDATED" && throughStop(o.lp, o.stop, o.tp1, o.entryLow, o.entryHigh)) {
      // THE FIRST DIFFERENCE. With price at or beyond the stop, reward ÷ risk (taken from absolute
      // distances) reads as enormous, and GENX's rule can say "enter". GEN FX never does.
      through++;
      if (gold.do === "enter") goldEnteredThere++;
      assert.deepEqual(fx, { do: "wait", reason: "through_stop" });
    } else assert.deepEqual(fx, gold);
    seen.add(fx.do); n++;
  }
  assert.equal(n, 1200);
  assert.ok(through > 20 && goldEnteredThere > 0, `${through} situations with price through the stop; gold's rule entered ${goldEnteredThere} of them`);
  assert.ok(late > 50 && goldEnteredLate > 0, `${late} armed setups past five minutes; gold's rule entered ${goldEnteredLate} of them`);
  assert.deepEqual([...seen].sort(), ["arm", "enter", "invalidate", "wait"]);
  assert.equal(ENTRY_FLOOR_RR, 0.8);
  assert.equal(ARM_MAX_MS, 5 * 60_000);
});

test("a price at or through the stop is never an entry", () => {
  // Sell 1.0840–1.0842, stop 1.0855, target 1.0810.
  assert.equal(throughStop(1.0854, 1.0855, 1.081, 1.084, 1.0842), false);
  assert.equal(throughStop(1.0855, 1.0855, 1.081, 1.084, 1.0842), true);
  assert.equal(throughStop(1.086, 1.0855, 1.081, 1.084, 1.0842), true);
  // Buy 201.40–201.45, stop 201.10.
  assert.equal(throughStop(201.11, 201.1, 202, 201.4, 201.45), false);
  assert.equal(throughStop(201.1, 201.1, 202, 201.4, 201.45), true);
  assert.equal(throughStop(200.9, 201.1, null, 201.4, 201.45), true);          // no target: the zone says which side
  assert.equal(throughStop(null, 201.1, 202, 201.4, 201.45), false);
  assert.equal(throughStop(201.3, null, 202, 201.4, 201.45), false);
  const base = { armed: false, confState: "CONFIRMED", entryLow: 1.084, entryHigh: 1.0842, stop: 1.0855, tp1: 1.081, armedAtMs: 0, nowMs: 0 };
  // 5 pips ABOVE a sell's stop reads as "10 to 1" by distances. It is not a trade.
  assert.ok((rewardRisk(1.086, 1.0855, 1.081) as number) > 9);
  assert.deepEqual(decideFxEntry(E, { ...base, lp: 1.086 }), { do: "wait", reason: "through_stop" });
  assert.deepEqual(decideFxEntry(E, { ...base, armed: true, lp: 1.086, nowMs: 4 * 60_000 }), { do: "wait", reason: "through_stop" });
  assert.deepEqual(decideFxEntry(E, { ...base, armed: true, lp: 1.086, nowMs: 6 * 60_000 }), { do: "invalidate", reason: "arm_expired_5min" });
  assert.deepEqual(decideFxEntry(E, { ...base, confState: "INVALIDATED", lp: 1.086 }), { do: "invalidate", reason: "invalidated" });
  assert.equal(decideFxEntry(E, { ...base, lp: 1.0854 }).do, "enter");                       // just inside it: still the engine's call
});

test("on EUR/USD the zone buffer is a fifth of a pip, not twenty cents", () => {
  const base = { armed: false, confState: "CONFIRMED", entryLow: 1.0840, entryHigh: 1.0842, stop: 1.0855, tp1: 1.0810, armedAtMs: 0, nowMs: 0 };
  // In the zone (plus its small buffer): enter even if the reward is thin.
  assert.equal(decideFxEntry(E, { ...base, lp: 1.08421, tp1: 1.0835 }).do, "enter");
  // 3 pips under a sell zone with a thin reward: gold's 20-cent buffer would have called this "in the zone".
  assert.equal(decideFxEntry(E, { ...base, lp: 1.0837, tp1: 1.0835 }).do, "arm");
  // Out of the zone but the reward still clears 0.8 to 1: enter.
  assert.equal(decideFxEntry(E, { ...base, lp: 1.0837 }).do, "enter");
  assert.equal(decideFxEntry(E, { ...base, confState: "AT_ZONE", lp: 1.0841 }).do, "wait");
  assert.equal(decideFxEntry(E, { ...base, armed: true, lp: 1.0812, armedAtMs: 0, nowMs: 4 * 60_000 }).do, "wait");
  assert.equal(decideFxEntry(E, { ...base, armed: true, lp: 1.0812, armedAtMs: 0, nowMs: 6 * 60_000 }).do, "invalidate");
  // Back in the zone — a minute too late. Armed at 4:12pm, frozen through the daily close, this would otherwise be entered at 7pm.
  assert.deepEqual(decideFxEntry(E, { ...base, armed: true, lp: 1.0841, armedAtMs: 0, nowMs: 6 * 60_000 }), { do: "invalidate", reason: "arm_expired_5min" });
  assert.equal(decideFxEntry(E, { ...base, armed: true, lp: 1.0841, armedAtMs: 0, nowMs: 4 * 60_000 }).do, "enter");
});

test("a drifting zone is one setup: GENX's rule on gold, six pips on EUR/USD, fifteen on GBP/JPY", () => {
  const z = (side: "buy" | "sell", lo: number, hi: number) => ({ side, entry_low: lo, entry_high: hi });
  const r = rng(9);
  for (let i = 0; i < 600; i++) {
    const a = z(r() < 0.5 ? "buy" : "sell", +(4300 + r() * 30).toFixed(2), +(4300 + r() * 30).toFixed(2));
    const b = z(r() < 0.8 ? a.side : a.side === "buy" ? "sell" : "buy", +(4300 + r() * 30).toFixed(2), +(4300 + r() * 30).toFixed(2));
    assert.equal(sameSetupZone(GOLDISH, a, b), goldSameSetup(a, b));
  }
  assert.ok(sameSetupZone(E, z("sell", 1.0840, 1.0842), z("sell", 1.0844, 1.0846)), "4 pips apart");
  assert.ok(!sameSetupZone(E, z("sell", 1.0840, 1.0842), z("sell", 1.0849, 1.0851)), "9 pips apart");
  assert.ok(!sameSetupZone(E, z("sell", 1.0840, 1.0842), z("buy", 1.0840, 1.0842)), "other side");
  assert.ok(sameSetupZone(J, z("buy", 201.40, 201.45), z("buy", 201.52, 201.57)), "12 pips apart");
  assert.ok(!sameSetupZone(J, z("buy", 201.40, 201.45), z("buy", 201.62, 201.67)), "22 pips apart");
  assert.equal(SAME_SETUP_WINDOW_MS, 4 * 3600_000);
});

test("page setups: read the same way, entered on the same touch", () => {
  const reads = [
    { action: "WAIT_FOR_SELL_TRIGGER", entry: 4348.2, stop_loss: 4356.87, tp1: 4319.29, tp2: null, tp3: null },
    { action: "BUY_LIMIT", entry: 4338.13, stop_loss: 4332.54, tp1: 4356.77, tp2: 4360, tp3: 4371.5 },
    { action: "WAIT", entry: 4338, stop_loss: 4332, tp1: 4356 },
    { action: "SELL_NOW", entry: 4338, stop_loss: 4345, tp1: 4320 },
    { action: "WAIT_FOR_SELL_TRIGGER", entry: 4348, stop_loss: 4340, tp1: 4320 },
    { action: "BUY_LIMIT", entry: 4338, stop_loss: null, tp1: 4350 },
    { action: "wait_for_buy_trigger", entry: 4338, stop_loss: 4330, tp1: 4350 },
  ];
  for (const g of reads) assert.deepEqual(zoneOf(g), goldZoneOf(g));
  const r = rng(5);
  for (let i = 0; i < 800; i++) {
    const side = r() < 0.5 ? "buy" : "sell";
    const entry = +(4300 + r() * 40).toFixed(2), stop = +(side === "sell" ? entry + 3 + r() * 8 : entry - 3 - r() * 8).toFixed(2), lp = +(entry + (r() - 0.5) * 26).toFixed(2);
    assert.equal(zoneAction(GOLDISH, side, entry, stop, lp), goldZoneAction(side, entry, stop, lp));
  }
  // EUR/USD: a touch is within 0.3 pips of the entry.
  assert.equal(zoneAction(E, "sell", 1.0840, 1.0855, 1.08396), "wait");
  assert.equal(zoneAction(E, "sell", 1.0840, 1.0855, 1.08398), "enter");
  assert.equal(zoneAction(E, "sell", 1.0840, 1.0855, 1.0847), "enter");
  assert.equal(zoneAction(E, "sell", 1.0840, 1.0855, 1.0855), "invalidate");
  assert.equal(zoneAction(E, "buy", 1.0840, 1.0825, 1.08404), "wait");
  assert.equal(zoneAction(E, "buy", 1.0840, 1.0825, 1.08402), "enter");
  assert.equal(zoneAction(E, "buy", 1.0840, 1.0825, 1.0825), "invalidate");
  // GBP/JPY: within 0.75 pips.
  assert.equal(zoneAction(J, "buy", 201.40, 201.10, 201.409), "wait");
  assert.equal(zoneAction(J, "buy", 201.40, 201.10, 201.407), "enter");
  assert.deepEqual(zoneBand(E, 1.0840), { low: 1.08397, high: 1.08403 });
  const jb = zoneBand(J, 201.4);      // ±0.75 pips, stored at the pair's three decimals
  assert.ok(Math.abs(jb.low - 201.3925) <= 0.00051 && Math.abs(jb.high - 201.4075) <= 0.00051, JSON.stringify(jb));
});

test("keys: the pair in front, rounded in the pair's steps, and good for one day", () => {
  const t = Date.UTC(2026, 9, 5, 14, 3);
  assert.equal(scanKey(E, "quick", "sell", 1.08402, 1.08457, t), "EURUSD:quick:sell:10840:10846:20261005");
  assert.equal(scanKey(J, "swing", "buy", 201.41, 201.52, t), "GBPJPY:swing:buy:8056:8061:20261005");
  assert.equal(zoneKey(E, "intraday", "buy", 1.08432, t), "zone:EURUSD:intraday:buy:108432:20261005");
  assert.equal(zoneKey(J, "quick", "sell", 201.457, t), "zone:GBPJPY:quick:sell:80583:20261005");
  // A zone that drifts by less than a step keeps its key; a real move changes it.
  assert.equal(scanKey(E, "quick", "sell", 1.08402, 1.08457, t), scanKey(E, "quick", "sell", 1.08404, 1.08459, t));
  assert.notEqual(scanKey(E, "quick", "sell", 1.08402, 1.08457, t), scanKey(E, "quick", "sell", 1.08422, 1.08477, t));
  // The same level on another day is a new call (gold's undated key would block it forever).
  assert.notEqual(zoneKey(E, "quick", "buy", 1.08, t), zoneKey(E, "quick", "buy", 1.08, t + 24 * 3600_000));
  assert.equal(zoneKey(E, "quick", "buy", 1.08, t), zoneKey(E, "quick", "buy", 1.08, t + 3 * 3600_000));
  // Never mistaken for a gold key, and the two kinds never for each other.
  assert.ok(isZoneKey(zoneKey(E, "quick", "buy", 1.08, t)));
  assert.ok(!isZoneKey(scanKey(E, "quick", "buy", 1.08, 1.0802, t)));
  for (const k of [scanKey(E, "quick", "buy", 1.08, 1.0802, t), scanKey(J, "quick", "buy", 201, 201.1, t)]) assert.ok(!/^(quick|intraday|swing|zone):/.test(k));
});

test("small helpers", () => {
  assert.ok(Math.abs((rewardRisk(1.0840, 1.0855, 1.0810) as number) - 2) < 1e-9);
  assert.equal(rewardRisk(100, 99, 103), 3);
  assert.equal(rewardRisk(1.0840, 1.0840, 1.0810), null);
  assert.equal(rewardRisk(null, 1.0855, 1.0810), null);
  assert.equal(pairOf("eur/usd"), E);
  assert.equal(pairOf("GBP-JPY"), J);
  assert.equal(pairOf("XAUUSD"), null);
  assert.equal(pairOf(undefined), null);
  assert.equal(pipsBetween(E, 1.0843, 1.0833), 10);
  assert.equal(pipsBetween(J, 201.5, 201.27), 23);
  assert.equal(fmtPx(E, 1.0843), "1.08430");
  assert.equal(fmtPx(J, 201.4), "201.400");
  assert.equal(fmtPx(E, null), "—");
});

test("grading a call: by time, stop first, and the candle the entry fell in can stop it but not pay it", () => {
  const M5 = 300_000, t0 = Date.UTC(2026, 9, 5, 14, 0);
  const c = (i: number, h: number, l: number) => ({ t: t0 + i * M5, h, l });
  const buy = { side: "buy" as const, stop: 1.0825, tp1: 1.087, enterMs: t0 + 2 * M5 + 40_000 };      // 40 seconds into candle 2
  // Candles 0 and 1 closed before the entry: whatever they did is not this call's.
  assert.equal(gradeCall(buy, [c(0, 1.09, 1.08), c(1, 1.09, 1.08), c(2, 1.085, 1.084), c(3, 1.0855, 1.0845)], M5), null);
  // The entry candle itself reaches the target: not credited — its range includes what price did before the entry…
  assert.equal(gradeCall(buy, [c(2, 1.0875, 1.084)], M5), null);
  // …but it can stop the call.
  assert.deepEqual(gradeCall(buy, [c(2, 1.085, 1.0824)], M5), { result: "loss", at: t0 + 3 * M5 });
  // After it: target first is a win, stop first a loss, both in one candle a loss.
  assert.deepEqual(gradeCall(buy, [c(2, 1.085, 1.084), c(3, 1.0871, 1.0845)], M5), { result: "win", at: t0 + 4 * M5 });
  assert.deepEqual(gradeCall(buy, [c(2, 1.085, 1.084), c(3, 1.0855, 1.0824), c(4, 1.088, 1.085)], M5), { result: "loss", at: t0 + 4 * M5 });
  assert.deepEqual(gradeCall(buy, [c(2, 1.085, 1.084), c(3, 1.0872, 1.0822)], M5)?.result, "loss");
  // Order of arrival does not matter; the feed hands them newest-first as often as not.
  assert.deepEqual(gradeCall(buy, [c(4, 1.088, 1.085), c(3, 1.0855, 1.0824), c(2, 1.085, 1.084)], M5)?.result, "loss");
  // A weekend: the next candle is two days later and is still the first one after the entry.
  const fri = { side: "sell" as const, stop: 1.0855, tp1: 1.081, enterMs: t0 + 10_000 };
  assert.deepEqual(gradeCall(fri, [c(-300, 1.09, 1.07), c(0, 1.0845, 1.0838), { t: t0 + 2 * 86_400_000, h: 1.083, l: 1.0805 }], M5)?.result, "win");
  assert.deepEqual(gradeCall(fri, [c(0, 1.0845, 1.0838), { t: t0 + 2 * 86_400_000, h: 1.0861, l: 1.085 }], M5)?.result, "loss");     // the Sunday gap
  // An entry on the stroke of a candle's open: that candle is the entry candle.
  assert.equal(gradeCall({ ...buy, enterMs: t0 + 2 * M5 }, [c(1, 1.09, 1.08), c(2, 1.0875, 1.084)], M5), null);
  // Each horizon is given time to finish: a Swing call is not cut off at a Quick call's eight hours.
  assert.deepEqual(GRADE_EXPIRY_MS, { quick: 8 * 3600_000, intraday: 24 * 3600_000, swing: 96 * 3600_000 });
  assert.deepEqual(FORMING_TTL_MS, { quick: 8 * 3600_000, intraday: 8 * 3600_000, swing: 48 * 3600_000 });
});

test("nothing registered before the market last reopened is acted on", () => {
  const quiet = (d: Date) => inWeekendCloseWindow(d) || inScanQuietWindow(d);
  // Wednesday 2026-10-07, 14:00 New York (18:00 UTC, daylight time): entries reopened at 7pm New York on Tuesday.
  const wed = Date.UTC(2026, 9, 7, 18, 0);
  assert.equal(new Date(lastReopenMs(wed, quiet)).toISOString(), "2026-10-06T23:00:00.000Z");
  // Monday morning: they reopened on Sunday evening — a setup from Friday is from before the weekend.
  const mon = Date.UTC(2026, 9, 5, 9, 30);
  assert.equal(new Date(lastReopenMs(mon, quiet)).toISOString(), "2026-10-04T23:00:00.000Z");
  // Inside the quiet window "reopened" is still ahead, so everything registered so far is stale.
  const closing = Date.UTC(2026, 9, 7, 21, 0);
  assert.ok(quiet(new Date(closing)));
  assert.ok(lastReopenMs(closing, quiet) > closing);
  // In winter New York is an hour further from UTC, and the answer moves with it.
  assert.equal(new Date(lastReopenMs(Date.UTC(2026, 11, 9, 18, 0), quiet)).toISOString(), "2026-12-09T00:00:00.000Z");
  assert.equal(lastReopenMs(wed, () => false), 0);
});

test("a touch is two looks, not one", () => {
  const seen = new Map<string, number>();
  const t = 1_000_000;
  assert.equal(touchConfirmed(seen, "a", true, t), false);                          // first sighting
  assert.equal(touchConfirmed(seen, "a", true, t + 400), false);                    // too soon to be a second look
  assert.equal(touchConfirmed(seen, "a", true, t + TOUCH_CONFIRM_MS), true);        // a second apart: confirmed
  assert.equal(seen.has("a"), false);
  // A tick that is gone on the next pass enters nothing, and the count starts again.
  assert.equal(touchConfirmed(seen, "b", true, t), false);
  assert.equal(touchConfirmed(seen, "b", false, t + 1500), false);
  assert.equal(touchConfirmed(seen, "b", true, t + 3000), false);
  assert.equal(touchConfirmed(seen, "b", true, t + 4500), true);
  // A first sighting from long ago is not "the pass before".
  assert.equal(touchConfirmed(seen, "c", true, t), false);
  assert.equal(touchConfirmed(seen, "c", true, t + TOUCH_STALE_MS + 1), false);
  assert.equal(touchConfirmed(seen, "c", true, t + TOUCH_STALE_MS + 1 + 6000), true);     // the fallback's six-second passes still confirm
  assert.equal(TOUCH_CONFIRM_MS, 1000);
});

test("a call is graded on closed candles inside its own window — late grading is not a second chance", () => {
  const M5 = 300_000, t0 = Date.UTC(2026, 9, 6, 12, 0);
  const call = { side: "buy" as const, stop: 1.082, tp1: 1.087, enterMs: t0 };
  const c = (i: number, h: number, l: number) => ({ t: t0 + i * M5, h, l });
  const quiet = Array.from({ length: 96 }, (_, i) => c(i + 1, 1.085, 1.084));                 // eight hours of nothing
  // The target prints in the candle that starts 8h05 after the entry. Graded on time, the call had expired.
  const late = [...quiet, c(97, 1.0872, 1.0845)];
  assert.deepEqual(gradeCall(call, late, M5), { result: "win", at: t0 + 98 * M5 });           // unbounded: a win
  assert.equal(gradeCall(call, late, M5, { untilMs: t0 + GRADE_EXPIRY_MS.quick }), null);     // inside its window: nothing
  // The newest candle is still forming: it has touched the target, and may yet touch the stop. It is not read.
  const forming = [c(1, 1.085, 1.084), c(2, 1.0871, 1.0845)];
  assert.equal(gradeCall(call, forming, M5, { closedByMs: t0 + 2 * M5 + 60_000 }), null);
  assert.deepEqual(gradeCall(call, forming, M5, { closedByMs: t0 + 3 * M5 }), { result: "win", at: t0 + 3 * M5 });
});

test("one idea is counted once: a call made while another on the same setup was still running is that idea again", () => {
  const E = PAIRS.EURUSD;
  const t = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 6, h, m)).toISOString();
  const call = (id: string, enter: string, resolved: string, o: Record<string, unknown> = {}) => ({ id, mode: "quick", side: "sell" as const, entry_low: 1.08497, entry_high: 1.08503, enter_sent_at: enter, resolved_at: resolved, outcome: "win", ...o });
  // 12:00 a page setup at 1.0850 is touched; 12:10 the scanner confirms the same zone; both run to the same target at 13:00.
  const page = call("page", t(12), t(13));
  const scanner = call("scanner", t(12, 10), t(13), { entry_low: 1.0849, entry_high: 1.0851 });
  assert.deepEqual(oneCallPerIdea(E, [scanner, page]).counted.map((c) => c.id), ["page"]);       // the earlier one is the one counted, whatever order they arrive in
  assert.equal(oneCallPerIdea(E, [scanner, page]).repeats, 1);
  // A call made AFTER the first had finished is a new trade at the level: counted.
  const again = call("again", t(13, 5), t(14));
  assert.deepEqual(oneCallPerIdea(E, [page, scanner, again]).counted.map((c) => c.id), ["page", "again"]);
  // Another horizon, the other side, a level nine pips away: their own ideas, however much they overlap.
  for (const o of [{ mode: "intraday" }, { side: "buy" }, { entry_low: 1.0858, entry_high: 1.086 }]) {
    assert.equal(oneCallPerIdea(E, [page, call("x", t(12, 10), t(13), o)]).repeats, 0, JSON.stringify(o));
  }
  // A repeat of a repeat is still one idea; a call with no entry time cannot be placed in time, and is counted.
  assert.equal(oneCallPerIdea(E, [page, scanner, call("third", t(12, 20), t(13))]).repeats, 2);
  assert.equal(oneCallPerIdea(E, [page, call("undated", null as never, t(13))]).counted.length, 2);
  assert.deepEqual(oneCallPerIdea(E, []), { counted: [], repeats: 0 });
});

test("a long list of ids is asked for a hundred at a time, and part of an answer is not the answer", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
  const asked: number[] = [];
  const all = await byIds<{ id: string }>(ids, async (chunk) => { asked.push(chunk.length); return { data: chunk.map((id) => ({ id })), error: null }; });
  assert.deepEqual([asked, all.ok, all.rows.length], [[100, 100, 50], true, 250]);
  // The same id twice is asked for once.
  assert.equal((await byIds(["a", "a", "b"], async (chunk) => ({ data: chunk, error: null }))).rows.length, 2);
  // One part fails — returned as an error, thrown, or not a list: the whole answer is marked not ok.
  let n = 0;
  assert.equal((await byIds(ids, async (chunk) => (++n === 2 ? { data: null, error: { message: "414" } } : { data: chunk, error: null }))).ok, false);
  assert.equal((await byIds(ids, async () => { throw new Error("socket"); })).ok, false);
  assert.equal((await byIds(ids, async () => ({ data: null, error: null }))).ok, false);
  assert.deepEqual(await byIds([], async () => { throw new Error("never asked"); }), { rows: [], ok: true });
});
