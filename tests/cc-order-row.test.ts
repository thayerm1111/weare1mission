/**
 * FINDING OUR OWN ORDER IN THE BROKER'S HISTORY.
 *
 * The reconciler used to stringify the entire orders history and test two unrelated things: does this
 * blob mention our order id, and does this blob contain the word "Cancelled" anywhere. Any cancelled
 * order in the account's past — another engine's, last week's — made every one of our orders report as
 * cancelled, whatever had actually happened to it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { __findOrderRow as findOrderRow } from "../command-center/engines/executor";

test("a cancelled order belonging to somebody else is not our cancellation", () => {
  /*
   * THE TEST THIS FILE EXISTS FOR. Our order filled. A different, older order was cancelled. The old
   * substring check would have declared ours rejected on that coincidence alone.
   */
  const history = { d: { ordersHistory: [
    { id: "72057594100000001", status: "Cancelled", symbol: "XAUUSD", reason: "Not enough margin" },
    { id: "72057594108365968", status: "Filled",    symbol: "XAUUSD", avgPrice: 4379.2 },
  ] } };

  const row = findOrderRow(history, "72057594108365968") as Record<string, unknown> | null;
  assert.ok(row, "our row is found");
  assert.equal(row!.status, "Filled", "and it is OURS, not the cancelled one above it");
  assert.ok(!JSON.stringify(row).includes("Cancelled"));
});

test("our own rejection is found, with the broker's reason attached", () => {
  const history = { d: { ordersHistory: [
    { id: "72057594108365968", status: "Rejected", message: "Invalid stops: too close to market" },
  ] } };
  const row = findOrderRow(history, "72057594108365968");
  assert.ok(row);
  const text = JSON.stringify(row);
  assert.match(text, /Rejected/);
  assert.match(text, /too close to market/, "the reason is what makes this actionable");
});

test("columnar rows work too — the shape varies by broker build", () => {
  // Some builds return arrays whose indices come from /trade/config rather than named fields.
  const history = { d: [
    ["72057594100000001", "XAUUSD", "Cancelled"],
    ["72057594108365968", "XAUUSD", "Rejected", "Market closed"],
  ] };
  const row = findOrderRow(history, "72057594108365968") as unknown[] | null;
  assert.ok(Array.isArray(row));
  assert.equal(row![0], "72057594108365968");
  assert.match(JSON.stringify(row), /Market closed/);
});

test("an order that is not in the history returns nothing", () => {
  // Absence must read as "no verdict", never as a rejection — that is how a live order gets abandoned.
  const history = { d: { ordersHistory: [{ id: "999", status: "Cancelled" }] } };
  assert.equal(findOrderRow(history, "72057594108365968"), null);
});

test("a partial id match is not a match", () => {
  // Order ids are long and share prefixes. A substring test would pair us with the wrong order.
  const history = { d: { ordersHistory: [{ id: "72057594108365968123", status: "Cancelled" }] } };
  assert.equal(findOrderRow(history, "72057594108365968"), null);
});
