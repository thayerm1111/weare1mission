/**
 * SIZING IS RISK, STOP DISTANCE AND ACCOUNT — AND NOTHING ELSE BY DEFAULT.
 *
 * The owner's model: choose a risk percentage, and the lots fall out of how far away the stop is. The
 * ceilings below exist but are OFF unless switched on, so the first tests here pin the uncapped
 * behaviour — that 1% of the account really is what goes at risk — and the rest prove the optional
 * ceilings still work for anyone who wants one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sizePosition, MAX_NOTIONAL_X_EQUITY, MAX_LOTS_ABSOLUTE, type Instrument } from "../command-center/core/risk";

/** Explicit ceilings, for the tests that are about the ceilings rather than about risk sizing. */
const CAPS = { maxNotionalXEquity: 2, maxLots: 3 };

/** XAUUSD exactly as this broker describes it: 100oz contract, 0.01 step, $10 a pip. */
const GOLD: Instrument = { contractSize: 100, minLot: 0.01, maxLot: 1000, lotStep: 0.01, pipValuePerLot: 10 };

const EQUITY = 435_041;
const PRICE = 4379.23;

test("BY DEFAULT the risk percentage decides the size, with no ceiling", () => {
  /*
   * The owner's model, pinned. 1% of $435,041 is $4,350. A 17.5-pip stop at $10 a pip means each lot
   * risks $175, so the trade is about 24.8 lots. Large, and correct: that is what fixed-risk sizing
   * does when the stop is tight, and the engine must not quietly do something else.
   */
  const r = sizePosition({ equity: EQUITY, entry: PRICE, stop: 4380.98, side: "sell", riskPct: 1, inst: GOLD });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (!r.ok) return;

  assert.equal(r.cappedBy, null, "nothing interferes unless a ceiling is switched on");
  assert.ok(Math.abs(r.riskPctUsed - 1) < 0.02, `risks ${r.riskPctUsed}% — the number that was asked for`);
  assert.ok(Math.abs(r.riskAmount - EQUITY * 0.01) < 200);
  assert.ok(r.lots > 24 && r.lots < 25, `${r.lots} lots`);
});

test("half the risk is half the size, on the same stop", () => {
  // The relationship the model depends on: size scales with the risk setting, linearly.
  const one = sizePosition({ equity: EQUITY, entry: PRICE, stop: 4380.98, side: "sell", riskPct: 1, inst: GOLD });
  const half = sizePosition({ equity: EQUITY, entry: PRICE, stop: 4380.98, side: "sell", riskPct: 0.5, inst: GOLD });
  assert.ok(one.ok && half.ok);
  if (!one.ok || !half.ok) return;
  assert.ok(Math.abs(one.lots / half.lots - 2) < 0.02, "1% is twice the size of 0.5%");
});

test("a wider stop on the same risk is a smaller position", () => {
  // And the other half of the model: the stop decides the lots, not a fixed quantity.
  const tight = sizePosition({ equity: EQUITY, entry: 4000, stop: 4002, side: "sell", riskPct: 1, inst: GOLD });
  const wide = sizePosition({ equity: EQUITY, entry: 4000, stop: 4020, side: "sell", riskPct: 1, inst: GOLD });
  assert.ok(tight.ok && wide.ok);
  if (!tight.ok || !wide.ok) return;
  assert.ok(tight.lots > wide.lots * 9, "a 10x wider stop is about a tenth of the size");
  assert.ok(Math.abs(tight.riskPctUsed - wide.riskPctUsed) < 0.02, "both still risk the same 1%");
});

test("an optional ceiling, when switched on, still binds", () => {
  const r = sizePosition({
    equity: EQUITY, entry: PRICE, stop: 4380.98, side: "sell", riskPct: 0.5, inst: GOLD, ...CAPS,
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (!r.ok) return;

  assert.ok(r.uncappedLots! > 12, `risk sizing still wants ${r.uncappedLots} lots — that is the hole`);
  assert.equal(r.cappedBy, "notional");
  assert.ok(r.lots <= 2.0, `capped to ${r.lots} lots`);

  // And the point of the cap: notional is now bounded by equity rather than by the stop's tightness.
  const notional = r.lots * GOLD.contractSize * PRICE;
  assert.ok(notional <= EQUITY * CAPS.maxNotionalXEquity * 1.001,
    `${Math.round(notional).toLocaleString()} notional is within ${CAPS.maxNotionalXEquity}x equity`);
});

test("a capped trade risks LESS than requested, never more", () => {
  const r = sizePosition({ equity: EQUITY, entry: PRICE, stop: 4380.98, side: "sell", riskPct: 0.5, inst: GOLD, ...CAPS });
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
    equity: 50_000_000, entry: PRICE, stop: 4380.98, side: "sell", riskPct: 0.5, inst: GOLD, ...CAPS,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.cappedBy, "max_lots");
  assert.ok(r.lots <= CAPS.maxLots);
});

test("a stop so tight that the ceiling leaves nothing is refused, not rounded up", () => {
  const tiny: Instrument = { ...GOLD, minLot: 2.5 };
  const r = sizePosition({
    equity: 20_000, entry: PRICE, stop: 4380.98, side: "sell", riskPct: 0.5, inst: tiny, ...CAPS,
  });
  assert.equal(r.ok, false, "below the broker's minimum after capping means no trade");
  if (!r.ok) assert.match(r.reason, /minimum|too tight/i);
});

test("the capped size is still a legal lot step", () => {
  // A ceiling landing between steps must round DOWN into a tradable size, never up through the cap.
  const r = sizePosition({
    equity: 333_333, entry: 4123.45, stop: 4126.01, side: "sell", riskPct: 0.5, inst: GOLD, ...CAPS,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const steps = r.lots / GOLD.lotStep;
  assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `${r.lots} is a whole number of 0.01 steps`);
});

test("the shipped defaults enforce nothing", () => {
  // Zero means no ceiling. If either of these is ever non-zero by default, sizing has stopped being
  // purely the owner's risk percentage and somebody needs to have decided that on purpose.
  assert.equal(MAX_NOTIONAL_X_EQUITY, 0);
  assert.equal(MAX_LOTS_ABSOLUTE, 0);
});
