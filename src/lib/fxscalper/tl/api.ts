import { brokerError, describe, P, tlRequest, type Priority, type RawResponse, type Scheduler, type TLEnv } from "./transport";

/**
 * TRADELOCKER OPERATIONS for the FX Scalper (official REST API, "Trading API" v2.11 as published at
 * public-api.tradelocker.com, cross-checked with the official Python SDK, 10-23).
 *
 * Identity discipline, because these are easy to confuse and expensive to get wrong:
 *   • `accountId` goes in the PATH; `accNum` goes in the `accNum` HEADER. They are different values.
 *   • Quotes and candles use the instrument's INFO route; orders use its TRADE route.
 *   • An order id is not a position id. An acknowledgement is not a fill. A close request is not a
 *     confirmed closure.
 *
 * QUANTITY. The order `qty` is in LOTS. The reference page for placing an order calls it "units", but
 * the same documentation gives minLot/maxLot "in lots", lotSize "in units", sizes a close in "lots",
 * computes order capital as "Qty × Lot size × Price", and the official SDK checks qty against a 0.01
 * minimum; every order this repository has placed on this broker used lots. The worker also checks the
 * first live fill against it (the position's P&L per price move) and stops if the two disagree.
 *
 * Rows from positions/orders/history/executions/state arrive as positional arrays described by
 * /trade/config; they are read here by column id, never by guessed position.
 */

export type Conn = {
  env: TLEnv;
  sched: Scheduler;
  accessToken: string;
  accountId: string;
  accNum: string;
};

export type Ok<T> = { ok: true; data: T; status: number; latencyMs: number };
export type Fail = { ok: false; status: number; error: string; latencyMs: number; uncertain: boolean; unauthorized: boolean; limited: boolean };
export type Res<T> = Ok<T> | Fail;

const ok = <T>(data: T, r: RawResponse): Ok<T> => ({ ok: true, data, status: r.status, latencyMs: r.latencyMs });
const fail = (r: RawResponse, error: string, uncertain = false): Fail => ({
  ok: false, status: r.status, error, latencyMs: r.latencyMs, uncertain, unauthorized: r.status === 401, limited: r.limited,
});

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
/** Broker timestamps are milliseconds (number or numeric string) or ISO strings. */
export const tsOf = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
  const p = Date.parse(String(v));
  return Number.isFinite(p) ? p : null;
};

const good = (r: RawResponse) => r.status >= 200 && r.status < 300 && !brokerError(r.json) && !r.networkError;
const root = (j: unknown) => ((j as { d?: unknown })?.d ?? j) as Record<string, unknown> | null;

// ---- Authentication (no account context yet) --------------------------------------------------------

export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number | null };

function tokensFrom(r: RawResponse): Tokens | null {
  const d = (r.json ?? {}) as Record<string, unknown>;
  const accessToken = str(d.accessToken ?? d.access_token);
  const refreshToken = str(d.refreshToken ?? d.refresh_token);
  if (!accessToken || !refreshToken) return null;
  const exp = tsOf(d.expireDate) ?? (num(d.expiresIn) != null ? Date.now() + Number(d.expiresIn) * 1000 : null);
  return { accessToken, refreshToken, expiresAt: exp };
}

export async function signIn(sched: Scheduler, env: TLEnv, email: string, password: string, server: string): Promise<Res<Tokens>> {
  const r = await tlRequest(sched, { env, type: "AUTH", priority: P.PROTECT, method: "POST", path: "/auth/jwt/token", body: { email, password, server } });
  if (!good(r)) {
    const msg = r.status === 401 || r.status === 403 ? "TradeLocker refused the sign-in — check the email, password and server name" : describe(r, "sign-in failed");
    return fail(r, msg);
  }
  const t = tokensFrom(r);
  return t ? ok(t, r) : fail(r, "the broker returned no token pair");
}

export async function refreshTokens(sched: Scheduler, env: TLEnv, refreshToken: string): Promise<Res<Tokens>> {
  const r = await tlRequest(sched, { env, type: "AUTH", priority: P.PROTECT, method: "POST", path: "/auth/jwt/refresh", body: { refreshToken } });
  if (!good(r)) return fail(r, describe(r, "token refresh failed"));
  const t = tokensFrom(r);
  return t ? ok(t, r) : fail(r, "the refresh returned no token pair");
}

export type AccountRow = { accountId: string; accNum: string; name: string | null; currency: string | null; status: string | null; balance: number | null };

export async function allAccounts(sched: Scheduler, env: TLEnv, accessToken: string): Promise<Res<AccountRow[]>> {
  const r = await tlRequest(sched, { env, type: "GET_ACCOUNTS", priority: P.SYNC, method: "GET", path: "/auth/jwt/all-accounts", accessToken });
  if (!good(r)) return fail(r, describe(r, "account list unavailable"));
  const list = (root(r.json)?.accounts ?? (r.json as Record<string, unknown> | null)?.accounts) as unknown;
  if (!Array.isArray(list)) return fail(r, "the account list was unreadable");
  const rows: AccountRow[] = [];
  for (const a of list as Array<Record<string, unknown>>) {
    const accountId = str(a.id ?? a.accountId);
    const accNum = str(a.accNum);
    if (!accountId || !accNum) continue;
    rows.push({
      accountId, accNum, name: str(a.name), currency: str(a.currency), status: str(a.status),
      // The documented key really is spelled "aaccountBalance".
      balance: num(a.aaccountBalance ?? a.accountBalance ?? a.balance),
    });
  }
  return ok(rows, r);
}

// ---- Account-scoped reads ---------------------------------------------------------------------------

const get = (c: Conn, type: Parameters<typeof tlRequest>[1]["type"], path: string, priority: Priority, deadlineAt?: number | null) =>
  tlRequest(c.sched, { env: c.env, type, priority, method: "GET", path, accessToken: c.accessToken, accNum: c.accNum, deadlineAt: deadlineAt ?? null });

export async function getConfig(c: Conn): Promise<Res<Record<string, unknown>>> {
  const r = await get(c, "CONFIG", "/trade/config", P.BACKGROUND);
  if (!good(r)) return fail(r, describe(r, "broker config unavailable"));
  return ok(root(r.json) ?? {}, r);
}

export type TradeAccount = { accountId: string; accNum: string; status: string | null; type: string | null; currency: string | null; riskRules: Record<string, unknown>; tradingRules: Record<string, unknown> };

export async function getTradeAccounts(c: Conn): Promise<Res<TradeAccount[]>> {
  const r = await get(c, "GET_ACCOUNTS", "/trade/accounts", P.SYNC);
  if (!good(r)) return fail(r, describe(r, "account details unavailable"));
  const d = root(r.json);
  const list = (Array.isArray(d) ? d : (d?.accounts ?? d?.d)) as unknown;
  if (!Array.isArray(list)) return fail(r, "the account details were unreadable");
  return ok((list as Array<Record<string, unknown>>).map((a) => ({
    accountId: String(a.id ?? a.accountId ?? ""), accNum: String(a.accNum ?? ""), status: str(a.status), type: str(a.type), currency: str(a.currency),
    riskRules: (a.riskRules ?? {}) as Record<string, unknown>, tradingRules: (a.tradingRules ?? {}) as Record<string, unknown>,
  })), r);
}

export type InstrumentRow = { tradableInstrumentId: string; name: string; type: string | null; tradeRouteId: string | null; infoRouteIds: string[]; barSource: string | null; raw: Record<string, unknown> };

export async function getInstruments(c: Conn): Promise<Res<InstrumentRow[]>> {
  const r = await get(c, "GET_INSTRUMENTS", `/trade/accounts/${encodeURIComponent(c.accountId)}/instruments`, P.BACKGROUND);
  if (!good(r)) return fail(r, describe(r, "instrument list unavailable"));
  const list = root(r.json)?.instruments as unknown;
  if (!Array.isArray(list)) return fail(r, "the instrument list was unreadable");
  const rows: InstrumentRow[] = [];
  for (const i of list as Array<Record<string, unknown>>) {
    const id = str(i.tradableInstrumentId ?? i.id);
    if (!id) continue;
    const routes = Array.isArray(i.routes) ? (i.routes as Array<Record<string, unknown>>) : [];
    const typeOf = (rt: Record<string, unknown>) => String(rt.type ?? "").toUpperCase();
    const trade = routes.find((rt) => typeOf(rt) === "TRADE");
    rows.push({
      tradableInstrumentId: id,
      name: String(i.name ?? ""),
      type: str(i.type),
      tradeRouteId: trade ? str(trade.id) : null,
      infoRouteIds: routes.filter((rt) => typeOf(rt) === "INFO").map((rt) => String(rt.id)),
      barSource: str(i.barSource),
      raw: i,
    });
  }
  return ok(rows, r);
}

export async function getInstrumentDetails(c: Conn, tradableInstrumentId: string, routeId: string): Promise<Res<Record<string, unknown>>> {
  const r = await get(c, "GET_INSTRUMENT_DETAILS", `/trade/instruments/${encodeURIComponent(tradableInstrumentId)}?routeId=${encodeURIComponent(routeId)}`, P.BACKGROUND);
  if (!good(r)) return fail(r, describe(r, "contract details unavailable"));
  return ok(root(r.json) ?? {}, r);
}

export type BrokerQuote = { bid: number; ask: number; bidSize: number | null; askSize: number | null; receivedAt: number; latencyMs: number };

export async function getQuote(c: Conn, tradableInstrumentId: string, infoRouteId: string, priority: Priority, deadlineAt?: number | null): Promise<Res<BrokerQuote>> {
  const r = await get(c, "QUOTES", `/trade/quotes?routeId=${encodeURIComponent(infoRouteId)}&tradableInstrumentId=${encodeURIComponent(tradableInstrumentId)}`, priority, deadlineAt);
  if (!good(r)) return fail(r, describe(r, "quote unavailable"));
  const d = root(r.json) ?? {};
  const bid = num(d.bp ?? d.bid), ask = num(d.ap ?? d.ask);
  if (bid == null || ask == null || !(bid > 0) || !(ask > 0)) return fail(r, "the quote had no bid/ask");
  // TradeLocker's quote carries no timestamp: its age is the age of OUR receipt of it, and is labelled so.
  return ok({ bid, ask, bidSize: num(d.bs), askSize: num(d.as), receivedAt: Date.now(), latencyMs: r.latencyMs }, r);
}

export type Candle = { t: number; o: number; h: number; l: number; c: number };

export async function getHistory(c: Conn, tradableInstrumentId: string, infoRouteId: string, resolution: "1m" | "5m", fromMs: number, toMs: number, priority: Priority, deadlineAt?: number | null): Promise<Res<Candle[]>> {
  const q = `routeId=${encodeURIComponent(infoRouteId)}&tradableInstrumentId=${encodeURIComponent(tradableInstrumentId)}&resolution=${resolution}&from=${Math.floor(fromMs)}&to=${Math.floor(toMs)}`;
  const r = await get(c, "QUOTES_HISTORY", `/trade/history?${q}`, priority, deadlineAt);
  if (r.status >= 200 && r.status < 300 && String((r.json as { s?: unknown } | null)?.s ?? "") === "no_data") return ok([], r);
  if (!good(r)) return fail(r, describe(r, "candles unavailable"));
  const bars = root(r.json)?.barDetails as unknown;
  if (!Array.isArray(bars)) return fail(r, "the candles were unreadable");
  const out: Candle[] = [];
  for (const b of bars as Array<Record<string, unknown>>) {
    const t = tsOf(b.t), o = num(b.o), h = num(b.h), l = num(b.l), cl = num(b.c);
    if (t == null || o == null || h == null || l == null || cl == null) continue;
    if (!(h >= l) || o <= 0 || cl <= 0) continue;
    out.push({ t, o, h, l, c: cl });
  }
  out.sort((a, b) => a.t - b.t);
  return ok(out, r);
}

// ---- Columnar sections (/trade/config) ----------------------------------------------------------------

export type Columns = { positions: string[]; orders: string[]; ordersHistory: string[]; filledOrders: string[]; accountDetails: string[] };

/** Column ids per section, from the config. A missing section is reported, not guessed. */
export function columnsFrom(config: Record<string, unknown>): { columns: Columns; missing: string[] } {
  const ids = (key: string): string[] => {
    const sec = config[key] as { columns?: Array<{ id?: unknown }> } | undefined;
    return Array.isArray(sec?.columns) ? sec!.columns.map((x) => String(x?.id ?? "")) : [];
  };
  const columns: Columns = {
    positions: ids("positionsConfig"),
    orders: ids("ordersConfig"),
    ordersHistory: ids("ordersHistoryConfig"),
    filledOrders: ids("filledOrdersConfig"),
    accountDetails: ids("accountDetailsConfig"),
  };
  const missing = (Object.keys(columns) as Array<keyof Columns>).filter((k) => !columns[k].length);
  return { columns, missing };
}

const rowOf = (row: unknown, cols: string[]): Record<string, unknown> => {
  if (Array.isArray(row)) return Object.fromEntries(cols.map((c, i) => [c, row[i]]));
  return (row ?? {}) as Record<string, unknown>;
};

function listFrom(r: RawResponse, ...keys: string[]): unknown[] | null {
  const d = root(r.json);
  for (const k of keys) {
    const v = d?.[k] ?? (r.json as Record<string, unknown> | null)?.[k];
    if (Array.isArray(v)) return v;
  }
  return null;
}

export type Position = {
  id: string; tradableInstrumentId: string; routeId: string | null; side: "buy" | "sell" | null; qty: number | null;
  avgPrice: number | null; stopLossId: string | null; takeProfitId: string | null; openDate: number | null;
  unrealizedPl: number | null; strategyId: string | null;
};

const sideOf = (v: unknown): "buy" | "sell" | null => {
  const s = String(v ?? "").toLowerCase();
  return s === "buy" ? "buy" : s === "sell" ? "sell" : null;
};
const idOrNull = (v: unknown): string | null => {
  const s = str(v);
  return s == null || s === "0" || s.toLowerCase() === "null" ? null : s;
};

export async function getPositions(c: Conn, cols: Columns, priority: Priority): Promise<Res<Position[]>> {
  const r = await get(c, "GET_POSITIONS", `/trade/accounts/${encodeURIComponent(c.accountId)}/positions`, priority);
  if (!good(r)) return fail(r, describe(r, "positions unavailable"));
  const list = listFrom(r, "positions");
  if (!list) return fail(r, "the positions were unreadable");
  return ok(list.map((row) => {
    const x = rowOf(row, cols.positions);
    return {
      id: String(x.id ?? ""), tradableInstrumentId: String(x.tradableInstrumentId ?? ""), routeId: str(x.routeId),
      side: sideOf(x.side), qty: num(x.qty), avgPrice: num(x.avgPrice), stopLossId: idOrNull(x.stopLossId),
      takeProfitId: idOrNull(x.takeProfitId), openDate: tsOf(x.openDate), unrealizedPl: num(x.unrealizedPl), strategyId: str(x.strategyId),
    };
  }).filter((p) => p.id), r);
}

export type Order = {
  id: string; tradableInstrumentId: string; qty: number | null; side: "buy" | "sell" | null; type: string | null; status: string | null;
  filledQty: number | null; avgPrice: number | null; price: number | null; stopPrice: number | null; createdDate: number | null;
  lastModified: number | null; isOpen: boolean | null; positionId: string | null; stopLoss: number | null; takeProfit: number | null; strategyId: string | null;
};

const orderOf = (x: Record<string, unknown>): Order => ({
  id: String(x.id ?? ""), tradableInstrumentId: String(x.tradableInstrumentId ?? ""), qty: num(x.qty), side: sideOf(x.side),
  type: str(x.type), status: str(x.status), filledQty: num(x.filledQty), avgPrice: num(x.avgPrice), price: num(x.price),
  stopPrice: num(x.stopPrice), createdDate: tsOf(x.createdDate), lastModified: tsOf(x.lastModified),
  isOpen: x.isOpen == null ? null : String(x.isOpen).toLowerCase() === "true", positionId: idOrNull(x.positionId),
  stopLoss: num(x.stopLoss), takeProfit: num(x.takeProfit), strategyId: str(x.strategyId),
});

export async function getOrders(c: Conn, cols: Columns, priority: Priority): Promise<Res<Order[]>> {
  const r = await get(c, "GET_ORDERS", `/trade/accounts/${encodeURIComponent(c.accountId)}/orders`, priority);
  if (!good(r)) return fail(r, describe(r, "orders unavailable"));
  const list = listFrom(r, "orders");
  if (!list) return fail(r, "the orders were unreadable");
  return ok(list.map((row) => orderOf(rowOf(row, cols.orders))).filter((o) => o.id), r);
}

export async function getOrdersHistory(c: Conn, cols: Columns, opts: { fromMs: number; toMs?: number; tradableInstrumentId?: string }, priority: Priority): Promise<Res<{ orders: Order[]; hasMore: boolean }>> {
  const q = new URLSearchParams({ from: String(Math.floor(opts.fromMs)) });
  if (opts.toMs != null) q.set("to", String(Math.floor(opts.toMs)));
  if (opts.tradableInstrumentId) q.set("tradableInstrumentId", opts.tradableInstrumentId);
  const r = await get(c, "GET_ORDERS_HISTORY", `/trade/accounts/${encodeURIComponent(c.accountId)}/ordersHistory?${q}`, priority);
  if (!good(r)) return fail(r, describe(r, "order history unavailable"));
  const list = listFrom(r, "ordersHistory", "orders");
  if (!list) return fail(r, "the order history was unreadable");
  const hasMore = Boolean(root(r.json)?.hasMore);
  return ok({ orders: list.map((row) => orderOf(rowOf(row, cols.ordersHistory.length ? cols.ordersHistory : cols.orders))).filter((o) => o.id), hasMore }, r);
}

export type Execution = { id: string; price: number | null; side: "buy" | "sell" | null; createdDate: number | null; qty: number | null; orderId: string | null; positionId: string | null; tradableInstrumentId: string | null };

export async function getExecutions(c: Conn, cols: Columns, priority: Priority): Promise<Res<Execution[]>> {
  const r = await get(c, "GET_EXECUTIONS", `/trade/accounts/${encodeURIComponent(c.accountId)}/executions`, priority);
  if (!good(r)) return fail(r, describe(r, "executions unavailable"));
  const list = listFrom(r, "executions");
  if (!list) return fail(r, "the executions were unreadable");
  return ok(list.map((row) => {
    const x = rowOf(row, cols.filledOrders);
    return { id: String(x.id ?? ""), price: num(x.price), side: sideOf(x.side), createdDate: tsOf(x.createdDate), qty: num(x.qty), orderId: idOrNull(x.orderId), positionId: idOrNull(x.positionId), tradableInstrumentId: str(x.tradableInstrumentId) };
  }).filter((e) => e.id), r);
}

export type AccountState = Record<string, number | null>;

export async function getState(c: Conn, cols: Columns, priority: Priority): Promise<Res<AccountState>> {
  const r = await get(c, "GET_ACCOUNTS_STATE", `/trade/accounts/${encodeURIComponent(c.accountId)}/state`, priority);
  if (!good(r)) return fail(r, describe(r, "account state unavailable"));
  const d = root(r.json);
  const arr = d?.accountDetailsData as unknown;
  if (Array.isArray(arr)) return ok(Object.fromEntries(cols.accountDetails.map((id, i) => [id, num(arr[i])])), r);
  if (d && typeof d === "object") return ok(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, num(v)])), r);
  return fail(r, "the account state was unreadable");
}

// ---- Writes -----------------------------------------------------------------------------------------

export type PlaceOrder = {
  tradableInstrumentId: string;
  /** The TRADE route. */
  routeId: string;
  side: "buy" | "sell";
  /** Lots. */
  qty: number;
  stopLoss: number;
  takeProfit: number;
  /** Ownership label (≤ 31 characters). Identification only — the broker does not deduplicate on it. */
  strategyId: string;
};

/**
 * A market order, IOC (the only validity the broker allows for market orders), with the stop and target
 * attached as absolute prices. Sent once. A timeout, a 5xx or an answer without an order id is
 * `uncertain`: the order may exist, and the caller must reconcile before doing anything else.
 */
export async function placeMarketOrder(c: Conn, o: PlaceOrder, deadlineAt: number | null): Promise<Res<{ orderId: string }>> {
  const body = {
    tradableInstrumentId: o.tradableInstrumentId,
    routeId: o.routeId,
    side: o.side,
    qty: o.qty,
    type: "market",
    validity: "IOC",
    stopLoss: o.stopLoss,
    stopLossType: "absolute",
    takeProfit: o.takeProfit,
    takeProfitType: "absolute",
    strategyId: o.strategyId.slice(0, 31),
  };
  const r = await tlRequest(c.sched, { env: c.env, type: "PLACE_ORDER", priority: P.ENTRY, method: "POST", path: `/trade/accounts/${encodeURIComponent(c.accountId)}/orders`, accessToken: c.accessToken, accNum: c.accNum, body, deadlineAt });
  // Could not START before the signal's deadline: nothing was sent, so nothing can have happened.
  if (r.notSent) return fail(r, `not sent: ${r.networkError ?? "deadline passed"}`);
  if (r.networkError || r.status === 0 || r.status === 408 || r.status >= 500) return fail(r, describe(r, "the order's outcome is unknown"), true);
  if (r.limited) return fail(r, describe(r, "order refused"));
  const err = brokerError(r.json);
  if (err) return fail(r, err);
  if (r.status < 200 || r.status >= 300) return fail(r, describe(r, "order refused"));
  const orderId = str(root(r.json)?.orderId);
  if (!orderId) return fail(r, "the broker accepted the request but returned no order id", true);
  return ok({ orderId }, r);
}

/**
 * Set a position's stop and target (absolute prices). `null` REMOVES that leg (the documented way);
 * a leg left undefined is not sent and stays as it is. Re-sending the same values is harmless.
 */
export async function modifyPosition(c: Conn, positionId: string, m: { stopLoss?: number | null; takeProfit?: number | null }): Promise<Res<true>> {
  const body: Record<string, number | null> = {};
  if (m.stopLoss !== undefined) body.stopLoss = m.stopLoss;
  if (m.takeProfit !== undefined) body.takeProfit = m.takeProfit;
  const r = await tlRequest(c.sched, { env: c.env, type: "MODIFY_POSITION", priority: P.PROTECT, method: "PATCH", path: `/trade/positions/${encodeURIComponent(positionId)}`, accessToken: c.accessToken, accNum: c.accNum, body });
  if (!good(r)) return fail(r, describe(r, "stop/target change refused"), r.networkError != null || r.status >= 500);
  return ok(true, r);
}

/** Close the whole position (qty 0 = all). A success means REQUESTED; closure is confirmed separately. */
export async function closePosition(c: Conn, positionId: string): Promise<Res<true>> {
  const r = await tlRequest(c.sched, { env: c.env, type: "CLOSE_POSITION", priority: P.PROTECT, method: "DELETE", path: `/trade/positions/${encodeURIComponent(positionId)}`, accessToken: c.accessToken, accNum: c.accNum, body: { qty: 0 } });
  if (!good(r)) return fail(r, describe(r, "close refused"), r.networkError != null || r.status >= 500);
  return ok(true, r);
}

/** Cancelling something already gone counts as done. */
export async function cancelOrder(c: Conn, orderId: string): Promise<Res<true>> {
  const r = await tlRequest(c.sched, { env: c.env, type: "CANCEL_ORDER", priority: P.PROTECT, method: "DELETE", path: `/trade/orders/${encodeURIComponent(orderId)}`, accessToken: c.accessToken, accNum: c.accNum });
  if (r.status === 404 || r.status === 410) return ok(true, r);
  const err = brokerError(r.json);
  if (err && /not found|no such|already|not working|unknown order/i.test(err)) return ok(true, r);
  if (!good(r)) return fail(r, describe(r, "cancel refused"), r.networkError != null || r.status >= 500);
  return ok(true, r);
}

/** EVERY position on the account — the owner's own and other tools' included. Owner-labelled control only. */
export async function closeAllAccountPositions(c: Conn): Promise<Res<true>> {
  const r = await tlRequest(c.sched, { env: c.env, type: "CLOSE_POSITION", priority: P.PROTECT, method: "DELETE", path: `/trade/accounts/${encodeURIComponent(c.accountId)}/positions`, accessToken: c.accessToken, accNum: c.accNum });
  if (!good(r)) return fail(r, describe(r, "close-all refused"), r.networkError != null || r.status >= 500);
  return ok(true, r);
}
