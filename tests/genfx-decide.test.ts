import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGoldEntry, sameSetupZone as goldSameSetup } from "../src/lib/genx/watchTick";
import { zoneOf as goldZoneOf, zoneAction as goldZoneAction, ZONE_TOUCH_USD, ZONE_TTL_MS as GOLD_ZONE_TTL } from "../src/lib/genx/zoneSetups";
import { PAIRS, U, units, pairOf, pipsBetween, fmtPx, type FxPair } from "../src/lib/genfx/pairs";
import { decideFxEntry, sameSetupZone, zoneOf, zoneAction, zoneBand, scanKey, zoneKey, isZoneKey, rewardRisk, ENTRY_FLOOR_RR, ARM_MAX_MS, ZONE_TTL_MS, SAME_SETUP_WINDOW_MS } from "../src/lib/genfx/decide";
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

test("enter / arm / wait / abandon — the same answer GENX gives, on a thousand gold situations", () => {
  const r = rng(42);
  const states = ["CONFIRMED", "WAIT", "AT_ZONE", "INVALIDATED", "NO_DATA", "BUSY"];
  let n = 0; const seen = new Set<string>();
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
    const fx = decideFxEntry(GOLDISH, o);
    assert.deepEqual(fx, decideGoldEntry(o));
    seen.add(fx.do); n++;
  }
  assert.equal(n, 1200);
  assert.deepEqual([...seen].sort(), ["arm", "enter", "invalidate", "wait"]);
  assert.equal(ENTRY_FLOOR_RR, 0.8);
  assert.equal(ARM_MAX_MS, 5 * 60_000);
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
  assert.equal(decideFxEntry(E, { ...base, armed: true, lp: 1.0841, armedAtMs: 0, nowMs: 6 * 60_000 }).do, "enter");
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
