/**
 * TRADELOCKER ADAPTER — the only file in the Command Center permitted to talk to a broker.
 *
 * Verified against the TradeLocker Public API v1.5 reference and llms.txt (2026-09-18):
 *   POST   /auth/jwt/token                                   { email, password, server } → accessToken, refreshToken
 *   POST   /auth/jwt/refresh                                 { refreshToken }            → accessToken
 *   GET    /trade/accounts                                   Authorization
 *   GET    /trade/config                                     Authorization, accNum
 *   GET    /trade/accounts/{accNum}/instruments              Authorization, accNum
 *   GET    /trade/accounts/{accNum}/quotes                   Authorization, accNum
 *   GET    /trade/accounts/{accNum}/orders                   Authorization, accNum
 *   POST   /trade/accounts/{accNum}/orders                   qty, routeId, side, validity, type, tradableInstrumentId
 *   DELETE /trade/accounts/{accNum}/orders/{orderId}         cancel a working order
 *   GET    /trade/accounts/{accNum}/ordersHistory            final-status orders
 *   GET    /trade/accounts/{accNum}/positions                open positions
 *   PATCH  /trade/accounts/{accNum}/positions/{positionId}   stopLoss and/or takeProfit
 *   POST   /trade/accounts/{accNum}/positions/{positionId}/close   full or partial close
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

export type TLAuth = { env: TLEnv; accessToken: string; accNum: string };
export type TLAccount = { id: string; accNum: string; currency?: string; balance?: number; equity?: number };
export type TLInstrument = { tradableInstrumentId: string; routeId: string; name: string; lotStep?: number; minLot?: number; maxLot?: number };
export type TLQuote = { bid: number | null; ask: number | null; at: number };
export type TLPosition = { id: string; instrumentId: string; side: "buy" | "sell"; qty: number; avgPrice: number | null; sl: number | null; tp: number | null; unrealisedPl: number | null };

const TIMEOUT_MS = 15_000;

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

export const listAccounts = (env: TLEnv, token: string) =>
  call<unknown>(env, "/trade/accounts", { token });

export const getConfig = (a: TLAuth) =>
  call<unknown>(a.env, "/trade/config", { token: a.accessToken, accNum: a.accNum });

export const listInstruments = (a: TLAuth) =>
  call<unknown>(a.env, `/trade/accounts/${encodeURIComponent(a.accNum)}/instruments`, { token: a.accessToken, accNum: a.accNum });

export const listPositions = (a: TLAuth) =>
  call<unknown>(a.env, `/trade/accounts/${encodeURIComponent(a.accNum)}/positions`, { token: a.accessToken, accNum: a.accNum });

export const listOrders = (a: TLAuth) =>
  call<unknown>(a.env, `/trade/accounts/${encodeURIComponent(a.accNum)}/orders`, { token: a.accessToken, accNum: a.accNum });

export const ordersHistory = (a: TLAuth) =>
  call<unknown>(a.env, `/trade/accounts/${encodeURIComponent(a.accNum)}/ordersHistory`, { token: a.accessToken, accNum: a.accNum });

export type CreateOrder = {
  tradableInstrumentId: string; routeId: string; qty: number; side: "buy" | "sell";
  type: "market" | "limit" | "stop"; validity: "IOC" | "GTC";
  price?: number; stopLoss?: number; takeProfit?: number;
};

/** Place an order. Never called directly by intelligence — only by the authorised execution path. */
export const createOrder = (a: TLAuth, o: CreateOrder) =>
  call<{ orderId?: string; d?: { orderId?: string } }>(a.env, `/trade/accounts/${encodeURIComponent(a.accNum)}/orders`, {
    method: "POST", token: a.accessToken, accNum: a.accNum, body: JSON.stringify(o),
  });

export const cancelOrder = (a: TLAuth, orderId: string) =>
  call<true>(a.env, `/trade/accounts/${encodeURIComponent(a.accNum)}/orders/${encodeURIComponent(orderId)}`, {
    method: "DELETE", token: a.accessToken, accNum: a.accNum,
  });

/** Modify protection on an open position. Documented as PATCH on the account-scoped position path. */
export const modifyPosition = (a: TLAuth, positionId: string, mod: { stopLoss?: number; takeProfit?: number }) =>
  call<true>(a.env, `/trade/accounts/${encodeURIComponent(a.accNum)}/positions/${encodeURIComponent(positionId)}`, {
    method: "PATCH", token: a.accessToken, accNum: a.accNum, body: JSON.stringify(mod),
  });

/** Close all of a position, or `qty` of it. Documented as POST …/positions/{id}/close. */
export const closePosition = (a: TLAuth, positionId: string, qty?: number) =>
  call<true>(a.env, `/trade/accounts/${encodeURIComponent(a.accNum)}/positions/${encodeURIComponent(positionId)}/close`, {
    method: "POST", token: a.accessToken, accNum: a.accNum, body: JSON.stringify(qty && qty > 0 ? { qty } : {}),
  });
