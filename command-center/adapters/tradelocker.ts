/**
 * TRADELOCKER ADAPTER — the only file in the Command Center permitted to talk to a broker.
 *
 * Re-verified against the official TradeLocker Public API documentation on 2026-09-19. That re-read found
 * four things this file had wrong, each of which would have failed in production:
 *
 *   1. ACCOUNT PATHS TAKE `accountId`, NOT `accNum`. A TradeLocker account has both, and they are not the
 *      same value. `accNum` is a HEADER; `accountId` is the path segment. Sending accNum in the path
 *      addresses the wrong account or none at all.
 *   2. `stopLoss` MUST travel with `stopLossType` ("absolute" | "offset" | "trailingOffset"), and
 *      `takeProfit` with `takeProfitType`. A bare stopLoss is rejected — an order would have gone on
 *      with no protection attached.
 *   3. A FULL CLOSE IS `qty: 0`, not an empty body.
 *   4. Multi-user apps are expected to send a `tl-developer-api-key` header from the Developer Program.
 *      Rate limits are ROUTE-specific and published in /trade/config, not guessed.
 *
 * Documented surface used here:
 *   POST   /auth/jwt/token                                          { email, password, server }
 *   POST   /auth/jwt/refresh                                        { refreshToken }
 *   GET    /auth/jwt/all-accounts                                    Authorization only (no accNum yet)
 *   GET    /trade/config                                            Authorization, accNum header
 *   GET    /trade/accounts/{accountId}/instruments
 *   GET    /trade/accounts/{accountId}/instruments/{tradableInstrumentId}?routeId=
 *   GET    /trade/accounts/{accountId}/state
 *   GET    /trade/accounts/{accountId}/positions | /orders | /ordersHistory
 *   POST   /trade/accounts/{accountId}/orders
 *   DELETE /trade/accounts/{accountId}/orders/{orderId}
 *   PATCH  /trade/accounts/{accountId}/positions/{positionId}       stopLoss / takeProfit (null removes)
 *   POST   /trade/accounts/{accountId}/positions/{positionId}/close qty: 0 = all, qty > 0 = partial
 *   GET    /trade/quotes?routeId=&tradableInstrumentId=
 *
 * Two rules encoded here and nowhere else:
 *   1. A 200 response carrying s:"error" is a REJECTION. Recording it as success is how a desk ends up
 *      believing a stop was moved that never moved.
 *   2. A timeout is never retried at this layer. It returns `uncertain`, and the caller reconciles.
 */
export type TLEnv = "demo" | "live";
export const TL_HOSTS: Record<TLEnv, string> = {
  demo: "https://demo.tradelocker.com/backend-api",
  live: "https://live.tradelocker.com/backend-api",
};

export type TLResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; uncertain?: boolean; raw?: unknown };

/**
 * An authenticated handle on ONE account. `accountId` addresses it in the path; `accNum` identifies it in
 * the header. Both are required and they are different values — see note 1 above.
 */
export type TLAuth = { env: TLEnv; accessToken: string; accountId: string; accNum: string };
export type TLAccount = { id: string; accNum: string; currency?: string; balance?: number; equity?: number; name?: string };
export type TLQuote = { bid: number | null; ask: number | null; at: number };
export type TLPosition = { id: string; instrumentId: string; side: "buy" | "sell"; qty: number; avgPrice: number | null; sl: number | null; tp: number | null; unrealisedPl: number | null; openedAt: number | null };

const TIMEOUT_MS = 15_000;

/**
 * The Developer Program key for multi-user applications. Absent, the API still works but on the stricter
 * per-route limits — which is precisely what starved the old desk's fan-out. It is read from the
 * environment and never travels to a browser.
 */
const DEVELOPER_KEY = process.env.TL_DEVELOPER_API_KEY ?? "";
export const hasDeveloperKey = () => DEVELOPER_KEY.length > 0;

/** A broker "ok" that carries an error. Documented behaviour; treated as the rejection it is. */
export function isRejection(status: number, body: unknown): boolean {
  if (status < 200 || status >= 300) return true;
  const s = String((body as Record<string, unknown> | null)?.s ?? "").toLowerCase();
  return s === "error" || s === "fail" || s === "rejected";
}

async function call<T>(env: TLEnv, path: string, init: RequestInit & { token?: string; accNum?: string } = {}): Promise<TLResult<T>> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.accNum) headers.accNum = String(init.accNum);
  if (DEVELOPER_KEY) headers["tl-developer-api-key"] = DEVELOPER_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${TL_HOSTS[env]}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, cache: "no-store", signal: ctrl.signal });
    const text = await r.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* some endpoints answer 204 with no body */ }
    if (isRejection(r.status, body)) {
      const msg = String((body as Record<string, unknown> | null)?.errmsg ?? (body as Record<string, unknown> | null)?.message ?? text.slice(0, 160) ?? `HTTP ${r.status}`);
      // 5xx and 408 leave the real outcome unknown — the caller must reconcile, never resend.
      return { ok: false, status: r.status, error: msg, uncertain: r.status >= 500 || r.status === 408, raw: body };
    }
    return { ok: true, data: (body ?? true) as T };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return { ok: false, status: 0, error: aborted ? "timeout" : (e instanceof Error ? e.message : "network"), uncertain: true };
  } finally { clearTimeout(timer); }
}

/** Read a numeric field from a broker row that may be an object or a columnar array. */
export function numField(row: unknown, keys: string[], idx?: number): number | null {
  if (Array.isArray(row)) { const v = idx != null ? Number(row[idx]) : NaN; return Number.isFinite(v) ? v : null; }
  if (row && typeof row === "object") {
    for (const k of keys) { const v = Number((row as Record<string, unknown>)[k]); if (Number.isFinite(v)) return v; }
  }
  return null;
}

export async function authenticate(env: TLEnv, email: string, password: string, server: string): Promise<TLResult<{ accessToken: string; refreshToken: string }>> {
  const r = await call<{ accessToken?: string; refreshToken?: string }>(env, "/auth/jwt/token", { method: "POST", body: JSON.stringify({ email, password, server }) });
  if (!r.ok) return r;
  const { accessToken, refreshToken } = r.data;
  if (!accessToken || !refreshToken) return { ok: false, status: 200, error: "Broker returned no tokens" };
  return { ok: true, data: { accessToken, refreshToken } };
}

export async function refresh(env: TLEnv, refreshToken: string): Promise<TLResult<{ accessToken: string; refreshToken?: string }>> {
  const r = await call<{ accessToken?: string; refreshToken?: string }>(env, "/auth/jwt/refresh", { method: "POST", body: JSON.stringify({ refreshToken }) });
  if (!r.ok) return r;
  return r.data.accessToken ? { ok: true, data: { accessToken: r.data.accessToken, refreshToken: r.data.refreshToken } } : { ok: false, status: 200, error: "No access token in refresh" };
}

/**
 * List the accounts behind these credentials.
 *
 * This is an /auth/ route, NOT /trade/accounts — and that is the whole point. Every /trade/* route
 * requires an `accNum` header, and accNum is something you only learn BY listing the accounts. Calling
 * /trade/accounts first is a chicken-and-egg: the broker answers "Header missing: 'accNum'" and there is
 * no value you could have sent.
 *
 * The desk has run on this endpoint across hundreds of live accounts, which is the evidence that
 * settled it.
 */
export const listAccounts = (env: TLEnv, token: string) =>
  call<unknown>(env, "/auth/jwt/all-accounts", { token });

export const getConfig = (a: TLAuth) =>
  call<unknown>(a.env, "/trade/config", { token: a.accessToken, accNum: a.accNum });

/** Everything below addresses the account by accountId in the PATH and accNum in the HEADER. */
const acct = (a: TLAuth, suffix = "") => `/trade/accounts/${encodeURIComponent(a.accountId)}${suffix}`;
const auth = (a: TLAuth) => ({ token: a.accessToken, accNum: a.accNum });

/**
 * Is this failure a ROUTING failure — the endpoint is not there — as opposed to an action that may have
 * happened? Only a routing failure is safe to retry down a different path. A timeout or a 5xx means the
 * outcome is unknown, and retrying those is how a position gets closed twice.
 */
export const isRouting = (r: TLResult<unknown>): boolean =>
  !r.ok && !r.uncertain && (r.status === 404 || r.status === 405 || /not found|no route|method not allowed/i.test(r.error));

/** Live balance, equity and open P&L for one account. */
export const accountState = (a: TLAuth) => call<unknown>(a.env, acct(a, "/state"), auth(a));

export const listInstruments = (a: TLAuth) => call<unknown>(a.env, acct(a, "/instruments"), auth(a));

/** Lot steps, sizes, precision and contract size for ONE instrument. Required before any order is sized. */
export const instrumentDetails = (a: TLAuth, tradableInstrumentId: string, routeId: string) =>
  call<unknown>(a.env, acct(a, `/instruments/${encodeURIComponent(tradableInstrumentId)}?routeId=${encodeURIComponent(routeId)}`), auth(a));

/** The row for one instrument out of the LIST, for brokers whose build has no per-instrument detail route. */
export function instrumentRow(body: unknown, tradableInstrumentId: string): unknown | null {
  for (const r of rowsOf(body, ["instruments", "d", "data"])) {
    if (Array.isArray(r)) continue;
    const id = (r as Record<string, unknown>).tradableInstrumentId ?? (r as Record<string, unknown>).id;
    if (id != null && String(id) === String(tradableInstrumentId)) return r;
  }
  return null;
}

export const listPositions = (a: TLAuth) => call<unknown>(a.env, acct(a, "/positions"), auth(a));
export const listOrders = (a: TLAuth) => call<unknown>(a.env, acct(a, "/orders"), auth(a));
export const ordersHistory = (a: TLAuth) => call<unknown>(a.env, acct(a, "/ordersHistory"), auth(a));

export const quotes = (a: TLAuth, tradableInstrumentId: string, routeId: string) =>
  call<unknown>(a.env, `/trade/quotes?routeId=${encodeURIComponent(routeId)}&tradableInstrumentId=${encodeURIComponent(tradableInstrumentId)}`, auth(a));

export type CreateOrder = {
  tradableInstrumentId: string;
  routeId: string;
  qty: number;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop";
  validity: "IOC" | "GTC";
  price?: number;
  stopPrice?: number;
  /** Absolute prices. The adapter attaches the required *Type fields; callers never deal with them. */
  stopLoss?: number;
  takeProfit?: number;
  /** Up to 31 characters. Carries our decision id, so a broker row can always be traced back to a reason. */
  strategyId?: string;
};

/**
 * Place an order. Never called by intelligence — only by the authorised execution path.
 *
 * `stopLoss` and `takeProfit` are sent as ABSOLUTE prices with their required type fields. Omitting the
 * type field makes the broker reject the order, which is how a position ends up open with no stop.
 */
export function orderBody(o: CreateOrder): Record<string, unknown> {
  const body: Record<string, unknown> = {
    tradableInstrumentId: o.tradableInstrumentId,
    routeId: o.routeId,
    qty: o.qty,
    side: o.side,
    type: o.type,
    validity: o.validity,
    price: o.type === "market" ? 0 : o.price ?? 0,
  };
  if (o.type === "stop" && o.stopPrice != null) body.stopPrice = o.stopPrice;
  if (o.stopLoss != null) { body.stopLoss = o.stopLoss; body.stopLossType = "absolute"; }
  if (o.takeProfit != null) { body.takeProfit = o.takeProfit; body.takeProfitType = "absolute"; }
  if (o.strategyId) body.strategyId = o.strategyId.slice(0, 31);
  return body;
}

export const createOrder = (a: TLAuth, o: CreateOrder) =>
  call<{ orderId?: string; d?: { orderId?: string } }>(a.env, acct(a, "/orders"), {
    method: "POST", ...auth(a), body: JSON.stringify(orderBody(o)),
  });

export const cancelOrder = (a: TLAuth, orderId: string) =>
  call<true>(a.env, acct(a, `/orders/${encodeURIComponent(orderId)}`), { method: "DELETE", ...auth(a) });

/**
 * Modify protection on an open position. Passing null for a field REMOVES it, which is documented and is
 * why undefined and null must not be conflated here.
 */
export async function modifyPosition(a: TLAuth, positionId: string, mod: { stopLoss?: number | null; takeProfit?: number | null }): Promise<TLResult<true>> {
  const body: Record<string, unknown> = {};
  if (mod.stopLoss !== undefined) body.stopLoss = mod.stopLoss;
  if (mod.takeProfit !== undefined) body.takeProfit = mod.takeProfit;
  const first = await call<true>(a.env, acct(a, `/positions/${encodeURIComponent(positionId)}`), {
    method: "PATCH", ...auth(a), body: JSON.stringify(body),
  });
  if (first.ok || !isRouting(first)) return first;
  // Older builds expose the position directly rather than under the account. Re-setting a stop to the
  // same price is harmless, so this retry cannot do damage — and only a ROUTING failure gets here.
  return call<true>(a.env, `/trade/positions/${encodeURIComponent(positionId)}`, {
    method: "PATCH", ...auth(a), body: JSON.stringify(body),
  });
}

/**
 * Close a position. qty 0 closes ALL of it; a positive qty closes that many lots.
 *
 * The fallback path here is gated hard on `isRouting`. A close that TIMED OUT must never be retried down
 * another route: the first one may have worked, and closing twice on a partial would take size off the
 * position that the member never asked to lose.
 */
export async function closePosition(a: TLAuth, positionId: string, qty = 0): Promise<TLResult<true>> {
  const q = qty > 0 ? qty : 0;
  const first = await call<true>(a.env, acct(a, `/positions/${encodeURIComponent(positionId)}/close`), {
    method: "POST", ...auth(a), body: JSON.stringify({ qty: q }),
  });
  if (first.ok || !isRouting(first)) return first;
  return call<true>(a.env, `/trade/positions/${encodeURIComponent(positionId)}`, {
    method: "DELETE", ...auth(a), body: JSON.stringify(q > 0 ? { qty: q } : {}),
  });
}

/* ── reading broker rows ────────────────────────────────────────────────────
   TradeLocker answers some routes with objects and some with columnar arrays plus a separate config
   describing the columns. Rather than assume a shape, every reader below tries named fields first and
   falls back to a positional index, and returns null when it genuinely cannot tell. A null that travels
   is safe; a zero that was really "unknown" is not. */

type Row = Record<string, unknown> | unknown[];

const pick = (row: Row, keys: string[]): unknown => {
  if (Array.isArray(row)) return undefined;
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k];
  return undefined;
};
const asNum = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const asStr = (v: unknown): string | null => (v == null ? null : String(v));

/** Unwrap the `d` envelope TradeLocker wraps most payloads in. */
export function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && "d" in (body as Record<string, unknown>)) {
    return (body as Record<string, unknown>).d;
  }
  return body;
}

/** Pull an array out of a payload whatever key it hides behind. */
export function rowsOf(body: unknown, keys: string[] = ["accounts", "positions", "orders", "instruments", "d", "data"]): Row[] {
  const d = unwrap(body);
  if (Array.isArray(d)) return d as Row[];
  if (d && typeof d === "object") {
    for (const k of keys) {
      const v = (d as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Row[];
    }
  }
  return [];
}

export function parseAccounts(body: unknown): TLAccount[] {
  return rowsOf(body, ["accounts", "d", "data"]).flatMap((r) => {
    const id = asStr(pick(r, ["id", "accountId"]));
    const accNum = asStr(pick(r, ["accNum", "accountNum", "accountNumber", "accNo"]));
    if (!id || !accNum) return [];
    return [{
      id, accNum,
      currency: asStr(pick(r, ["currency"])) ?? undefined,
      balance: asNum(pick(r, ["accountBalance", "balance"])) ?? undefined,
      equity: asNum(pick(r, ["projectedBalance", "equity"])) ?? undefined,
      name: asStr(pick(r, ["name", "accountName", "title"])) ?? undefined,
    }];
  });
}

export function parseAccountState(body: unknown): { balance: number | null; equity: number | null; openPl: number | null; marginAvailable: number | null } {
  const d = unwrap(body);
  const row = (Array.isArray(d) ? (d[0] as Row) : (d as Row)) ?? {};
  // Some builds answer /state as a bare positional array: balance, projected balance, available funds, …
  if (Array.isArray(row)) {
    return { balance: asNum(row[0]), equity: asNum(row[1]), openPl: asNum(row[4]), marginAvailable: asNum(row[2]) };
  }
  return {
    balance: asNum(pick(row, ["balance", "accountBalance"])),
    equity: asNum(pick(row, ["projectedBalance", "equity"])),
    openPl: asNum(pick(row, ["openNetPnL", "openPnL", "unrealizedPnL"])),
    marginAvailable: asNum(pick(row, ["availableFunds", "freeMargin", "marginAvailable"])),
  };
}

export function parsePositions(body: unknown): TLPosition[] {
  return rowsOf(body, ["positions", "d", "data"]).flatMap((r) => {
    if (Array.isArray(r)) return [];                       // columnar rows need the config; handled by the caller
    const id = asStr(pick(r, ["id", "positionId"]));
    if (!id) return [];
    const sideRaw = String(pick(r, ["side"]) ?? "").toLowerCase();
    return [{
      id,
      instrumentId: asStr(pick(r, ["tradableInstrumentId", "instrumentId"])) ?? "",
      side: sideRaw === "sell" ? "sell" : "buy",
      qty: asNum(pick(r, ["qty", "quantity", "volume"])) ?? 0,
      avgPrice: asNum(pick(r, ["avgPrice", "openPrice", "price"])),
      sl: asNum(pick(r, ["stopLoss", "sl"])),
      tp: asNum(pick(r, ["takeProfit", "tp"])),
      unrealisedPl: asNum(pick(r, ["unrealizedPl", "unrealisedPl", "openPnL"])),
      openedAt: asNum(pick(r, ["openDate", "openTime", "createdAt"])),
    }];
  });
}

/**
 * The instrument's trading specification, as the broker states it.
 *
 * Every field is nullable ON PURPOSE. If the broker does not tell us the contract size, the honest answer
 * is "I cannot size this trade" — not a hardcoded guess about what a gold lot is worth. The sizing code
 * refuses rather than inventing one.
 */
export type TLInstrumentSpec = {
  tradableInstrumentId: string;
  routeId: string;
  name: string;
  contractSize: number | null;
  lotStep: number | null;
  minLot: number | null;
  maxLot: number | null;
  tickSize: number | null;
  tickValue: number | null;
  pricePrecision: number | null;
  quantityPrecision: number | null;
  currency: string | null;
};

export function parseInstrumentSpec(body: unknown, fallback: { tradableInstrumentId: string; routeId: string }): TLInstrumentSpec {
  const d = unwrap(body);
  const row = ((Array.isArray(d) ? d[0] : d) ?? {}) as Row;
  const g = (keys: string[]) => (Array.isArray(row) ? null : asNum(pick(row, keys)));
  return {
    tradableInstrumentId: (Array.isArray(row) ? null : asStr(pick(row, ["tradableInstrumentId", "id"]))) ?? fallback.tradableInstrumentId,
    routeId: (Array.isArray(row) ? null : asStr(pick(row, ["routeId"]))) ?? fallback.routeId,
    name: (Array.isArray(row) ? null : asStr(pick(row, ["name", "symbol", "description"]))) ?? "",
    contractSize: g(["contractSize", "lotSize", "unitsPerLot"]),
    lotStep: g(["lotStep", "quantityStep", "volumeStep", "lotSizeStep"]),
    minLot: g(["minLot", "minQty", "minVolume", "minLotSize"]),
    maxLot: g(["maxLot", "maxQty", "maxVolume", "maxLotSize"]),
    tickSize: g(["tickSize", "minPriceIncrement", "priceStep"]),
    tickValue: g(["tickValue", "valuePerTick"]),
    pricePrecision: g(["pricePrecision", "priceDecimals", "decimals"]),
    quantityPrecision: g(["quantityPrecision", "qtyDecimals", "lotDecimals"]),
    currency: Array.isArray(row) ? null : asStr(pick(row, ["currency", "quoteCurrency", "profitCurrency"])),
  };
}

/** The gold instrument on this account, if the broker lists one. Name matching is deliberately narrow. */
export function findGold(body: unknown): { tradableInstrumentId: string; routeId: string; name: string } | null {
  for (const r of rowsOf(body, ["instruments", "d", "data"])) {
    if (Array.isArray(r)) continue;
    const name = String(pick(r, ["name", "symbol"]) ?? "").toUpperCase();
    if (!/^XAUUSD/.test(name.replace(/[^A-Z]/g, ""))) continue;
    const id = asStr(pick(r, ["tradableInstrumentId", "id"]));
    const routes = pick(r, ["routes"]);
    let routeId = asStr(pick(r, ["routeId"]));
    if (!routeId && Array.isArray(routes) && routes.length) {
      const first = routes[0] as Record<string, unknown>;
      routeId = asStr(first?.id ?? first?.routeId);
    }
    if (id && routeId) return { tradableInstrumentId: id, routeId, name };
  }
  return null;
}

/** The order id out of whichever envelope the broker used. */
export function orderIdOf(body: unknown): string | null {
  const d = unwrap(body) as Record<string, unknown> | null;
  if (!d) return null;
  const v = d.orderId ?? d.id ?? (d.order as Record<string, unknown> | undefined)?.id;
  return v == null ? null : String(v);
}
