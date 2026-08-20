/**
 * FLOW ↔ TradeLocker server client (spec §7, §9, §14, §32, §34).
 *
 * SERVER-ONLY. Never import into browser code. All calls use the official
 * TradeLocker Public API. Endpoint paths below are taken from the official docs
 * (public-api.tradelocker.com); the order/position write paths are validated
 * against a DEMO account before any live use (we never guess a live-money call).
 *
 * Confirmed from official docs:
 *   Hosts:  https://demo.tradelocker.com/backend-api  |  https://live.tradelocker.com/backend-api
 *   POST /auth/jwt/token            { email, password, server } -> { accessToken, refreshToken }
 *   POST /auth/jwt/refresh          { refreshToken }            -> { accessToken, refreshToken }
 *   GET  /auth/jwt/all-accounts     -> accounts[] (accountId, accNum, currency, ...)
 *   GET  /trade/config              -> field specs / limits (drives the order schema)
 *   GET  /trade/accounts/{id}/instruments -> tradableInstrumentId, routeId, qty specs
 *   GET  /trade/quotes              (routeId=INFO) -> bid/ask
 *   GET/POST /trade/accounts/{id}/orders  -> list / create
 * Header on every /trade/* call: Authorization: Bearer <token>, accNum: <accNum>.
 */

export type TLEnv = "demo" | "live";
export const TL_HOSTS: Record<TLEnv, string> = {
  demo: "https://demo.tradelocker.com/backend-api",
  live: "https://live.tradelocker.com/backend-api",
};

export type TLTokens = { accessToken: string; refreshToken: string; raw?: unknown };
export type TLAccount = { accountId: string; accNum: string; currency?: string; name?: string; balance?: number; equity?: number; raw?: unknown };
export type TLInstrument = { canonical?: string; brokerSymbol: string; tradableInstrumentId: string; routeId: string; quantityStep?: number; minQuantity?: number; pricePrecision?: number; raw?: unknown };
export type TLQuote = { bid: number | null; ask: number | null; raw?: unknown };
export type TLResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; raw?: unknown };

const TIMEOUT_MS = 15000;

async function tlFetch(env: TLEnv, path: string, init: RequestInit & { accessToken?: string; accNum?: string } = {}): Promise<{ status: number; json: unknown; text: string }> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (init.accessToken) headers["Authorization"] = `Bearer ${init.accessToken}`;
  if (init.accNum) headers["accNum"] = String(init.accNum);
  try {
    const r = await fetch(`${TL_HOSTS[env]}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> || {}) }, signal: ctrl.signal, cache: "no-store" });
    const text = await r.text();
    let json: unknown = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    return { status: r.status, json, text };
  } finally { clearTimeout(to); }
}

function pick<T = unknown>(o: unknown, ...keys: string[]): T | undefined {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) { const v = (o as Record<string, unknown>)[k]; if (v !== undefined && v !== null) return v as T; }
  return undefined;
}

/** POST /auth/jwt/token — exchange broker email+password+server for JWTs. */
export async function authenticate(env: TLEnv, email: string, password: string, server: string): Promise<TLResult<TLTokens>> {
  const { status, json, text } = await tlFetch(env, "/auth/jwt/token", { method: "POST", body: JSON.stringify({ email, password, server }) });
  if (status < 200 || status >= 300) return { ok: false, status, error: humanAuthError(status, json, text), raw: json ?? text };
  const accessToken = pick<string>(json, "accessToken", "access_token");
  const refreshToken = pick<string>(json, "refreshToken", "refresh_token");
  if (!accessToken || !refreshToken) return { ok: false, status, error: "TradeLocker did not return tokens.", raw: json };
  return { ok: true, data: { accessToken, refreshToken, raw: json } };
}

/** POST /auth/jwt/refresh — mint a fresh access token from the stored refresh token. */
export async function refresh(env: TLEnv, refreshToken: string): Promise<TLResult<TLTokens>> {
  const { status, json, text } = await tlFetch(env, "/auth/jwt/refresh", { method: "POST", body: JSON.stringify({ refreshToken }) });
  if (status < 200 || status >= 300) return { ok: false, status, error: "Session expired — reconnect your TradeLocker account.", raw: json ?? text };
  const accessToken = pick<string>(json, "accessToken", "access_token");
  const newRefresh = pick<string>(json, "refreshToken", "refresh_token") ?? refreshToken;
  if (!accessToken) return { ok: false, status, error: "No access token on refresh.", raw: json };
  return { ok: true, data: { accessToken, refreshToken: newRefresh, raw: json } };
}

/** GET /auth/jwt/all-accounts — list the trading accounts under these credentials. */
export async function listAccounts(env: TLEnv, accessToken: string): Promise<TLResult<TLAccount[]>> {
  const { status, json, text } = await tlFetch(env, "/auth/jwt/all-accounts", { method: "GET", accessToken });
  if (status < 200 || status >= 300) return { ok: false, status, error: "Couldn't load your TradeLocker accounts.", raw: json ?? text };
  const arr = (pick<unknown[]>(json, "accounts") ?? (Array.isArray(json) ? json : [])) as unknown[];
  const accounts: TLAccount[] = arr.map((a) => ({
    accountId: String(pick(a, "id", "accountId") ?? ""),
    accNum: String(pick(a, "accNum", "accountNum") ?? ""),
    currency: pick<string>(a, "currency"),
    name: pick<string>(a, "name", "accountName"),
    balance: numOr(pick(a, "accountBalance", "balance")),
    equity: numOr(pick(a, "equity")),
    raw: a,
  })).filter((a) => a.accountId);
  return { ok: true, data: accounts };
}

/** GET /trade/config — field specifications + limits used to validate orders. */
export async function getConfig(env: TLEnv, accessToken: string, accNum: string): Promise<TLResult<unknown>> {
  const { status, json, text } = await tlFetch(env, "/trade/config", { method: "GET", accessToken, accNum });
  if (status < 200 || status >= 300) return { ok: false, status, error: "Couldn't load broker trade config.", raw: json ?? text };
  return { ok: true, data: json };
}

/** GET /trade/accounts/{accountId}/instruments — resolve tradable instrument + route. */
export async function listInstruments(env: TLEnv, accessToken: string, accNum: string, accountId: string): Promise<TLResult<TLInstrument[]>> {
  const { status, json, text } = await tlFetch(env, `/trade/accounts/${encodeURIComponent(accountId)}/instruments`, { method: "GET", accessToken, accNum });
  if (status < 200 || status >= 300) return { ok: false, status, error: "Couldn't load broker instruments.", raw: json ?? text };
  const arr = (pick<unknown[]>(json, "instruments") ?? pick<unknown[]>(pick(json, "d"), "instruments") ?? (Array.isArray(json) ? json : [])) as unknown[];
  const out: TLInstrument[] = arr.map((i) => ({
    brokerSymbol: String(pick(i, "name", "symbol", "tradableInstrument") ?? ""),
    tradableInstrumentId: String(pick(i, "tradableInstrumentId", "id") ?? ""),
    routeId: String(pick(i, "routeId", "tradableInstrumentRouteId") ?? ""),
    quantityStep: numOr(pick(i, "lotSize", "quantityStep", "minLot")),
    minQuantity: numOr(pick(i, "minLot", "minQuantity")),
    raw: i,
  })).filter((i) => i.tradableInstrumentId);
  return { ok: true, data: out };
}

/** GET /trade/quotes — current bid/ask for a tradable instrument (INFO route). */
export async function getQuote(env: TLEnv, accessToken: string, accNum: string, tradableInstrumentId: string, routeId: string): Promise<TLResult<TLQuote>> {
  const qs = `?routeId=${encodeURIComponent(routeId)}&tradableInstrumentId=${encodeURIComponent(tradableInstrumentId)}`;
  const { status, json, text } = await tlFetch(env, `/trade/quotes${qs}`, { method: "GET", accessToken, accNum });
  if (status < 200 || status >= 300) return { ok: false, status, error: "Couldn't load a broker quote.", raw: json ?? text };
  const d = pick(json, "d") ?? json;
  return { ok: true, data: { bid: numOr(pick(d, "bp", "bid")) ?? null, ask: numOr(pick(d, "ap", "ask")) ?? null, raw: json } };
}

export type CreateOrderInput = {
  accountId: string; accNum: string;
  tradableInstrumentId: string; routeId: string;
  side: "buy" | "sell"; type: "market" | "limit" | "stop";
  qty: number; price?: number | null;
  stopLoss?: number | null; takeProfit?: number | null;
  validity?: "IOC" | "GTC";
};

/**
 * POST /trade/accounts/{accountId}/orders — create an order.
 * Body uses TradeLocker's standard order fields. This is only ever called AFTER
 * price reconciliation + explicit user confirmation (see the order route), and
 * is validated against a demo account before any live use.
 */
export async function createOrder(env: TLEnv, accessToken: string, inp: CreateOrderInput): Promise<TLResult<{ orderId?: string; positionId?: string; raw: unknown }>> {
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
  const { status, json, text } = await tlFetch(env, `/trade/accounts/${encodeURIComponent(inp.accountId)}/orders`, { method: "POST", accessToken, accNum: inp.accNum, body: JSON.stringify(body) });
  if (status < 200 || status >= 300) return { ok: false, status, error: humanOrderError(status, json, text), raw: json ?? text };
  // TradeLocker wraps every response in { s: "ok"|"error", d, errmsg } and can
  // return HTTP 200 with s:"error" (market closed, bad field, throttled, etc.).
  // Treat that — and a 200 that carries no order/position id — as a REJECTION,
  // never a silent "placed".
  const sVal = String(pick(json, "s") ?? "").toLowerCase();
  if (sVal === "error" || sVal === "fail" || sVal === "rejected") {
    return { ok: false, status, error: humanOrderError(status, json, text), raw: json ?? text };
  }
  const d = pick(json, "d") ?? json;
  const orderId = strOr(pick(d, "orderId", "id"));
  const positionId = strOr(pick(d, "positionId"));
  if (!orderId && !positionId) {
    return { ok: false, status, error: `Broker accepted the request but returned no order id — the order did not reach the market. ${String(text).slice(0, 200)}`.trim(), raw: json ?? text };
  }
  return { ok: true, data: { orderId, positionId, raw: json } };
}

/** GET /trade/accounts/{accountId}/orders — list working/filled orders. */
export async function listOrders(env: TLEnv, accessToken: string, accNum: string, accountId: string): Promise<TLResult<unknown[]>> {
  const { status, json, text } = await tlFetch(env, `/trade/accounts/${encodeURIComponent(accountId)}/orders`, { method: "GET", accessToken, accNum });
  if (status < 200 || status >= 300) return { ok: false, status, error: "Couldn't load broker orders.", raw: json ?? text };
  const arr = (pick<unknown[]>(pick(json, "d"), "orders") ?? pick<unknown[]>(json, "orders") ?? (Array.isArray(json) ? json : [])) as unknown[];
  return { ok: true, data: arr };
}

/**
 * GET /trade/accounts/{accountId}/positions — list open positions.
 * (Path pattern per TradeLocker /trade/accounts/{id}/* grouping; the exact
 * response shape is confirmed against the demo account on first connect.)
 */
export async function listPositions(env: TLEnv, accessToken: string, accNum: string, accountId: string): Promise<TLResult<unknown[]>> {
  const { status, json, text } = await tlFetch(env, `/trade/accounts/${encodeURIComponent(accountId)}/positions`, { method: "GET", accessToken, accNum });
  if (status < 200 || status >= 300) return { ok: false, status, error: "Couldn't load broker positions.", raw: json ?? text };
  const arr = (pick<unknown[]>(pick(json, "d"), "positions") ?? pick<unknown[]>(json, "positions") ?? (Array.isArray(json) ? json : [])) as unknown[];
  return { ok: true, data: arr };
}

// ── helpers ──
function numOr(v: unknown): number | undefined { const n = typeof v === "string" ? parseFloat(v) : (v as number); return typeof n === "number" && Number.isFinite(n) ? n : undefined; }
function strOr(v: unknown): string | undefined { return v == null ? undefined : String(v); }
function humanAuthError(status: number, json: unknown, text: string): string {
  if (status === 401 || status === 403) return "TradeLocker rejected those credentials. Check the email, password and server name.";
  const m = pick<string>(json, "message", "error"); return m || `TradeLocker auth failed (${status}). ${text.slice(0, 120)}`;
}
function humanOrderError(status: number, json: unknown, text: string): string {
  const m = pick<string>(json, "message", "error", "errmsg"); return m || `Order rejected by broker (${status}). ${text.slice(0, 160)}`;
}
