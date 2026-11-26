import { account, broker, reset, T, trade } from "./_manager";
import test from "node:test";
import assert from "node:assert/strict";
import { completedBrokerBars } from "../src/lib/flow/positionChart";
import { readFlowPositionChart } from "../src/lib/floor/activeTrades";
import { parseOpenPositions } from "../src/lib/floor/activeTradeModel";

const closeAt = Date.UTC(2026, 9, 1, 14, 5);
const five = 300_000;
const bar = { t: closeAt - five, o: "100", h: "106", l: "99", c: "105" };

test("broker chart bars preserve gaps, normalize seconds and drop malformed, stale and unfinished candles", () => {
  const actual = completedBrokerBars([bar, { ...bar, t: (closeAt - 3 * five) / 1000 }, bar,
    { ...bar, t: closeAt }, { ...bar, t: closeAt - 2 * five, l: 104 },
    { ...bar, t: closeAt - 4 * five, o: true }, { ...bar, t: closeAt - 86_700_000 }], closeAt);
  assert.deepEqual(actual.map(v => v.t), [closeAt - 3 * five, closeAt - five]);
  assert.deepEqual(actual[1], { t: closeAt - five, o: 100, h: 106, l: 99, c: 105 });
  assert.deepEqual(completedBrokerBars(null, closeAt), []);
});

test("broker P/L distinguishes a reported zero or loss from missing and unrelated account figures", () => {
  const position = { id: "p", tradableInstrumentId: "i", qty: 1, side: "buy", avgPrice: 100, rpl: -98 };
  const read = (value: unknown) => parseOpenPositions([{ ...position, unrealizedPl: value }], {}, "a")[0].unrealizedPnl;
  for (const missing of [undefined, null, "", " ", false, Infinity]) assert.equal(read(missing), undefined);
  assert.equal(read("0"), 0);
  assert.equal(read("-12.75"), -12.75);
  const columns = Object.keys({ ...position, unrealizedPl: 0 }).map(id => ({ id }));
  assert.equal(parseOpenPositions([[...Object.values(position), "-0.15"]], { positionsConfig: { columns } }, "a")[0].unrealizedPnl, -0.15);
});

test("linked protection uses a working order price on this position and never an order ID", () => {
  const position = { id: "p", tradableInstrumentId: "i", qty: 1, side: "sell", avgPrice: 100, stopLossId: 12, takeProfitId: 13 };
  const stop = { id: 12, positionId: "p", type: "stop", status: "working", stopPrice: 101 };
  const target = { id: 13, positionId: "p", type: "limit", status: "working", price: 97 };
  const read = (orders: unknown[]) => parseOpenPositions([position], {}, "a", orders)[0];
  assert.equal(read([stop, target]).stop, 101);
  assert.equal(read([stop, target]).target, 97);
  assert.equal(read([{ ...target, status: "cancelled" }]).target, null);
  assert.equal(read([{ ...stop, positionId: "another" }]).stop, null);
  assert.equal(read([{ ...target, positionId: "another" }]).target, null);
  assert.equal(read([]).stop, null);
});

test("the read verifies member, environment, account and position before fetching the broker chart", async t => {
  reset();
  T("profiles").push({ id: "u1", status: "active", role: "member" }, { id: "u2", status: "active", role: "member" });
  for (const accountId of ["a", "b"]) {
    account(accountId);
    T("flow_broker_connections").push({ id: `conn-${accountId}`, user_id: "u1", environment: "demo", status: "connected" });
  }
  const scope = { accountId: "a", environment: "demo" } as const;
  const positionId = trade({ account: "a", symbol: "XAUUSD", side: "buy", entry: 100, fill: 101, stop: 99, tp1: 105, tpAtBroker: 104, qty: 1 });
  const unavailable = (p: Promise<unknown>) => assert.rejects(p, { status: 404 });
  await unavailable(readFlowPositionChart("u2", scope, positionId));
  await unavailable(readFlowPositionChart("u1", { ...scope, environment: "live" }, positionId));
  await unavailable(readFlowPositionChart("u1", { ...scope, accountId: "b" }, positionId));
  await unavailable(readFlowPositionChart("u1", scope, "untracked"));
  assert.equal(broker.reads, 0);
  broker.pricesOnRow = true;
  const tl = require("../src/lib/flow/tradelocker");
  t.mock.method(tl, "listOrders", async () => ({ ok: true, data: [] }));
  t.mock.method(tl, "getPositionChartBars", async () => []);
  const result = await readFlowPositionChart("u1", scope, positionId);
  assert.deepEqual([result.positionId, result.entry, result.stop, result.target, result.unrealizedPnl, result.bars],
    [positionId, 101, 99, 104, 0, []]);
  broker.positions.delete(positionId);
  await unavailable(readFlowPositionChart("u1", scope, positionId));
  assert.deepEqual(broker.calls, []);
});
