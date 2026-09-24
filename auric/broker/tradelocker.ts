/**
 * AURIC's own TradeLocker Public API adapter (v1.5 docs, re-read 2026-09-22 at public-api.tradelocker.com).
 * Independent of FLOW and Command Center. Owns its own token pair, rate gate and latency measurement.
 *
 * Documented facts this file relies on:
 *  - Base URLs demo.tradelocker.com/backend-api and live.tradelocker.com/backend-api.
 *  - /auth/jwt/token {email,password,server} → {accessToken, refreshToken}; /auth/jwt/refresh {refreshToken}.
 *  - /auth/jwt/all-accounts → {accounts:[{id, accNum, name, currency, accountBalance, status}]}.
 *  - Every /trade/* call: Authorization Bearer + `accNum` header. Path parameter is `accountId` (≠ accNum).
 *  - Developer Program key header is `developer-api-key` (docs prose also mentions tl-developer-api-key; both are sent).
 *  - /trade/config → positionsConfig/ordersConfig/... columns, rateLimits[{rateLimitType,measure,intervalNum,limit}].
 *  - Data rows are positional arrays zipped with the config columns.
 *  - POST /trade/accounts/{accountId}/orders body: qty, routeId, side, type, validity (IOC for market), price,
 *    stopLoss+stopLossType, takeProfit+takeProfitType, strategyId (≤31 chars). Response {orderId}.
 *  - PATCH /trade/positions/{positionId} {stopLoss, takeProfit}; DELETE /trade/positions/{positionId} {qty:0}.
 *  - No idempotency key exists. A timeout is UNKNOWN, never "failed".
 */
export type TLEnv = "demo" | "live";
export const TL_HOSTS: Record<TLEnv, string> = { demo: "https://demo.tradelocker.com/backend-api", live: "https://live.tradelocker.com/backend-api" };

export type TLResult<T> = { ok: true; data: T; latencyMs: number; status: number } | { ok: false; status: number; error: string; uncertain: boolean; latencyMs: number; raw?: unknown };
export type TLAuth = { env: TLEnv; accessToken: string; accountId: string; accNum: string };
export type TLTokens = { accessToken: string; refreshToken: string; exp: number | null };
export type TLAccountRow = { id: string; accNum: string; name: string | null; currency: string | null; balance: number | null; status: string | null };
export type RateLimit = { rateLimitType: string; measure: "SECONDS" | "MINUTES"; intervalNum: number; limit: number };
export type TLConfig = { columns: Record<string, string[]>; rateLimits: RateLimit[]; limits: Record<string, number>; raw: unknown };

const TIMEOUT_MS = 12_000;
const DEV_KEY = () => process.env.TL_DEVELOPER_API_KEY ?? "";

/* ---- per-route rate gate: refuses locally instead of spending a request to be told 429 ---- */
const backoffUntil = new Map<string, number>();
export const routeKey = (m: string, p: string) => `${m.toUpperCase()} ${p.split("?")[0].replace(/\/\d+(?=\/|$)/g, "/:id")}`;
export const anyBackoff = (routes?: string[]) => [...backoffUntil.entries()].some(([k, t]) => (!routes || routes.includes(k)) && Date.now() < t);
const lastCall = new Map<string, number>();
/** Minimum spacing per route derived from /trade/config (default 550ms when unknown). */
const minSpacing = new Map<string, number>();
export function applyRateLimits(cfg: TLConfig) {
  const map: Record<string, string> = { QUOTES: "GET /trade/quotes", GET_POSITIONS: "GET /trade/accounts/:id/positions", GET_ORDERS: "GET /trade/accounts/:id/orders", GET_ORDERS_HISTORY: "GET /trade/accounts/:id/ordersHistory", GET_ACCOUNTS_STATE: "GET /trade/accounts/:id/state", PLACE_ORDER: "POST /trade/accounts/:id/orders", MODIFY_POSITION: "PATCH /trade/positions/:id", QUOTES_HISTORY: "GET /trade/history", GET_INSTRUMENTS: "GET /trade/accounts/:id/instruments", GET_INSTRUMENT_DETAILS: "GET /trade/instruments/:id", GET_EXECUTIONS: "GET /trade/accounts/:id/executions" };
  for (const r of cfg.rateLimits) {
    const k = map[r.rateLimitType]; if (!k || !(r.limit > 0)) continue;
    const windowMs = (r.measure === "MINUTES" ? 60_000 : 1000) * (r.intervalNum || 1);
    minSpacing.set(k, Math.ceil(windowMs / r.limit) + 25); // +25ms safety
  }
}
export function spacingFor(key: string): number { return minSpacing.get(key) ?? 550; }

async function call<T>(env: TLEnv, path: string, init: RequestInit & { token?: string; accNum?: string } = {}): Promise<TLResult<T>> {
  const method = String(init.method ?? "GET"); const rk = routeKey(method, path);
  const bo = (backoffUntil.get(rk) ?? 0) - Date.now();
  if (bo > 0) return { ok: false, status: 429, error: `local backoff on ${rk} for ${Math.ceil(bo / 1000)}s`, uncertain: true, latencyMs: 0 };
  const wait = (lastCall.get(rk) ?? 0) + spacingFor(rk) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall.set(rk, Date.now());
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.accNum) headers.accNum = String(init.accNum);
  if (DEV_KEY()) { headers["developer-api-key"] = DEV_KEY(); headers["tl-developer-api-key"] = DEV_KEY(); }
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const r = await fetch(`${TL_HOSTS[env]}${path}`, { ...init, headers, cache: "no-store", signal: ctrl.signal });
    const latencyMs = performance.now() - t0;
    const text = await r.text(); let body: unknown = null; try { body = text ? JSON.parse(text) : null; } catch { /* 204 */ }
    const s = String((body as Record<string, unknown> | null)?.s ?? "").toLowerCase();
    const rejected = r.status < 200 || r.status >= 300 || s === "error" || s === "fail" || s === "rejected";
    if (rejected) {
      const msg = String((body as Record<string, unknown> | null)?.errmsg ?? (body as Record<string, unknown> | null)?.message ?? text.slice(0, 200) ?? `HTTP ${r.status}`);
      if (r.status === 429) { const ra = Number(r.headers.get("retry-after")); backoffUntil.set(rk, Date.now() + (Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : 30_000)); }
      return { ok: false, status: r.status, error: msg, uncertain: r.status >= 500 || r.status === 408 || r.status === 429, latencyMs, raw: body };
    }
    return { ok: true, data: (body ?? true) as T, latencyMs, status: r.status };
  } catch (e) {
    const latencyMs = performance.now() - t0;
    const aborted = e instanceof Error && e.name === "AbortError";
    return { ok: false, status: 0, error: aborted ? "timeout" : e instanceof Error ? e.message : "network", uncertain: true, latencyMs };
  } finally { clearTimeout(timer); }
}

function jwtExp(token: string): number | null {
  try { const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); return typeof p.exp === "number" ? p.exp * 1000 : null; } catch { return null; }
}

export async function authenticate(env: TLEnv, email: string, password: string, server: string): Promise<TLResult<TLTokens>> {
  const r = await call<{ accessToken?: string; refreshToken?: string }>(env, "/auth/jwt/token", { method: "POST", body: JSON.stringify({ email, password, server }) });
  if (!r.ok) return r;
  if (!r.data.accessToken || !r.data.refreshToken) return { ok: false, status: r.status, error: "no tokens in response", uncertain: false, latencyMs: r.latencyMs };
  return { ...r, data: { accessToken: r.data.accessToken, refreshToken: r.data.refreshToken, exp: jwtExp(r.data.accessToken) } };
}
export async function refreshTokens(env: TLEnv, refreshToken: string): Promise<TLResult<TLTokens>> {
  const r = await call<{ accessToken?: string; refreshToken?: string }>(env, "/auth/jwt/refresh", { method: "POST", body: JSON.stringify({ refreshToken }) });
  if (!r.ok) return r;
  if (!r.data.accessToken) return { ok: false, status: r.status, error: "no access token in refresh", uncertain: false, latencyMs: r.latencyMs };
  return { ...r, data: { accessToken: r.data.accessToken, refreshToken: r.data.refreshToken ?? refreshToken, exp: jwtExp(r.data.accessToken) } };
}

const unwrap = (b: unknown): unknown => (b && typeof b === "object" && "d" in (b as object) ? (b as { d: unknown }).d : b);
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v: unknown): string | null => (v == null ? null : String(v));

export async function listAccounts(env: TLEnv, token: string): Promise<TLResult<TLAccountRow[]>> {
  const r = await call<unknown>(env, "/auth/jwt/all-accounts", { token });
  if (!r.ok) return r;
  const d = unwrap(r.data) as { accounts?: unknown[] } | unknown[];
  const rows = Array.isArray(d) ? d : Array.isArray((d as { accounts?: unknown[] })?.accounts) ? (d as { accounts: unknown[] }).accounts : [];
  return { ...r, data: rows.map((a) => { const o = a as Record<string, unknown>; return { id: String(o.id), accNum: String(o.accNum), name: str(o.name), currency: str(o.currency), balance: num(o.accountBalance ?? o.balance), status: str(o.status) }; }) };
}

export async function getConfig(a: TLAuth): Promise<TLResult<TLConfig>> {
  const r = await call<unknown>(a.env, "/trade/config", { token: a.accessToken, accNum: a.accNum });
  if (!r.ok) return r;
  const d = unwrap(r.data) as Record<string, unknown>;
  const columns: Record<string, string[]> = {};
  for (const key of ["positionsConfig", "ordersConfig", "ordersHistoryConfig", "filledOrdersConfig", "accountDetailsConfig"]) {
    const c = d?.[key] as { columns?: Array<{ id: string }> } | undefined;
    if (c?.columns) columns[key] = c.columns.map((x) => String(x.id));
  }
  const rateLimits = (Array.isArray(d?.rateLimits) ? d.rateLimits : []) as RateLimit[];
  const limits: Record<string, number> = {};
  for (const l of (Array.isArray(d?.limits) ? d.limits : []) as Array<{ limitType: string; limit: number }>) limits[l.limitType] = l.limit;
  return { ...r, data: { columns, rateLimits, limits, raw: d } };
}

const acct = (a: TLAuth, s = "") => `/trade/accounts/${encodeURIComponent(a.accountId)}${s}`;
const ah = (a: TLAuth) => ({ token: a.accessToken, accNum: a.accNum });

export type TLInstrumentRow = { tradableInstrumentId: string; name: string; routes: Array<{ id: string; type: string }>; raw: unknown };
export async function listInstruments(a: TLAuth): Promise<TLResult<TLInstrumentRow[]>> {
  const r = await call<unknown>(a.env, acct(a, "/instruments"), ah(a));
  if (!r.ok) return r;
  const d = unwrap(r.data) as { instruments?: unknown[] } | unknown[];
  const rows = Array.isArray(d) ? d : Array.isArray((d as { instruments?: unknown[] })?.instruments) ? (d as { instruments: unknown[] }).instruments : [];
  return { ...r, data: rows.map((x) => { const o = x as Record<string, unknown>; return { tradableInstrumentId: String(o.tradableInstrumentId ?? o.id), name: String(o.name ?? ""), routes: (Array.isArray(o.routes) ? o.routes : []).map((q) => { const t = q as Record<string, unknown>; return { id: String(t.id), type: String(t.type) }; }), raw: o }; }) };
}
export const getInstrumentDetails = (a: TLAuth, tradableInstrumentId: string, routeId: string) =>
  call<unknown>(a.env, `/trade/instruments/${encodeURIComponent(tradableInstrumentId)}?routeId=${encodeURIComponent(routeId)}&locale=en`, ah(a));
export const getSessionDetails = (a: TLAuth, sessionId: string) => call<unknown>(a.env, `/trade/sessions/${encodeURIComponent(sessionId)}`, ah(a));

export type TLQuoteRaw = { bid: number; ask: number; bidSize: number | null; askSize: number | null; latencyMs: number; receivedAt: number };
export async function getQuote(a: TLAuth, tradableInstrumentId: string, infoRouteId: string): Promise<TLResult<TLQuoteRaw>> {
  const r = await call<unknown>(a.env, `/trade/quotes?routeId=${encodeURIComponent(infoRouteId)}&tradableInstrumentId=${encodeURIComponent(tradableInstrumentId)}`, ah(a));
  if (!r.ok) return r;
  const d = unwrap(r.data) as Record<string, unknown>;
  const bid = num(d?.bp), ask = num(d?.ap);
  if (bid == null || ask == null) return { ok: false, status: r.status, error: "quote missing bp/ap", uncertain: false, latencyMs: r.latencyMs, raw: d };
  return { ...r, data: { bid, ask, bidSize: num(d?.bs), askSize: num(d?.as), latencyMs: r.latencyMs, receivedAt: Date.now() } };
}

export type TLBar = { t: number; o: number; h: number; l: number; c: number; v: number | null };
export async function getHistory(a: TLAuth, tradableInstrumentId: string, infoRouteId: string, resolution: "1m" | "5m" | "15m" | "1H", fromMs: number, toMs: number): Promise<TLResult<TLBar[]>> {
  const r = await call<unknown>(a.env, `/trade/history?routeId=${encodeURIComponent(infoRouteId)}&tradableInstrumentId=${encodeURIComponent(tradableInstrumentId)}&resolution=${resolution}&from=${Math.floor(fromMs)}&to=${Math.floor(toMs)}`, ah(a));
  if (!r.ok) return r;
  const d = unwrap(r.data) as { barDetails?: unknown[] };
  const rows = Array.isArray(d?.barDetails) ? d.barDetails : [];
  const bars: TLBar[] = [];
  for (const x of rows) {
    const o = x as Record<string, unknown>;
    const t = num(o.t), op = num(o.o), h = num(o.h), l = num(o.l), c = num(o.c);
    if (t == null || op == null || h == null || l == null || c == null) continue;
    bars.push({ t: t < 1e12 ? t * 1000 : t, o: op, h, l, c, v: num(o.v) });
  }
  return { ...r, data: bars };
}

function zip(rows: unknown[], cols: string[] | undefined): Array<Record<string, unknown>> {
  return rows.map((row) => {
    if (Array.isArray(row)) { const o: Record<string, unknown> = {}; (cols ?? []).forEach((c, i) => { o[c] = row[i]; }); return o; }
    return (row ?? {}) as Record<string, unknown>;
  });
}

export type TLPosition = { id: string; tradableInstrumentId: string; routeId: string; side: "buy" | "sell"; qty: number; avgPrice: number | null; stopLossId: string | null; takeProfitId: string | null; openDate: number | null; unrealizedPl: number | null; strategyId: string | null; raw: Record<string, unknown> };
export async function listPositions(a: TLAuth, cfg: TLConfig | null): Promise<TLResult<TLPosition[]>> {
  const r = await call<unknown>(a.env, acct(a, "/positions"), ah(a));
  if (!r.ok) return r;
  const d = unwrap(r.data) as { positions?: unknown[] };
  const rows = zip(Array.isArray(d?.positions) ? d.positions : [], cfg?.columns.positionsConfig);
  return { ...r, data: rows.map((o) => ({ id: String(o.id), tradableInstrumentId: String(o.tradableInstrumentId), routeId: String(o.routeId), side: String(o.side).toLowerCase() === "sell" ? "sell" : "buy", qty: num(o.qty) ?? 0, avgPrice: num(o.avgPrice), stopLossId: str(o.stopLossId), takeProfitId: str(o.takeProfitId), openDate: num(o.openDate), unrealizedPl: num(o.unrealizedPl), strategyId: str(o.strategyId), raw: o })) };
}
export type TLOrder = { id: string; tradableInstrumentId: string; qty: number; side: string; type: string; status: string; filledQty: number | null; avgPrice: number | null; price: number | null; stopPrice: number | null; positionId: string | null; strategyId: string | null; createdDate: number | null; isOpen: boolean | null; stopLoss: number | null; takeProfit: number | null; raw: Record<string, unknown> };
const mapOrder = (o: Record<string, unknown>): TLOrder => ({ id: String(o.id), tradableInstrumentId: String(o.tradableInstrumentId), qty: num(o.qty) ?? 0, side: String(o.side ?? "").toLowerCase(), type: String(o.type ?? "").toLowerCase(), status: String(o.status ?? "").toUpperCase(), filledQty: num(o.filledQty), avgPrice: num(o.avgPrice), price: num(o.price), stopPrice: num(o.stopPrice), positionId: str(o.positionId), strategyId: str(o.strategyId), createdDate: num(o.createdDate), isOpen: typeof o.isOpen === "boolean" ? o.isOpen : null, stopLoss: num(o.stopLoss), takeProfit: num(o.takeProfit), raw: o });
export async function listOrders(a: TLAuth, cfg: TLConfig | null): Promise<TLResult<TLOrder[]>> {
  const r = await call<unknown>(a.env, acct(a, "/orders"), ah(a)); if (!r.ok) return r;
  const d = unwrap(r.data) as { orders?: unknown[] };
  return { ...r, data: zip(Array.isArray(d?.orders) ? d.orders : [], cfg?.columns.ordersConfig).map(mapOrder) };
}
export async function listOrdersHistory(a: TLAuth, cfg: TLConfig | null, fromMs?: number): Promise<TLResult<TLOrder[]>> {
  const q = fromMs ? `?from=${Math.floor(fromMs)}&to=${Date.now() + 60_000}` : "";
  const r = await call<unknown>(a.env, acct(a, `/ordersHistory${q}`), ah(a)); if (!r.ok) return r;
  const d = unwrap(r.data) as { ordersHistory?: unknown[]; orders?: unknown[] };
  const rows = Array.isArray(d?.ordersHistory) ? d.ordersHistory : Array.isArray(d?.orders) ? d.orders : [];
  return { ...r, data: zip(rows, cfg?.columns.ordersHistoryConfig ?? cfg?.columns.ordersConfig).map(mapOrder) };
}

export type TLAccountState = { balance: number | null; projectedBalance: number | null; availableFunds: number | null; openNetPnL: number | null; initialMarginReq: number | null; positionsCount: number | null; ordersCount: number | null; raw: Record<string, unknown> };
export async function getAccountState(a: TLAuth, cfg: TLConfig | null): Promise<TLResult<TLAccountState>> {
  const r = await call<unknown>(a.env, acct(a, "/state"), ah(a)); if (!r.ok) return r;
  const d = unwrap(r.data) as { accountDetailsData?: unknown };
  const row = d?.accountDetailsData;
  const o = Array.isArray(row) ? zip([row], cfg?.columns.accountDetailsConfig)[0] : ((row ?? d ?? {}) as Record<string, unknown>);
  return { ...r, data: { balance: num(o.balance), projectedBalance: num(o.projectedBalance), availableFunds: num(o.availableFunds), openNetPnL: num(o.openNetPnL), initialMarginReq: num(o.initialMarginReq), positionsCount: num(o.positionsCount), ordersCount: num(o.ordersCount), raw: o } };
}

export type PlaceOrderInput = { tradableInstrumentId: string; tradeRouteId: string; side: "buy" | "sell"; qty: number; stopLoss: number; takeProfit: number; strategyId: string };
/** Market IOC order with ABSOLUTE stop-loss and take-profit attached. Timeout → uncertain; the caller reconciles by strategyId. */
export async function placeMarketOrder(a: TLAuth, i: PlaceOrderInput): Promise<TLResult<{ orderId: string }>> {
  const body = { qty: i.qty, routeId: Number(i.tradeRouteId), side: i.side, type: "market", validity: "IOC", price: 0, tradableInstrumentId: Number(i.tradableInstrumentId), stopLoss: i.stopLoss, stopLossType: "absolute", takeProfit: i.takeProfit, takeProfitType: "absolute", strategyId: i.strategyId.slice(0, 31) };
  const r = await call<unknown>(a.env, acct(a, "/orders"), { ...ah(a), method: "POST", body: JSON.stringify(body) });
  if (!r.ok) return r;
  const d = unwrap(r.data) as Record<string, unknown>;
  const orderId = str(d?.orderId ?? d?.id);
  if (!orderId) return { ok: false, status: r.status, error: "no orderId in response", uncertain: true, latencyMs: r.latencyMs, raw: d };
  return { ...r, data: { orderId } };
}
export const modifyPosition = (a: TLAuth, positionId: string, p: { stopLoss?: number | null; takeProfit?: number | null }) =>
  call<unknown>(a.env, `/trade/positions/${encodeURIComponent(positionId)}`, { ...ah(a), method: "PATCH", body: JSON.stringify(p) });
export const closePosition = (a: TLAuth, positionId: string, qty = 0) =>
  call<unknown>(a.env, `/trade/positions/${encodeURIComponent(positionId)}`, { ...ah(a), method: "DELETE", body: JSON.stringify({ qty }) });
export const cancelOrder = (a: TLAuth, orderId: string) =>
  call<unknown>(a.env, `/trade/orders/${encodeURIComponent(orderId)}`, { ...ah(a), method: "DELETE" });
export async function listExecutions(a: TLAuth): Promise<TLResult<Array<Record<string, unknown>>>> {
  const r = await call<unknown>(a.env, acct(a, "/executions"), ah(a)); if (!r.ok) return r;
  const d = unwrap(r.data) as { executions?: unknown[] };
  return { ...r, data: (Array.isArray(d?.executions) ? d.executions : []) as Array<Record<string, unknown>> };
}
