/**
 * THE ORDER BODY.
 *
 * This is the last thing that happens before real money moves, and until tonight it had never once
 * executed. FLOW places orders on this same broker every trading day, so where the two disagree, FLOW
 * is the evidence and this file is the guess. These tests pin the agreements.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { orderBody } from "../command-center/adapters/tradelocker";

const base = {
  tradableInstrumentId: "8542", routeId: "541039", qty: 1.08,
  side: "buy" as const, type: "market" as const, validity: "IOC" as const,
};

test("a market order carries no price field", () => {
  // It used to send price: 0. FLOW omits the field entirely on a market order.
  const b = orderBody({ ...base });
  assert.equal("price" in b, false, "a zero price on a market order is not the same as no price");
  assert.equal(b.type, "market");
  assert.equal(b.validity, "IOC");
  assert.equal(b.qty, 1.08);
  assert.equal(b.side, "buy");
  assert.equal(b.tradableInstrumentId, "8542");
  assert.equal(b.routeId, "541039", "orders go on the TRADE route");
});

test("a limit order does carry its price", () => {
  const b = orderBody({ ...base, type: "limit", validity: "GTC", price: 3999.5 });
  assert.equal(b.price, 3999.5);
});

test("a stop never travels without its type field", () => {
  /*
   * TradeLocker rejects a bare stopLoss. A rejected order is survivable; what is not survivable is the
   * variant where the order is accepted and the stop silently is not — so this is asserted, not assumed.
   */
  const b = orderBody({ ...base, stopLoss: 3980, takeProfit: 4040 });
  assert.equal(b.stopLoss, 3980);
  assert.equal(b.stopLossType, "absolute");
  assert.equal(b.takeProfit, 4040);
  assert.equal(b.takeProfitType, "absolute");
});

test("no protection fields are invented when none were asked for", () => {
  const b = orderBody({ ...base });
  assert.equal("stopLoss" in b, false);
  assert.equal("stopLossType" in b, false);
  assert.equal("takeProfit" in b, false);
});

test("the strategy tag is truncated to what the broker accepts", () => {
  const b = orderBody({ ...base, strategyId: "cc-" + "f".repeat(60) });
  assert.equal(String(b.strategyId).length, 31);
});
