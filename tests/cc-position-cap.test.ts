/**
 * THE POSITION-SIZE CEILING.
 *
 * Written from real orders. On the first live night the Brain sent 7, 8, 11, 12 and 16 lots on 17-pip
 * stops, and the broker refused every one. A broker's refusal is not a risk control, so these are.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sizePosition, MAX_NOTIONAL_X_EQUITY, MAX_LOTS_ABSOLUTE, type Instrument } from "../command-center/core/risk";

/** XAUUSD exactly as this broker describes it: 100oz contract, 0.01 step, $10 a pip. */
const GOLD: Instrument = { contractSize: 100, minLot: 0.01, maxLot: 1000, lotStep: 0.01, pipValuePerLot: 10 };

const EQUITY = 435_041;
const PRICE = 4379.23;

test("the exact trade from the first live night is capped", () => {
  /*
   * 22:16:04 — sell, entry 4379.23, stop 4380.98. A 17.5-pip stop against $2,175 of risk wants 12.4
   * lots: 1,240 ounces, about $5.4 MILLION against a $435k account. The broker cancelled it.
   */
  const r = sizePosition({
    equity: EQUITY, entry: PRICE, stop: 4380.98, side: "sell", riskPct: 0.5, inst: GOLD,
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (!r.ok) return;

  assert.ok(r.uncappedLots! > 12, `risk sizing still wants ${r.uncappedLots} lots — that is the hole`);
  assert.equal(r.cappedBy, "notional");
  assert.ok(r.lots <= 2.0, `capped to ${r.lots} lots`);

  // And the point of the cap: notional is now bounded by equity rather than by the stop's tightness.
  const notional = r.lots * GOLD.contractSize * PRICE;
  assert.ok(notional <= EQUITY * MAX_NOTIONAL_X_EQUITY * 1.001,
    `${Math.round(notional).toLocaleString()} notional is within ${MAX_NOTIONAL_X_EQUITY}x equity`);
});

test("a capped trade risks LESS than requested, never more", () => {
  const r = sizePosition({ equity: EQUITY, entry: PRICE, stop: 4380.98, side: "sell", riskPct: 0.5, inst: GOLD });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.riskPctUsed < 0.5, `risks ${r.riskPctUsed}% instead of 0.5% — under-risk is the safe direction`);
  assert.ok(r.riskAmount < EQUITY * 0.005);
});

test("a normal trade is untouched by the ceiling", () => {
  /*
   * The pre-flight's reference: a 200-pip stop sizes to 1.08 lots. That is what a trade on this account
   * is supposed to look like, and a cap that interfered with it would be the wrong cap.
   */
  const r = sizePosition({ equity: EQUITY, entry: 4000, stop: 4020, side: "sell", riskPct: 0.5, inst: GOLD });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.lots, 1.08);
  assert.equal(r.cappedBy, null, "risk alone decided this one");
  assert.equal(r.riskPctUsed, 0.497);
});

test("the absolute lot ceiling holds even if equity is absurd", () => {
  // A cap that depends on a broker-reported number is not a cap when that number is what is in doubt.
  const r = sizePosition({
    equity: 50_000_000, entry: PRICE, stop: 4380.98, side: "sell", riskPct: 0.5, inst: GOLD,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.cappedBy, "max_lots");
  assert.ok(r.lots <= MAX_LOTS_ABSOLUTE);
});

test("a stop so tight that the ceiling leaves nothing is refused, not rounded up", () => {
  const tiny: Instrument = { ...GOLD, minLot: 2.5 };
  const r = sizePosition({
    equity: 20_000, entry: PRICE, stop: 4380.98, side: "sell", riskPct: 0.5, inst: tiny,
  });
  assert.equal(r.ok, false, "below the broker's minimum after capping means no trade");
  if (!r.ok) assert.match(r.reason, /minimum|too tight/i);
});

test("the capped size is still a legal lot step", () => {
  // A ceiling landing between steps must round DOWN into a tradable size, never up through the cap.
  const r = sizePosition({
    equity: 333_333, entry: 4123.45, stop: 4126.01, side: "sell", riskPct: 0.5, inst: GOLD,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const steps = r.lots / GOLD.lotStep;
  assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `${r.lots} is a whole number of 0.01 steps`);
});

test("the defaults are the ones that were shipped", () => {
  assert.equal(MAX_NOTIONAL_X_EQUITY, 2, "2x equity — one lot of gold is already about 1x");
  assert.equal(MAX_LOTS_ABSOLUTE, 3);
});
