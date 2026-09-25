import type { InstrumentSpec, Quote, Side } from "../core/types";
import { brokerError, columnMap, field, readCollection, tlFetch, type Priority, type TLEnv, type TLResult } from "./http";

/**
 * Typed TradeLocker operations.
 *
 * Identity discipline, because these are easy to confuse and expensive to get wrong:
 *   - `accountId` is a PATH segment. `accNum` is a HEADER. They are different values.
 *   - An INFO route is for quotes. A TRADE route is for orders. Sending one where the other belongs
 *     produces a plausible-looking failure.
 *   - `orderId` is not `positionId`. An acknowledgement is not a fill.
 */

export type TLTokens = { accessToken: string; refreshToken: string; expiresAt: number | null };

export type TLAccount = {
  accountId: string;
  accNum: string;
  name: string | null;
  currency: string | null;
  balance: number | null;
  equity: number | null;
};

const ok = <T>(data: T, status: number, latencyMs: number): TLResult<T> => ({ ok: true, data, status, latencyMs });
const bad = (status: number, error: string, latencyMs: number, uncertain = false, raw?: unknown): TLResult<never> => ({ ok: false, status, error, latencyMs, uncertain, raw });

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (v == null ? null : String(v));

// ---- Authentication ------------------------------------------------------------------------------

export async function authenticate(env: TLEnv, email: string, password: string, server: string): Promise<TLResult<TLTokens>> {
  const r = await tlFetch(env, "/auth/jwt/token", { method: "POST", body: JSON.stringify({ email, password, server }), priority: "auth" });
  const err = brokerError(r.json);
  if (r.status < 200 || r.status >= 300 || err) return bad(r.status, err ?? `sign-in failed (${r.status})`, r.latencyMs);
  const d = (r.json as Record<string, unknown>) ?? {};
  const accessToken = str(d.accessToken ?? d.access_token);
  const refreshToken = str(d.refreshToken ?? d.refresh_token);
  if (!accessToken || !refreshToken) return bad(r.status, "broker returned no token pair", r.latencyMs);
  return ok({ accessToken, refreshToken, expiresAt: num(d.expiresIn) ? Date.now() + Number(d.expiresIn) * 1000 : null }, r.status, r.latencyMs);
}

export async function refresh(env: TLEnv, refreshToken: string): Promise<TLResult<TLTokens>> {
  const r = await tlFetch(env, "/auth/jwt/refresh", { method: "POST", body: JSON.stringify({ refreshToken }), priority: "auth" });
  const err = brokerError(r.json);
  if (r.status < 200 || r.status >= 300 || err) return bad(r.status, err ?? `token refresh failed (${r.status})`, r.latencyMs);
  const d = (r.json as Record<string, unknown>) ?? {};
  const accessToken = str(d.accessToken ?? d.access_token);
  if (!accessToken) return bad(r.status, "refresh returned no access token", r.latencyMs);
  return ok({ accessToken, refreshToken: str(d.refreshToken ?? d.refresh_token) ?? refreshToken, expiresAt: null }, r.status, r.latencyMs);
}

export async function listAccounts(env: TLEnv, accessToken: string): Promise<TLResult<TLAccount[]>> {
  const r = await tlFetch(env, "/auth/jwt/all-accounts", { accessToken, priority: "auth" });
  const err = brokerError(r.json);
  if (r.status < 200 || r.status >= 300 || err) return bad(r.status, err ?? `account discovery failed (${r.status})`, r.latencyMs);
  const coll = readCollection(r.json, "accounts");
  if (!coll.ok) return bad(r.status, coll.error, r.latencyMs);
  const rows: TLAccount[] = [];
  for (const a of coll.data as Array<Record<string, unknown>>) {
    const accountId = str(a.id ?? a.accountId);
    if (!accountId) continue;
    rows.push({
      accountId,
      accNum: str(a.accNum ?? a.accountNum) ?? "",
      name: str(a.name ?? a.accountName),
      currency: str(a.currency),
      balance: num(a.accountBalance ?? a.balance),
      equity: num(a.equity),
    });
  }
  return ok(rows, r.status, r.latencyMs);
}

// ---- Reference data --------------------------------------------------------------------------------

export async function getConfig(env: TLEnv, accessToken: string, accNum: string): Promise<TLResult<unknown>> {
  const r = await tlFetch(env, "/trade/config", { accessToken, accNum, priority: "background" });
  const err = brokerError(r.json);
  if (r.status < 200 || r.status >= 300 || err) return bad(r.status, err ?? `config unavailable (${r.status})`, r.latencyMs);
  return ok(r.json, r.status, r.latencyMs);
}

export type TLInstrumentRow = {
  tradableInstrumentId: string;
  brokerSymbol: string;
  tradeRouteId: string;
  infoRouteId: string;
  raw: unknown;
};

export async function listInstruments(env: TLEnv, accessToken: string, accNum: string, accountId: string): Promise<TLResult<TLInstrumentRow[]>> {
  const r = await tlFetch(env, `/trade/accounts/${encodeURIComponent(accountId)}/instruments`, { accessToken, accNum, priority: "background" });
  const err = brokerError(r.json);
  if (r.status < 200 || r.status >= 300 || err) return bad(r.status, err ?? `instruments unavailable (${r.status})`, r.latencyMs);
  const coll = readCollection(r.json, "instruments");
  if (!coll.ok) return bad(r.status, coll.error, r.latencyMs);

  const rows: TLInstrumentRow[] = [];
  for (const i of coll.data as Array<Record<string, unknown>>) {
    const id = str(i.tradableInstrumentId ?? i.id);
    if (!id) continue;
    const routes = Array.isArray(i.routes) ? (i.routes as Array<Record<string, unknown>>) : [];
    const typeOf = (rt: Record<string, unknown>) => String(rt.type ?? rt.routeType ?? "").toUpperCase();
    const idOf = (rt: Record<string, unknown>) => str(rt.id ?? rt.routeId) ?? "";
    const trade = routes.find((rt) => ["TRADE", "PRIMARY", "ORDER"].includes(typeOf(rt)));
    const info = routes.find((rt) => typeOf(rt) === "INFO");
    const first = routes.length ? idOf(routes[0]) : "";
    rows.push({
      tradableInstrumentId: id,
      brokerSymbol: String(i.name ?? i.symbol ?? i.tradableInstrument ?? ""),
      tradeRouteId: (trade ? idOf(trade) : "") || str(i.routeId ?? i.tradableInstrumentRouteId) || first,
      infoRouteId: (info ? idOf(info) : "") || first,
      raw: i,
    });
  }
  return ok(rows, r.status, r.latencyMs);
}

/** Full contract metadata for one instrument. This is what sizing depends on; a gap here blocks. */
export async function getInstrumentDetails(
  env: TLEnv,
  accessToken: string,
  accNum: string,
  tradableInstrumentId: string,
  routeId: string,
): Promise<TLResult<unknown>> {
  const r = await tlFetch(env, `/trade/instruments/${encodeURIComponent(tradableInstrumentId)}?routeId=${encodeURIComponent(routeId)}`, {
    accessToken, accNum, priority: "background",
  });
  const err = brokerError(r.json);
  if (r.status < 200 || r.status >= 300 || err) return bad(r.status, err ?? `instrument details unavailable (${r.status})`, r.latencyMs);
  return ok((r.json as { d?: unknown })?.d ?? r.json, r.status, r.latencyMs);
}

export async function getQuote(
  env: TLEnv,
  accessToken: string,
  accNum: string,
  tradableInstrumentId: string,
  infoRouteId: string,
): Promise<TLResult<Quote>> {
  const r = await tlFetch(env, `/trade/quotes?routeId=${encodeURIComponent(infoRouteId)}&tradableInstrumentId=${encodeURIComponent(tradableInstrumentId)}`, {
    accessToken, accNum, priority: "normal",
  });
  const err = brokerError(r.json);
  if (r.status < 200 || r.status >= 300 || err) return bad(r.status, err ?? `quote unavailable (${r.status})`, r.latencyMs);
  const d = ((r.json as { d?: unknown })?.d ?? r.json) as Record<string, unknown>;
  const bid = num(d?.bp ?? d?.bid);
  const ask = num(d?.ap ?? d?.ask);
  if (bid == null || ask == null) return bad(r.status, "quote had no bid/ask", r.latencyMs);
  // TradeLocker's /quotes supplies no provider timestamp, so the age of this quote is the age of our
  // receipt of it, and it is labelled that way rather than pretending to be an exchange timestamp.
  return ok(
    { source: "broker", bid, ask, providerTs: null, providerTsPrecision: "none", receivedAt: Date.now(), seq: null },
    r.status,
    r.latencyMs,
  );
}

export async function getAccountState(env: TLEnv, accessToken: string, accNum: string, accountId: string): Promise<TLResult<Record<string, unknown>>> {
  const r = await tlFetch(env, `/trade/accounts/${encodeURIComponent(accountId)}/state`, { accessToken, accNum, priority: "normal" });
  const err = brokerError(r.json);
  if (r.status < 200 || r.status >= 300 || err) return bad(r.status, err ?? `account state unavailable (${r.status})`, r.latencyMs);
  return ok((((r.json as { d?: unknown })?.d ?? r.json) as Record<string, unknown>) ?? {}, r.status, r.latencyMs);
}

// ---- Orders and positions ----------------------------------------------------------------------------

export type CreateOrderInput = {
  accountId: string;
  accNum: string;
  tradableInstrumentId: string;
  /** The TRADE route. Sending the INFO route here is a silent misconfiguration. */
  routeId: string;
  side: Side;
  qty: number;
  type: "market" | "limit";
  price?: number;
  validity?: "IOC" | "GTC";
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** Ownership correlation only. Documented 31-character limit. Not broker-side idempotency. */
  strategyId?: string | null;
};

export async function createOrder(env: TLEnv, accessToken: string, inp: CreateOrderInput): Promise<TLResult<{ orderId: string | null; positionId: string | null; raw: unknown }>> {
  const body: Record<string, unknown> = {
    routeId: inp.routeId,
    tradableInstrumentId: inp.tradableInstrumentId,
    qty: inp.qty,
    side: inp.side,
    type: inp.type,
    validity: inp.validity ?? (inp.type === "market" ? "IOC" : "GTC"),
  };
  if (inp.type !== "market" && inp.price != null) body.price = inp.price;
  if (inp.stopLoss != null) { body.stopLoss = inp.stopLoss; body.stopLossType = "absolute"; }
  if (inp.takeProfit != null) { body.takeProfit = inp.takeProfit; body.takeProfitType = "absolute"; }
  if (inp.strategyId) body.strategyId = String(inp.strategyId).slice(0, 31);

  const r = await tlFetch(env, `/trade/accounts/${encodeURIComponent(inp.accountId)}/orders`, {
    method: "POST", accessToken, accNum: inp.accNum, body: JSON.stringify(body), priority: "critical",
  });

  // A timeout or a 5xx means the order MAY have been accepted. Never retried, always reconciled.
  if (r.status === 0 || r.status === 408 || r.status >= 500) {
    return bad(r.status, `order outcome unknown: ${r.text || "no response"}`, r.latencyMs, true, r.json);
  }
  const err = brokerError(r.json);
  if (err) return bad(r.status, err, r.latencyMs, false, r.json);
  if (r.status < 200 || r.status >= 300) return bad(r.status, r.text || `order rejected (${r.status})`, r.latencyMs, false, r.json);

  const d = ((r.json as { d?: unknown })?.d ?? r.json) as Record<string, unknown>;
  const orderId = str(d?.orderId ?? d?.id);
  const positionId = str(d?.positionId);
  if (!orderId && !positionId) {
    return bad(r.status, "broker returned neither an order id nor a position id; reconcile before retrying", r.latencyMs, true, r.json);
  }
  return ok({ orderId, positionId, raw: r.json }, r.status, r.latencyMs);
}

export async function listPositions(env: TLEnv, accessToken: string, accNum: string, accountId: string): Promise<TLResult<unknown[]>> {
  const r = await tlFetch(env, `/trade/accounts/${encodeURIComponent(accountId)}/positions`, { accessToken, accNum, priority: "normal" });
  const err = brokerError(r.json);
  if (r.status < 200 || r.status >= 300 || err) return bad(r.status, err ?? `positions unavailable (${r.status})`, r.latencyMs);
  const coll = readCollection(r.json, "positions");
  return coll.ok ? ok(coll.data, r.status, r.latencyMs) : bad(r.status, coll.error, r.latencyMs);
}

export async function listOrders(env: TLEnv, accessToken: string, accNum: string, accountId: string): Promise<TLResult<unknown[]>> {
  const r = await tlFetch(env, `/trade/accounts/${encodeURIComponent(accountId)}/orders`, { accessToken, accNum, priority: "normal" });
  const err = brokerError(r.json);
  if (r.status < 200 || r.status >= 300 || err) return bad(r.status, err ?? `orders unavailable (${r.status})`, r.latencyMs);
  const coll = readCollection(r.json, "orders");
  return coll.ok ? ok(coll.data, r.status, r.latencyMs) : bad(r.status, coll.error, r.latencyMs);
}

export async function listOrdersHistory(env: TLEnv, accessToken: string, accNum: string, accountId: string): Promise<TLResult<unknown[]>> {
  const r = await tlFetch(env, `/trade/accounts/${encodeURIComponent(accountId)}/ordersHistory`, { accessToken, accNum, priority: "normal" });
  const err = brokerError(r.json);
  if (r.status < 200 || r.status >= 300 || err) return bad(r.status, err ?? `order history unavailable (${r.status})`, r.latencyMs);
  const coll = readCollection(r.json, "ordersHistory", "orders");
  return coll.ok ? ok(coll.data, r.status, r.latencyMs) : bad(r.status, coll.error, r.latencyMs);
}

/**
 * Amend protection.
 *
 * `undefined` leaves a leg alone; `null` REMOVES it. The distinction is load-bearing: a serializer
 * that turns an omitted optional into `null` would silently strip the take-profit off every position
 * whose stop is being trailed. The body is built by hand here for exactly that reason.
 */
export async function modifyPosition(
  env: TLEnv,
  accessToken: string,
  accNum: string,
  positionId: string,
  mod: { stopLoss?: number | null; takeProfit?: number | null },
): Promise<TLResult<true>> {
  const body: Record<string, unknown> = {};
  if (mod.stopLoss !== undefined) body.stopLoss = mod.stopLoss;
  if (mod.takeProfit !== undefined) body.takeProfit = mod.takeProfit;
  if (!Object.keys(body).length) return bad(400, "nothing to modify", 0);

  const r = await tlFetch(env, `/trade/positions/${encodeURIComponent(positionId)}`, {
    method: "PATCH", accessToken, accNum, body: JSON.stringify(body), priority: "critical",
  });
  const err = brokerError(r.json);
  // A 200 carrying {s:"error"} is a REJECTION. Treating it as success is how a phantom break-even
  // gets recorded on a position that is still sitting at its original stop.
  if (err) return bad(r.status, err, r.latencyMs, false, r.json);
  if (r.status < 200 || r.status >= 300) return bad(r.status, r.text || `amend rejected (${r.status})`, r.latencyMs, r.status >= 500);
  return ok(true, r.status, r.latencyMs);
}

/** `qty: 0` is a full close. A partial passes a validated non-zero quantity. */
export async function closePosition(env: TLEnv, accessToken: string, accNum: string, positionId: string, qty?: number): Promise<TLResult<true>> {
  const body = JSON.stringify({ qty: qty && qty > 0 ? qty : 0 });
  const r = await tlFetch(env, `/trade/positions/${encodeURIComponent(positionId)}`, {
    method: "DELETE", accessToken, accNum, body, priority: "critical",
  });
  const err = brokerError(r.json);
  if (err) return bad(r.status, err, r.latencyMs, false, r.json);
  if (r.status < 200 || r.status >= 300) return bad(r.status, r.text || `close rejected (${r.status})`, r.latencyMs, r.status >= 500);
  return ok(true, r.status, r.latencyMs);
}

/** Cancelling something already gone is a success, not an error. */
export async function cancelOrder(env: TLEnv, accessToken: string, accNum: string, orderId: string): Promise<TLResult<true>> {
  const r = await tlFetch(env, `/trade/orders/${encodeURIComponent(orderId)}`, { method: "DELETE", accessToken, accNum, priority: "critical" });
  if (r.status === 404 || r.status === 410) return ok(true, r.status, r.latencyMs);
  const err = brokerError(r.json);
  if (err && /not found|no such|already|not working|unknown order/i.test(err)) return ok(true, r.status, r.latencyMs);
  if (err) return bad(r.status, err, r.latencyMs);
  if (r.status < 200 || r.status >= 300) return bad(r.status, r.text || `cancel rejected (${r.status})`, r.latencyMs, r.status >= 500);
  return ok(true, r.status, r.latencyMs);
}

/** Resolve the position an acknowledged order became, from history. An ack is not a fill. */
export function positionForOrder(history: unknown[], cols: Record<string, number>, orderId: string): string | null {
  for (const row of history) {
    const id = str(field(row, cols, ["id", "orderId"]));
    if (id && id === orderId) {
      const pos = str(field(row, cols, ["positionId"]));
      if (pos) return pos;
    }
  }
  return null;
}

export type { Priority, TLEnv, TLResult };
export { columnMap, field };

/**
 * Fold the broker's instrument payloads into the spec sizing needs. Anything missing is NAMED in
 * `specMissing` rather than defaulted, because a default here is a guess about how much money is at
 * risk per lot.
 */
export function toInstrumentSpec(row: TLInstrumentRow, details: unknown): { spec: InstrumentSpec; missing: string[] } {
  const d = (details ?? {}) as Record<string, unknown>;
  const nested = (d.details ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = num(d[k] ?? nested[k]);
      if (v != null) return v;
    }
    return null;
  };
  const spec: InstrumentSpec = {
    tradableInstrumentId: row.tradableInstrumentId,
    tradeRouteId: row.tradeRouteId,
    infoRouteId: row.infoRouteId,
    brokerSymbol: row.brokerSymbol,
    contractSize: pick("contractSize", "lotSize", "contract_size"),
    lotStep: pick("lotStep", "quantityStep", "stepLot", "lotIncrement"),
    minLot: pick("minLot", "minQuantity", "minLotSize"),
    maxLot: pick("maxLot", "maxQuantity", "maxLotSize"),
    tickSize: pick("tickSize", "minPriceIncrement", "priceIncrement"),
    tickValue: pick("tickValue", "priceIncrementValue"),
    priceDecimals: pick("priceDecimals", "decimals", "pricePrecision"),
    currency: str(d.currency ?? nested.currency ?? d.profitCurrency),
    minStopDistance: pick("minStopDistance", "stopsLevel", "minDistance"),
    raw: details,
  };
  const missing: string[] = [];
  if (spec.tickSize == null) missing.push("tickSize");
  if (spec.lotStep == null) missing.push("lotStep");
  if (spec.minLot == null) missing.push("minLot");
  if (spec.contractSize == null && spec.tickValue == null) missing.push("contractSize or tickValue");
  if (spec.currency == null) missing.push("currency");
  return { spec, missing };
}

/**
 * Resolve gold on THIS account by verified identity, never by a hard-coded symbol. An ambiguous
 * match blocks with the candidates listed, so a human picks rather than the code guessing.
 */
export function resolveGold(rows: TLInstrumentRow[]): { ok: true; row: TLInstrumentRow } | { ok: false; reason: string; candidates: string[] } {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Anything that could plausibly be gold. A "XAUUSD" and a "XAUUSD.raw" on the same account are
  // usually DIFFERENT contracts with different spread and commission, so picking one silently is a
  // decision about the member's money made by a regex. It blocks, and a human chooses.
  const goldish = rows.filter((r) => /^(XAUUSD|GOLD|XAU$)/.test(norm(r.brokerSymbol)));
  if (goldish.length === 1) return { ok: true, row: goldish[0] };
  if (goldish.length === 0) {
    return { ok: false, reason: "no gold instrument was found on this account", candidates: [] };
  }
  return {
    ok: false,
    reason: `${goldish.length} gold instruments on this account; choose one before enabling execution`,
    candidates: goldish.map((r) => r.brokerSymbol),
  };
}
