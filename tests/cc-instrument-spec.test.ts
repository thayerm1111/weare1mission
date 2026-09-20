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
import { parseInstrumentSpec, describeShape, findGold } from "../command-center/adapters/tradelocker";
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

test("findGold separates the TRADE route from the INFO route", () => {
  /*
   * The live account lists XAUUSD with routes[0] = TRADE 541039 and routes[1] = INFO 541038. The old
   * code took routes[0] for everything, so the specification was read on the trading route, which does
   * not serve it — a 404 that fell back to a row carrying no numbers at all.
   */
  const body = {
    d: {
      instruments: [
        { tradableInstrumentId: 8542, name: "XAUUSD", routes: [{ id: 541039, type: "TRADE" }, { id: 541038, type: "INFO" }] },
      ],
    },
  };
  const g = findGold(body);
  assert.ok(g);
  assert.equal(g!.tradableInstrumentId, "8542");
  assert.equal(g!.routeId, "541039", "orders go on the TRADE route");
  assert.equal(g!.infoRouteId, "541038", "specifications are read on the INFO route");
});

test("findGold still works when the broker lists only one route", () => {
  const g = findGold({ d: { instruments: [{ tradableInstrumentId: 1, name: "XAUUSD", routes: [{ id: 7, type: "TRADE" }] }] } });
  assert.ok(g);
  assert.equal(g!.routeId, "7");
  assert.equal(g!.infoRouteId, "7", "with no INFO route, fall back to the trade route rather than refusing");
});

test("the real list row from the live account cannot size, and says so", () => {
  // Exactly what the broker returned in the boot check: ids, a name, a type, routes. No numbers.
  const row = {
    tradableInstrumentId: 8542, id: 9389, name: "XAUUSD", description: "Gold Spot",
    type: "EQUITY_CFD", tradingExchange: "GENESIS", marketDataExchange: "Metals",
    routes: [{ id: 541039, type: "TRADE" }, { id: 541038, type: "INFO" }], barSource: "BID",
  };
  const spec = parseInstrumentSpec(row, { tradableInstrumentId: "8542", routeId: "541039" });
  assert.equal(spec.lotStep, null);
  assert.equal(spec.contractSize, null);
  const r = resolve(spec, "USD");
  assert.equal(r.ok, false, "a list row with no numbers must refuse, never assume a gold contract");
});

test("the LIVE detail payload from account 2 sizes correctly", () => {
  /*
   * Copied field for field out of the boot check on 2026-09-20. This is the specification the broker
   * actually serves for XAUUSD on the INFO route, and the numbers below are the ones a real order on
   * this account will be sized with. If this test ever fails, a live position is about to be the wrong
   * size — treat it as a stop-trading condition, not a flaky test.
   */
  const live = {
    d: {
      name: "XAUUSD", description: "Gold Spot", type: "EQUITY_CFD",
      tradingExchange: "GENESIS", marketDataExchange: "Metals", localizedName: "XAUUSD",
      settlementSystem: "Immediate",
      tickSize: [{ tickSize: 0.01 }],
      tickCost: [{ tickCost: 0 }],
      quotingCurrency: "USD", symbolStatus: "FULLY_OPEN",
      lotSize: 100, lotStep: 0.01, minLot: 0.01, maxLot: 1000,
      barSource: "BID", leverage: "500.00",
    },
  };
  const spec = parseInstrumentSpec(live, { tradableInstrumentId: "8542", routeId: "541039" });

  assert.equal(spec.tickSize, 0.01, "tickSize arrives as an array of bands and must still be read");
  assert.equal(spec.lotStep, 0.01);
  assert.equal(spec.minLot, 0.01);
  assert.equal(spec.maxLot, 1000);
  assert.equal(spec.contractSize, 100, "lotSize 100 beside lotStep 0.01 is the contract size");
  assert.equal(spec.currency, "USD");

  const r = resolve(spec, "USD");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) {
    assert.equal(r.pipSize, 0.1, "tick 0.01 → pip 0.10");
    assert.equal(r.instrument.pipValuePerLot, 10, "100 oz × $0.10 = $10 a pip on a 1.00 lot");
    assert.equal(r.instrument.lotStep, 0.01);
    assert.equal(r.instrument.minLot, 0.01);
    assert.equal(r.warnings.length, 0, "USD instrument on a USD account needs no caveat");
  }
});

test("a zero tick cost is not a tick value", () => {
  // The broker sends tickCost 0, which states nothing. Sizing must fall through to the contract size
  // rather than dividing by zero or believing a pip is worth nothing.
  const spec = parseInstrumentSpec(
    { d: { name: "XAUUSD", tickSize: [{ tickSize: 0.01 }], tickCost: [{ tickCost: 0 }], lotSize: 100, lotStep: 0.01, minLot: 0.01 } },
    FALLBACK,
  );
  assert.equal(spec.tickValue, 0);
  const r = resolve(spec, "USD");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.instrument.pipValuePerLot, 10);
    assert.ok(r.source.includes("contractSize"), "must have used the contract size, not the zero tick cost");
  }
});

test("lotSize alone is still never promoted to a contract size", () => {
  // No separate step in this payload, so the broker has not distinguished the two meanings.
  const spec = parseInstrumentSpec({ d: { name: "XAUUSD", lotSize: 0.01, minLot: 0.01, tickSize: 0.01 } }, FALLBACK);
  assert.equal(spec.lotStep, 0.01, "the conservative reading: it is the step");
  assert.equal(spec.contractSize, null, "unqualified lotSize must never become a contract size");
  assert.equal(resolve(spec, "USD").ok, false);
});
