import assert from "node:assert/strict";
import test from "node:test";
import { marginRequirement, readAccountMetrics, readClosedOutcome, readOpeningFill, type NitrousBrokerReads, type NitrousClosedPosition } from "../nitrous/broker";
import type { InstrumentSpec } from "../rapid/core/types";
import { TradeLockerPort, type PortContext } from "../rapid/exec/tradelockerPort";

const NOW = Date.parse("2026-11-25T14:00:00Z");
const ctx: PortContext = { env: "demo", token: "never-used-test-token", accNum: "7", accountId: "account-1" };
const position: NitrousClosedPosition = { broker_position_id: "position-1", side: "buy", entry: 4200, original_qty: 0.05, opened_at: "2026-11-25T12:00:00Z" };
const spec: InstrumentSpec = {
  tradableInstrumentId: "gold-1", tradeRouteId: "1", infoRouteId: "2", brokerSymbol: "XAUUSD",
  contractSize: 100, lotStep: 0.01, minLot: 0.01, maxLot: 10, tickSize: 0.01, tickValue: 1,
  priceDecimals: 2, currency: "USD", minStopDistance: 0.1, raw: { leverage: 100 },
};
const columns = (ids: string[]) => ({ columns: ids.map((id) => ({ id })) });
const accountFields = ["freeFunds", "cashBalance", "currency", "projectedBalance"];
const historyFields = ["id", "positionId", "side", "status", "filledQty", "avgPrice", "tradableInstrumentId", "lastModified", "isOpen", "realizedNetPnl", "pnlCurrency", "strategyId"];
const config = { d: { accountDetailsConfig: columns(accountFields), positionsConfig: columns(["side", "id", "qty"]), ordersHistoryConfig: columns(historyFields) } };
const fill = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "close-1", positionId: "position-1", side: "sell", status: "Filled", filledQty: 0.05, avgPrice: 4206, tradableInstrumentId: "gold-1", lastModified: NOW - 60_000, isOpen: false, ...patch });
const makeReads = (patch: Partial<NitrousBrokerReads> = {}): NitrousBrokerReads => ({
  config: async () => ({ ok: true, data: config }),
  state: async () => ({ ok: true, data: { accountDetailsData: [425, 500, "USD", 525] } }),
  accounts: async () => ({ ok: true, data: [{ id: "account-1", accNum: "7", currency: "USD", accountBalance: 500 }] }),
  positions: async () => ({ ok: true, data: [] }),
  history: async () => ({ ok: true, data: { rows: [fill()], hasMore: false } }),
  now: () => NOW,
  ...patch,
});
const withRows = (rows: unknown[], hasMore = false) => makeReads({ history: async () => ({ ok: true, data: { rows, hasMore } }) });

test("account metrics use current config field mapping, never fixed offsets", async () => {
  const result = await readAccountMetrics(ctx, makeReads());
  assert.deepEqual(result, { ok: true, balance: 500, equity: 525, freeMargin: 425, currency: "USD" });
});

test("TradeLocker availableFunds maps to free margin using broker configuration, not an array offset", async () => {
  const fields = ["projectedBalance", "blockedBalance", "availableFunds", "balance"];
  const result = await readAccountMetrics(ctx, makeReads({
    config: async () => ({ ok: true, data: { d: { accountDetailsConfig: columns(fields) } } }),
    state: async () => ({ ok: true, data: { d: { accountDetailsData: [525, 30, 395, 500] } } }),
  }));
  assert.deepEqual(result, { ok: true, balance: 500, equity: 525, freeMargin: 395, currency: "USD" });
});

test("availableFunds object values preserve zero, negative and unknown margin; equity is never substituted", async () => {
  for (const [availableFunds, expected] of [[400, 400], ["125.5", 125.5], [0, 0], [-10, -10], [null, null], ["", null], [undefined, null], [false, null]] as const) {
    const result = await readAccountMetrics(ctx, makeReads({
      state: async () => ({ ok: true, data: { balance: 500, equity: 525, currency: "USD", availableFunds } }),
    }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.freeMargin, expected);
  }
  const explicitZero = await readAccountMetrics(ctx, makeReads({
    state: async () => ({ ok: true, data: { balance: 500, equity: 525, currency: "USD", freeMargin: 0, availableFunds: 400 } }),
  }));
  assert.equal(explicitZero.ok, true);
  if (explicitZero.ok) assert.equal(explicitZero.freeMargin, 0);
});

test("currency and balance fallback is scoped to both account ID and account number", async () => {
  const result = await readAccountMetrics(ctx, makeReads({
    state: async () => ({ ok: true, data: { equity: 520, freeMargin: 400 } }),
    accounts: async () => ({ ok: true, data: [
      { id: "account-2", accNum: "7", currency: "GBP", accountBalance: 99999 },
      { id: "account-1", accNum: "9", currency: "EUR", accountBalance: 99999 },
      { id: "account-1", accNum: "7", currency: "usd", accountBalance: "500.25" },
    ] }),
  }));
  assert.deepEqual(result, { ok: true, balance: 500.25, equity: 520, freeMargin: 400, currency: "USD" });
  assert.equal((await readAccountMetrics(ctx, makeReads({ state: async () => ({ ok: true, data: {} }), accounts: async () => ({ ok: true, data: [{ id: "account-2", accNum: "7" }] }) }))).ok, false);
});

test("null and blank account fields stay unknown while real zero remains zero", async () => {
  const result = await readAccountMetrics(ctx, makeReads({
    state: async () => ({ ok: true, data: { balance: null, equity: "", freeMargin: 0 } }),
    accounts: async () => ({ ok: true, data: [{ id: "account-1", accNum: "7", accountBalance: null, equity: null, currency: "USD" }] }),
  }));
  assert.deepEqual(result, { ok: true, balance: null, equity: null, freeMargin: 0, currency: "USD" });
});

test("missing positional config and conflicting currencies never return usable metrics", async () => {
  assert.equal((await readAccountMetrics(ctx, makeReads({ config: async () => ({ ok: false, error: "unavailable" }) }))).ok, false);
  assert.equal((await readAccountMetrics(ctx, makeReads({ state: async () => ({ ok: true, data: { currency: "EUR", equity: 500 } }) }))).ok, false);
});

test("exact opposite-side fills yield weighted price and explicitly gross P&L", async () => {
  const result = await readClosedOutcome(ctx, position, spec, "USD", withRows([
    fill({ id: "opening", side: "buy", avgPrice: 4200 }),
    fill({ id: "other-position", positionId: "different", avgPrice: 9999 }),
    fill({ id: "partial-1", filledQty: 0.02, avgPrice: 4205 }),
    fill({ id: "partial-2", filledQty: 0.03, avgPrice: 4210, lastModified: NOW }),
  ]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exitPrice, 4208); assert.equal(result.realisedPnl, 40);
  assert.equal(result.source, "calculated_gross"); assert.equal(result.feesVerified, false);
  assert.equal(result.closedAt, new Date(NOW).toISOString());
});

test("positional history is mapped by config and identical duplicates are counted once", async () => {
  const row = historyFields.map((key) => fill()[key]);
  const result = await readClosedOutcome(ctx, position, spec, "USD", withRows([row, row]));
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(Math.abs(result.realisedPnl - 30) < 1e-8);
});

test("partial, excessive, missing and ambiguous closing quantities remain unknown", async () => {
  for (const rows of [
    [fill({ filledQty: 0.04 })], [fill({ filledQty: 0.06 })], [fill({ filledQty: null, qty: 0.05 })],
    [fill(), fill({ avgPrice: 4207 })], [fill({ positionId: "different" })], [fill({ side: "buy" })],
  ]) assert.equal((await readClosedOutcome(ctx, position, spec, "USD", withRows(rows))).ok, false);
});

test("missing actual fill price never falls back to request, target or stop prices", async () => {
  for (const avgPrice of [null, "", 0, false, undefined]) {
    assert.equal((await readClosedOutcome(ctx, position, spec, "USD", withRows([fill({ avgPrice, price: 4206, stopLoss: 4195, takeProfit: 4206 })]))).ok, false);
  }
});

test("still-open positions, truncated history, and failed reads cannot settle a trade", async () => {
  const cases = [
    makeReads({ positions: async () => ({ ok: true, data: [["buy", "position-1", "0.01"]] }) }),
    withRows([fill()], true),
    makeReads({ positions: async () => ({ ok: false, error: "failed" }) }),
    makeReads({ history: async () => { throw new Error(`token ${ctx.token}`); } }),
  ];
  for (const reads of cases) {
    const result = await readClosedOutcome(ctx, position, spec, "USD", reads);
    assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /never-used-test-token/);
  }
});

test("wrong instrument, rejected fills, and stale/future closing evidence remain unknown", async () => {
  for (const patch of [
    { tradableInstrumentId: "silver" }, { status: "Rejected" }, { isOpen: true },
    { lastModified: NOW + 600_000 }, { lastModified: Date.parse(position.opened_at) - 1 }, { lastModified: null },
  ]) assert.equal((await readClosedOutcome(ctx, position, spec, "USD", withRows([fill(patch)]))).ok, false);
});

test("explicit currency-matched broker net fields can settle fees; generic profit cannot", async () => {
  const net = await readClosedOutcome(ctx, position, spec, "USD", withRows([fill({ realizedNetPnl: 28.5, pnlCurrency: "USD" })]));
  assert.equal(net.ok, true);
  if (net.ok) { assert.equal(net.realisedPnl, 28.5); assert.equal(net.source, "broker_net"); assert.equal(net.feesVerified, true); }
  for (const patch of [{ profit: 28.5 }, { pnl: 28.5 }, { realizedNetPnl: 28.5, pnlCurrency: "EUR" }]) {
    const result = await readClosedOutcome(ctx, position, spec, "USD", withRows([fill(patch)]));
    assert.equal(result.ok, true);
    if (result.ok) { assert.equal(result.source, "calculated_gross"); assert.equal(result.feesVerified, false); }
  }
});

test("gross requires verified contract and matching account/profit currency; short direction is correct", async () => {
  for (const [s, ccy] of [[{ ...spec, contractSize: null }, "USD"], [spec, "EUR"], [spec, null]] as const) {
    assert.equal((await readClosedOutcome(ctx, position, s, ccy, makeReads())).ok, false);
  }
  const result = await readClosedOutcome(ctx, { ...position, side: "sell" }, spec, "USD", withRows([fill({ side: "buy", avgPrice: 4194 })]));
  assert.equal(result.ok, true); if (result.ok) assert.ok(Math.abs(result.realisedPnl - 30) < 1e-8);
});

test("margin calculation requires explicit consistent scalar broker leverage and verified currency", () => {
  assert.equal(marginRequirement(spec, 0.05, 4200, "USD"), 210);
  for (const raw of [{}, { leverage: null }, { leverage: 0 }, { leverage: -100 }, { leverage: [{ leverage: 100 }] }, { leverage: 100, details: { leverage: 50 } }]) assert.equal(marginRequirement({ ...spec, raw }, 0.05, 4200, "USD"), null);
  assert.equal(marginRequirement(spec, 0.05, 4200, "EUR"), null);
  assert.equal(marginRequirement({ ...spec, contractSize: null }, 0.05, 4200, "USD"), null);
});

const openingLookup = { orderId: "open-order", positionId: null, strategyId: "NITROUS:confirmed", side: "buy" as const, submittedAt: position.opened_at };
const opening = (patch: Record<string, unknown> = {}) => fill({ id: "open-order", side: "buy", isOpen: true, avgPrice: 4200, strategyId: "NITROUS:confirmed", lastModified: Date.parse(position.opened_at) + 1000, ...patch });

test("opening recovery uses exact order identity and terminal actual fill values after a fast close", async () => {
  const result = await readOpeningFill(ctx, openingLookup, spec, withRows([opening(), fill()]));
  assert.deepEqual(result, { ok: true, positionId: "position-1", entry: 4200, qty: 0.05, openedAt: new Date(Date.parse(position.opened_at) + 1000).toISOString() });
  // A cancelled IOC can still have a final, explicitly executed partial quantity.
  const partial = await readOpeningFill(ctx, openingLookup, spec, withRows([opening({ status: "Cancelled", filledQty: 0.02, qty: 0.05 })]));
  assert.equal(partial.ok, true); if (partial.ok) assert.equal(partial.qty, 0.02);
});

test("position-based opening recovery requires exact position and exact strategy, never a tag alone", async () => {
  const lookup = { ...openingLookup, orderId: null, positionId: "position-1" };
  const result = await readOpeningFill(ctx, lookup, spec, withRows([opening(), fill({ strategyId: "NITROUS:confirmed" })]));
  assert.equal(result.ok, true);
  for (const rows of [[opening({ positionId: "someone-else" })], [opening({ strategyId: "NITROUS:other" })], [opening({ strategyId: null })]]) {
    assert.equal((await readOpeningFill(ctx, lookup, spec, withRows(rows))).ok, false);
  }
  assert.equal((await readOpeningFill(ctx, { ...openingLookup, orderId: null }, spec, withRows([opening()]))).ok, false);
});

test("terminal opening fill arrays use broker-config column mapping", async () => {
  const row = historyFields.map((key) => opening()[key]);
  const result = await readOpeningFill(ctx, { ...openingLookup, orderId: null, positionId: "position-1" }, spec, withRows([row, row]));
  assert.equal(result.ok, true); if (result.ok) { assert.equal(result.entry, 4200); assert.equal(result.qty, 0.05); }
});

test("opening recovery rejects nonterminal, missing, mismatched and ambiguous broker evidence", async () => {
  for (const patch of [
    { status: "PartiallyFilled" }, { status: "Rejected" }, { filledQty: 0 }, { filledQty: null, qty: 0.05 },
    { avgPrice: null, price: 4200 }, { side: "sell" }, { isOpen: false }, { tradableInstrumentId: "silver" },
    { lastModified: null }, { lastModified: NOW + 600_000 }, { strategyId: "NITROUS:other" }, { positionId: null },
  ]) assert.equal((await readOpeningFill(ctx, openingLookup, spec, withRows([opening(patch)]))).ok, false, JSON.stringify(patch));
  assert.equal((await readOpeningFill(ctx, openingLookup, spec, withRows([opening()], true))).ok, false);
  assert.equal((await readOpeningFill(ctx, openingLookup, spec, withRows([opening(), opening({ filledQty: 0.03 })]))).ok, false);
  assert.equal((await readOpeningFill(ctx, { ...openingLookup, orderId: null, positionId: "position-1" }, spec, withRows([opening(), opening({ id: "additional-open" })]))).ok, false);
});

test("final execution rows settle a closed position with incomplete order history", async () => {
  const fields = ["createdDate", "positionId", "price", "qty", "side", "id", "tradableInstrumentId"];
  const row = [NOW - 1000, position.broker_position_id, 4206, position.original_qty, "sell", "exec-1", spec.tradableInstrumentId];
  const reads = makeReads({
    ...withRows([fill({ filledQty: null })]),
    config: async () => ({ ok: true, data: { d: { ...config.d, filledOrdersConfig: columns(fields) } } }),
    executions: async () => ({ ok: true, data: { rows: [row, row], hasMore: false } }),
  });
  const outcome = await readClosedOutcome(ctx, position, spec, "USD", reads);
  assert.ok(outcome.ok);
  assert.equal(outcome.exitPrice, 4206);
  assert.equal(outcome.source, "calculated_gross");
  assert.equal(outcome.feesVerified, false);
  for (const patch of [
    { executions: async () => ({ ok: true as const, data: { rows: [row], hasMore: true } }) },
    { positions: async () => ({ ok: true as const, data: [["buy", position.broker_position_id, position.original_qty]] }) },
    { executions: async () => ({ ok: true as const, data: { rows: [[...row.slice(0, 3), 0.01, ...row.slice(4)]], hasMore: false } }) },
  ]) {
    assert.equal((await readClosedOutcome(ctx, position, spec, "USD", { ...reads, ...patch })).ok, false);
  }
});


test("linked stop and target are verified against the account's working orders", async t => {
  const positionCols = columns(["id", "side", "qty", "stopLossId", "takeProfitId"]);
  const orderCols = columns(["id", "positionId", "side", "qty", "type", "status", "stopPrice", "price"]);
  const orders = [
    ["511", "42", "sell", 0.05, "stop", "Working", 4195, 0],
    ["512", "42", "sell", 0.05, "limit", "Working", 0, 4210],
  ];
  t.mock.method(globalThis, "fetch", async (input: string, options: RequestInit) => {
    assert.equal(options.method, "GET");
    const path = new URL(input).pathname;
    if (path.endsWith("/trade/config")) return Response.json({ d: { positionsConfig: positionCols, ordersConfig: orderCols } });
    if (path.endsWith("/positions")) return Response.json({ d: { positions: [["42", "buy", 0.05, "511", "512"]] } });
    assert.ok(path.endsWith("/orders"));
    return Response.json({ d: { orders } });
  });
  const port = new TradeLockerPort(ctx, true);
  const verified = await port.positions();
  assert.ok(verified.ok);
  assert.equal(verified.rows[0].stopLoss, 4195);
  assert.equal(verified.rows[0].takeProfit, 4210);
  orders[0][1] = "another-position";
  orders[1][3] = 0.01;
  const mismatched = await port.positions();
  assert.ok(mismatched.ok);
  assert.equal(mismatched.rows[0].stopLoss, null);
  assert.equal(mismatched.rows[0].takeProfit, null);
});
