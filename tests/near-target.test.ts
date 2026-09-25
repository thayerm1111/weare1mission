import { test } from "node:test";
import assert from "node:assert/strict";
import { nearTargetPips, nearTargetPrice, nearTargetApplies, NEAR_TP_MIN_PIPS, NEAR_TP_MAX_PIPS } from "../src/lib/flow/nearTarget";

const PIP = 0.1; // gold

test("the target is half the trade's own stop, clamped at both ends", () => {
  assert.equal(nearTargetPips(110), 55);          // the median gold stop → 55 pips
  assert.equal(nearTargetPips(40), NEAR_TP_MIN_PIPS);   // 20 would be inside the noise → floored
  assert.equal(nearTargetPips(1035), NEAR_TP_MAX_PIPS); // 517 on a swing stop → capped
  assert.equal(nearTargetPips(0), null);
  assert.equal(nearTargetPips(null), null);
  assert.equal(nearTargetPips(Number.NaN), null);
});

test("prices sit on the correct side of entry", () => {
  // buy 4400, stop 4389 → 110 pips risk → 55 pip target → 4405.5
  assert.ok(Math.abs(nearTargetPrice("buy", 4400, 4389, PIP, 4420)! - 4405.5) < 1e-9);
  // sell 4400, stop 4411 → 4394.5
  assert.ok(Math.abs(nearTargetPrice("sell", 4400, 4411, PIP, 4380)! - 4394.5) < 1e-9);
});

test("it can only ever bring a target CLOSER, never push one further out", () => {
  // GENX target already nearer than 0.5R → leave GENX's alone
  assert.equal(nearTargetPrice("buy", 4400, 4389, PIP, 4402), null);
  assert.equal(nearTargetPrice("sell", 4400, 4411, PIP, 4398), null);
  // GENX target further out → ours is used
  assert.ok(nearTargetPrice("buy", 4400, 4389, PIP, 4421) != null);
});

test("an unusable stop leaves GENX's target in place rather than inventing a level", () => {
  assert.equal(nearTargetPrice("buy", 4400, 4400, PIP, 4420), null);   // zero risk
  assert.equal(nearTargetPrice("buy", null, 4389, PIP, 4420), null);
  assert.equal(nearTargetPrice("buy", 4400, null, PIP, 4420), null);
  assert.equal(nearTargetPrice("buy", 4400, 4389, 0, 4420), null);     // no pip size
});

test("gold only — nothing else traded enough to have earned the change", () => {
  assert.equal(nearTargetApplies("XAUUSD"), true);
  assert.equal(nearTargetApplies("XAU/USD"), true);
  assert.equal(nearTargetApplies("EURUSD"), false);
  assert.equal(nearTargetApplies(null), false);
});

test("no GENX target supplied still yields a level (the bracket-repair path)", () => {
  assert.ok(Math.abs(nearTargetPrice("buy", 4400, 4389, PIP)! - 4405.5) < 1e-9);
});
