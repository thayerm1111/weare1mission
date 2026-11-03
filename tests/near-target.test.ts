import { test } from "node:test";
import assert from "node:assert/strict";
import { nearTargetPips, nearTargetPrice, nearTargetApplies, NEAR_TP_MIN_PIPS, NEAR_TP_MAX_PIPS } from "../src/lib/flow/nearTarget";

const PIP = 0.1; // gold
const BEFORE = Date.parse("2026-10-20T12:00:00Z");   // a trade opened under the old half-the-stop target

test("the take-profit is never nearer than the stop (owner 11-02): at least 1:1, never under 30 pips", () => {
  assert.equal(nearTargetPips(110), 110);         // the median gold stop → a 110-pip target, not 55
  assert.equal(nearTargetPips(150), 150);         // the widest stop gold may carry now
  assert.equal(nearTargetPips(40), 40);
  assert.equal(nearTargetPips(20), NEAR_TP_MIN_PIPS);   // a tiny stop still gets 30 pips
  assert.equal(nearTargetPips(0), null);
  assert.equal(nearTargetPips(null), null);
  assert.equal(nearTargetPips(Number.NaN), null);
});

test("the 11-02 trade: its $63 stop got an 80-pip target; under the rule the target is at least the stop (and the stop itself is refused)", () => {
  assert.equal(nearTargetPips(629.5, BEFORE), NEAR_TP_MAX_PIPS);
  assert.equal(nearTargetPips(629.5), 629.5);
});

test("a trade opened before 11-02 keeps the half-the-stop target it was given, clamped at both ends", () => {
  assert.equal(nearTargetPips(110, BEFORE), 55);
  assert.equal(nearTargetPips(40, BEFORE), NEAR_TP_MIN_PIPS);
  assert.equal(nearTargetPips(1035, BEFORE), NEAR_TP_MAX_PIPS);
  assert.ok(Math.abs(nearTargetPrice("buy", 4400, 4389, PIP, 4420, BEFORE)! - 4405.5) < 1e-9);
  assert.ok(Math.abs(nearTargetPrice("buy", 4400, 4389, PIP, null, BEFORE)! - 4405.5) < 1e-9);
});

test("prices sit on the correct side of entry", () => {
  // buy 4400, stop 4389 → 110 pips risk → 110 pip target → 4411
  assert.ok(Math.abs(nearTargetPrice("buy", 4400, 4389, PIP, 4420)! - 4411) < 1e-9);
  // sell 4400, stop 4411 → 4389
  assert.ok(Math.abs(nearTargetPrice("sell", 4400, 4411, PIP, 4380)! - 4389) < 1e-9);
});

test("it can only ever bring a target CLOSER, never push one further out", () => {
  // GENX target nearer than 1R → GENX's own stays (placement refuses such a trade anyway)
  assert.equal(nearTargetPrice("buy", 4400, 4389, PIP, 4402), null);
  assert.equal(nearTargetPrice("sell", 4400, 4411, PIP, 4398), null);
  assert.equal(nearTargetPrice("buy", 4400, 4389, PIP, 4411), null);   // exactly 1R: GENX's own is the take-profit
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
  assert.ok(Math.abs(nearTargetPrice("buy", 4400, 4389, PIP)! - 4411) < 1e-9);
});
