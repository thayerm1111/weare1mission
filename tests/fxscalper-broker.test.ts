import test from "node:test";
import assert from "node:assert/strict";
import { DeadlineError, P, Scheduler, tlRequest } from "../src/lib/fxscalper/tl/transport";
import { columnsFrom, getHistory, getPositions, getState, placeMarketOrder, closePosition, modifyPosition, type Conn } from "../src/lib/fxscalper/tl/api";
import { resolveSymbol, specFrom, tiered } from "../src/lib/fxscalper/tl/discover";
import type { InstrumentRow } from "../src/lib/fxscalper/tl/api";

/**
 * FX Scalper: the TradeLocker layer against a fake broker. Nothing here reaches a real account.
 */

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function fakeFetch(handler: (c: Call, n: number) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string>; throws?: string }) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const c: Call = { url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = handler(c, calls.length);
    if (r.throws) throw Object.assign(new Error(r.throws), { name: r.throws === "abort" ? "AbortError" : "Error" });
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return { status: r.status ?? 200, text: async () => text, headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null } } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const withFetch = async <T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};

const conn = (sched = new Scheduler()): Conn => ({ env: "live", sched, accessToken: "tok", accountId: "810219", accNum: "2" });

test("the scheduler reads the broker's published limits and never runs a route faster", async () => {
  const s = new Scheduler();
  const applied = s.applyConfig({ d: { rateLimits: [{ rateLimitType: "QUOTES", measure: "SECONDS", intervalNum: 1, limit: 2 }] } });
  assert.match(applied.QUOTES, /2 per 1s/);
  const starts: number[] = [];
  await Promise.all([0, 1, 2, 3].map(() => s.run("QUOTES", P.BACKGROUND, async () => { starts.push(Date.now()); })));
  // 2 per (1.15 s + 50 ms): the third start waits for the window.
  assert.ok(starts[2] - starts[0] >= 1150, `third request after ${starts[2] - starts[0]} ms`);
});

test("protective work goes first; a request that cannot start by its deadline is not sent", async () => {
  const s = new Scheduler({ maxInFlight: 1 });
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const first = s.run("GET_POSITIONS", P.BACKGROUND, async () => { await gate; order.push("first"); });
  const bg = s.run("GET_ORDERS", P.BACKGROUND, async () => { order.push("background"); });
  const prot = s.run("CLOSE_POSITION", P.PROTECT, async () => { order.push("protect"); });
  const late = s.run("PLACE_ORDER", P.ENTRY, async () => { order.push("late"); }, Date.now() + 20);
  await new Promise((r) => setTimeout(r, 60));
  release();
  await Promise.all([first, bg, prot]);
  await assert.rejects(late, DeadlineError);
  assert.deepEqual(order, ["first", "protect", "background"]);
});

test("headers: Bearer token, accNum, and the documented developer-api-key (when configured)", async () => {
  process.env.TL_DEVELOPER_API_KEY = "tl-test";
  const f = fakeFetch(() => ({ body: { s: "ok", d: { ap: 1.1, bp: 1.0999 } } }));
  try {
    await withFetch(f.impl, () => tlRequest(new Scheduler(), { env: "live", type: "QUOTES", priority: P.BACKGROUND, method: "GET", path: "/trade/quotes?x=1", accessToken: "tok", accNum: "2" }, f.impl));
  } finally { delete process.env.TL_DEVELOPER_API_KEY; }
  const h = f.calls[0].headers;
  assert.equal(h.Authorization, "Bearer tok");
  assert.equal(h.accNum, "2");
  assert.equal(h["developer-api-key"], "tl-test");
  assert.ok(f.calls[0].url.startsWith("https://live.tradelocker.com/backend-api/"));
});

test("reads are retried on a 5xx; a 429 pauses that route for Retry-After", async () => {
  const s = new Scheduler();
  const f = fakeFetch((_c, n) => (n === 1 ? { status: 502, text: "bad gateway" } : { body: { s: "ok", d: { barDetails: [] } } }));
  const r = await tlRequest(s, { env: "live", type: "QUOTES_HISTORY", priority: P.SIGNAL, method: "GET", path: "/trade/history" }, f.impl);
  assert.equal(r.status, 200);
  assert.equal(f.calls.length, 2);
  const g = fakeFetch(() => ({ status: 429, text: "slow down", headers: { "retry-after": "1" } }));
  const t0 = Date.now();
  await tlRequest(s, { env: "live", type: "GET_ORDERS", priority: P.SYNC, method: "GET", path: "/x" }, g.impl);
  assert.ok(Date.now() - t0 >= 900, "the retry waited for Retry-After");
});

test("an order is sent ONCE: market, IOC, absolute stop and target, the label ≤ 31 characters, qty in lots", async () => {
  const f = fakeFetch(() => ({ body: { s: "ok", d: { orderId: "777" } } }));
  const r = await withFetch(f.impl, () => placeMarketOrder(conn(), { tradableInstrumentId: "1", routeId: "10", side: "buy", qty: 0.1, stopLoss: 1.07974, takeProfit: 1.08104, strategyId: "OMFX-EURUSD-abcdefghijklmnopqrstuvwxyz" }, null));
  assert.ok(r.ok && r.data.orderId === "777");
  assert.equal(f.calls.length, 1);
  const b = f.calls[0].body as Record<string, unknown>;
  assert.deepEqual({ type: b.type, validity: b.validity, side: b.side, qty: b.qty, routeId: b.routeId, stopLossType: b.stopLossType, takeProfitType: b.takeProfitType }, { type: "market", validity: "IOC", side: "buy", qty: 0.1, routeId: "10", stopLossType: "absolute", takeProfitType: "absolute" });
  assert.equal(b.stopLoss, 1.07974);
  assert.equal(b.takeProfit, 1.08104);
  assert.ok(String(b.strategyId).length <= 31);
  assert.equal(f.calls[0].method, "POST");
  assert.ok(f.calls[0].url.endsWith("/trade/accounts/810219/orders"), "accountId in the path");
});

test("a timeout or a 5xx on an order is UNCERTAIN (never retried); a 200 with s:error is a rejection; no order id is uncertain", async () => {
  const timeout = fakeFetch(() => ({ throws: "abort" }));
  const a = await withFetch(timeout.impl, () => placeMarketOrder(conn(), { tradableInstrumentId: "1", routeId: "10", side: "sell", qty: 0.1, stopLoss: 1.1, takeProfit: 1.09, strategyId: "OMFX-x" }, null));
  assert.ok(!a.ok && a.uncertain);
  assert.equal(timeout.calls.length, 1, "not re-sent");
  const five = fakeFetch(() => ({ status: 503, text: "unavailable" }));
  const b = await withFetch(five.impl, () => placeMarketOrder(conn(), { tradableInstrumentId: "1", routeId: "10", side: "sell", qty: 0.1, stopLoss: 1.1, takeProfit: 1.09, strategyId: "OMFX-x" }, null));
  assert.ok(!b.ok && b.uncertain && five.calls.length === 1);
  const refused = fakeFetch(() => ({ body: { s: "error", errmsg: "Not enough money" } }));
  const c = await withFetch(refused.impl, () => placeMarketOrder(conn(), { tradableInstrumentId: "1", routeId: "10", side: "sell", qty: 0.1, stopLoss: 1.1, takeProfit: 1.09, strategyId: "OMFX-x" }, null));
  assert.ok(!c.ok && !c.uncertain && c.error === "Not enough money");
  const blank = fakeFetch(() => ({ body: { s: "ok", d: {} } }));
  const d = await withFetch(blank.impl, () => placeMarketOrder(conn(), { tradableInstrumentId: "1", routeId: "10", side: "sell", qty: 0.1, stopLoss: 1.1, takeProfit: 1.09, strategyId: "OMFX-x" }, null));
  assert.ok(!d.ok && d.uncertain);
});

test("an order whose signal window has passed is not sent at all", async () => {
  const f = fakeFetch(() => ({ body: { s: "ok", d: { orderId: "1" } } }));
  const r = await withFetch(f.impl, () => placeMarketOrder(conn(), { tradableInstrumentId: "1", routeId: "10", side: "buy", qty: 0.1, stopLoss: 1, takeProfit: 2, strategyId: "OMFX-x" }, Date.now() - 1));
  assert.ok(!r.ok && !r.uncertain && /not sent/.test(r.error));
  assert.equal(f.calls.length, 0);
});

test("closing a position is a full close (qty 0); stop/target changes are absolute prices", async () => {
  const f = fakeFetch(() => ({ body: { s: "ok" } }));
  await withFetch(f.impl, async () => {
    await closePosition(conn(), "555");
    await modifyPosition(conn(), "555", { stopLoss: 1.07979, takeProfit: 1.08109 });
  });
  assert.equal(f.calls[0].method, "DELETE");
  assert.ok(f.calls[0].url.endsWith("/trade/positions/555"));
  assert.deepEqual(f.calls[0].body, { qty: 0 });
  assert.equal(f.calls[1].method, "PATCH");
  assert.deepEqual(f.calls[1].body, { stopLoss: 1.07979, takeProfit: 1.08109 });
});

test("columnar rows are read by the config's column ids, never by guessed position", async () => {
  const config = {
    positionsConfig: { columns: ["id", "tradableInstrumentId", "routeId", "side", "qty", "avgPrice", "stopLossId", "takeProfitId", "openDate", "unrealizedPl", "strategyId"].map((id) => ({ id })) },
    ordersConfig: { columns: [{ id: "id" }] }, ordersHistoryConfig: { columns: [{ id: "id" }] }, filledOrdersConfig: { columns: [{ id: "id" }] },
    accountDetailsConfig: { columns: ["balance", "projectedBalance", "availableFunds"].map((id) => ({ id })) },
  };
  const { columns, missing } = columnsFrom(config);
  assert.deepEqual(missing, []);
  const f = fakeFetch((c) => c.url.includes("/positions")
    ? { body: { s: "ok", d: { positions: [["91", "1", "10", "buy", "0.1", "1.08004", "92", "0", "1761231600000", "-0.4", "OMFX-EURUSD-x"]] } } }
    : { body: { s: "ok", d: { accountDetailsData: [1000, 1012.5, 900] } } });
  const pos = await withFetch(f.impl, () => getPositions(conn(), columns, P.SYNC));
  assert.ok(pos.ok);
  if (pos.ok) assert.deepEqual(pos.data[0], { id: "91", tradableInstrumentId: "1", routeId: "10", side: "buy", qty: 0.1, avgPrice: 1.08004, stopLossId: "92", takeProfitId: null, openDate: 1761231600000, unrealizedPl: -0.4, strategyId: "OMFX-EURUSD-x" });
  const st = await withFetch(f.impl, () => getState(conn(), columns, P.SYNC));
  assert.ok(st.ok && st.data.projectedBalance === 1012.5 && st.data.availableFunds === 900);
  assert.ok(columnsFrom({}).missing.length === 5, "missing sections are reported");
});

test("candles: ms timestamps, sorted, 'no_data' is an empty list, junk rows dropped", async () => {
  const T = Date.UTC(2026, 9, 23, 14, 0);
  const f = fakeFetch((_c, n) => n === 1
    ? { body: { s: "ok", d: { barDetails: [{ t: T + 120000, o: 1, h: 1.2, l: 0.9, c: 1.1 }, { t: T + 60000, o: 1, h: 1.1, l: 0.95, c: 1.05 }, { t: T + 180000, o: 1, h: 0.5, l: 0.9, c: 1 }] } } }
    : { body: { s: "no_data", nb: 1 } });
  const a = await withFetch(f.impl, () => getHistory(conn(), "1", "11", "1m", 0, 200000, P.SIGNAL));
  assert.ok(a.ok && a.data.length === 2 && a.data[0].t === T + 60000, "sorted, the bar with high < low dropped");
  const b = await withFetch(f.impl, () => getHistory(conn(), "1", "11", "1m", 0, 200000, P.SIGNAL));
  assert.ok(b.ok && b.data.length === 0);
  assert.ok(f.calls[0].url.includes("routeId=11") && f.calls[0].url.includes("resolution=1m"));
});

const row = (name: string, extra: Partial<InstrumentRow> = {}): InstrumentRow => ({ tradableInstrumentId: name, name, type: "FOREX", tradeRouteId: "T", infoRouteIds: ["I"], barSource: "BID", raw: {}, ...extra });

test("symbols are found on the account, never assumed; two candidates block until the owner chooses", () => {
  assert.equal((resolveSymbol([row("EURUSD.r"), row("GBPUSD")], "EURUSD") as { row: InstrumentRow }).row.name, "EURUSD.r");
  assert.equal((resolveSymbol([row("EURUSD"), row("EURUSD.raw")], "EURUSD") as { row: InstrumentRow }).row.name, "EURUSD", "the plain name wins when exactly one is plain");
  const amb = resolveSymbol([row("EURUSD.a"), row("EURUSD.b")], "EURUSD");
  assert.ok(!amb.ok && amb.candidates.length === 2);
  const chosen = resolveSymbol([row("EURUSD.a"), row("EURUSD.b")], "EURUSD", "EURUSD.b");
  assert.ok(chosen.ok && chosen.row.name === "EURUSD.b");
  assert.ok(!resolveSymbol([row("GBPUSD")], "EURUSD").ok);
  assert.ok(!resolveSymbol([row("EURUSD")], "USDCAD").ok);
});

test("contract details must make sense for the pair before it can trade", () => {
  const d = { lotSize: 100000, lotStep: 0.01, minLot: 0.01, maxLot: 100, tickSize: [{ leftRangeLimit: null, tickSize: 0.00001 }], barSource: "BID", quotingCurrency: "USD", leverage: "500.00" };
  const good = specFrom("EURUSD", row("EURUSD"), d, "I");
  assert.ok(good.ok && good.spec.decimals === 5 && good.spec.leverage === 500);
  assert.ok(!specFrom("EURUSD", row("EURUSD"), { ...d, tickSize: [{ leftRangeLimit: null, value: 0.001 }] }, "I").ok, "a tick coarser than a pip");
  assert.ok(!specFrom("EURUSD", row("EURUSD"), { ...d, quotingCurrency: "JPY" }, "I").ok, "the wrong quoting currency");
  assert.ok(!specFrom("EURUSD", row("EURUSD"), { ...d, leverage: null }, "I").ok, "no leverage, no margin estimate");
  assert.ok(!specFrom("EURUSD", row("EURUSD"), { ...d, lotSize: 1 }, "I").ok, "a lot size that is not a currency lot");
  assert.ok(!specFrom("EURUSD", row("EURUSD"), d, null).ok, "no working quote route");
  assert.equal(tiered([{ leftRangeLimit: 100, value: 0.1 }, { leftRangeLimit: null, value: 0.01 }]), 0.01, "the base price band applies");
});
