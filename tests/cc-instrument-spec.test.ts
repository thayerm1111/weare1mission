/**
 * THE INSTRUMENT SPECIFICATION PARSER.
 *
 * These tests exist because of a live failure. `CC_AUTOPILOT` was set to live on a funded account and
 * the boot check reported XAUUSD unsizeable with EVERY numeric field null — not because the broker was
 * withholding anything, but because the parser only ever looked at the top level of the payload while
 * TradeLocker nests the numbers under `details` or `tradingRules`.
 *
 * The most important test in this file is not the one that makes a good payload parse. It is
 * `lotSize is a quantity step, never a contract size` — the field name that, read as the wrong thing,
 * turns a refusal into a position a hundred times too large.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseInstrumentSpec, describeShape } from "../command-center/adapters/tradelocker";
import { resolve } from "../command-center/core/instrument";

const FALLBACK = { tradableInstrumentId: "278", routeId: "900" };

test("a flat payload still parses — the deep lookup must not break the simple case", () => {
  const spec = parseInstrumentSpec(
    { d: { tradableInstrumentId: 278, name: "XAUUSD", lotStep: 0.01, minLot: 0.01, maxLot: 100, tickSize: 0.01, contractSize: 100, marginCurrency: "USD" } },
    FALLBACK,
  );
  assert.equal(spec.lotStep, 0.01);
  assert.equal(spec.minLot, 0.01);
  assert.equal(spec.tickSize, 0.01);
  assert.equal(spec.contractSize, 100);
  assert.equal(spec.currency, "USD");
});

test("the numbers are found when TradeLocker nests them under tradingRules", () => {
  const spec = parseInstrumentSpec(
    {
      d: {
        tradableInstrumentId: 278,
        name: "XAUUSD",
        marginCurrency: "USD",
        tradingRules: { quantityStep: 0.01, minQuantity: 0.01, maxQuantity: 50, priceIncrement: 0.01 },
        details: { contractSize: 100 },
      },
    },
    FALLBACK,
  );
  assert.equal(spec.lotStep, 0.01, "quantityStep under tradingRules must be found");
  assert.equal(spec.minLot, 0.01);
  assert.equal(spec.maxLot, 50);
  assert.equal(spec.tickSize, 0.01, "priceIncrement under tradingRules must be found");
  assert.equal(spec.contractSize, 100, "contractSize under details must be found");
});

test("that nested payload now actually sizes — the whole point of the fix", () => {
  const spec = parseInstrumentSpec(
    { d: { name: "XAUUSD", marginCurrency: "USD", tradingRules: { quantityStep: 0.01, minQuantity: 0.01, priceIncrement: 0.01 }, details: { contractSize: 100 } } },
    FALLBACK,
  );
  const r = resolve(spec, "USD");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) {
    // tick 0.01 → pip 0.10; 100 oz × 0.10 = $10 a pip. The conventional gold contract, derived not assumed.
    assert.equal(r.pipSize, 0.1);
    assert.equal(r.instrument.pipValuePerLot, 10);
  }
});

test("lotSize is a quantity step, never a contract size", () => {
  /*
   * THE TEST THAT PROTECTS REAL MONEY.
   *
   * On this broker `lotSize` is 0.01 — the smallest tradable increment. The old alias list accepted it
   * as `contractSize`, which would have produced pipValuePerLot = 0.01 × 0.1 = 0.001 instead of 10.
   * The risk engine divides the money-at-risk by the value per pip, so a value 10,000× too small
   * yields a position 10,000× too large. On a $435k account risking 0.5%, that is not a bad fill; it
   * is an account-ending order.
   *
   * Refusing to size is the correct behaviour here. There is no contract size in this payload, so
   * there is no honest way to value a pip, and the trade must not be taken.
   */
  const spec = parseInstrumentSpec(
    { d: { name: "XAUUSD", lotSize: 0.01, minQuantity: 0.01, priceIncrement: 0.01 } },
    FALLBACK,
  );
  assert.equal(spec.lotStep, 0.01, "lotSize is the step");
  assert.equal(spec.contractSize, null, "lotSize must NEVER be read as the contract size");

  const r = resolve(spec, "USD");
  assert.equal(r.ok, false, "with no contract size and no tick value, sizing must refuse");
  if (!r.ok) assert.ok(r.missing.includes("tick value or contract size"));
});

test("a tick value is preferred over the contract-size arithmetic", () => {
  const spec = parseInstrumentSpec(
    { d: { name: "XAUUSD", tradingRules: { quantityStep: 0.01, minQuantity: 0.01, priceIncrement: 0.01, tickValue: 1 }, details: { contractSize: 100 } } },
    FALLBACK,
  );
  const r = resolve(spec, "USD");
  assert.equal(r.ok, true);
  // $1 per 0.01 tick → $10 per 0.10 pip. Same answer here, but it comes from the broker's own statement.
  if (r.ok) assert.equal(r.instrument.pipValuePerLot, 10);
});

test("an empty payload refuses and names everything that was missing", () => {
  const spec = parseInstrumentSpec({ d: { name: "XAUUSD" } }, FALLBACK);
  const r = resolve(spec, "USD");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.missing.includes("lot step"));
    assert.ok(r.missing.includes("minimum lot"));
    // The identifiers still survive from the fallback, so the refusal can say which instrument it was.
    assert.equal(spec.tradableInstrumentId, "278");
  }
});

test("the deep lookup is bounded and prefers the shallower key", () => {
  const spec = parseInstrumentSpec(
    { d: { name: "XAUUSD", tickSize: 0.01, details: { tickSize: 0.001 } } },
    FALLBACK,
  );
  assert.equal(spec.tickSize, 0.01, "a top-level key must win over a nested one of the same name");
});

test("describeShape reports the payload without inventing anything", () => {
  const s = describeShape({ d: { name: "XAUUSD", tradingRules: { quantityStep: 0.01 } } });
  assert.ok(s.includes("name=XAUUSD"));
  assert.ok(s.includes("tradingRules.quantityStep=0.01"));
  assert.equal(describeShape({ d: {} }), "(empty payload)");
});
