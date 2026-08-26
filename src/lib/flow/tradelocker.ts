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
export type TLInstrument = { canonical?: string; brokerSymbol: string; tradableInstrumentId: string; routeId: string; infoRouteId?: string; quantityStep?: number; minQuantity?: number; pricePrecision?: number;
  // Broker-reported contract metadata (READ-ONLY diagnostics — NOT wired into sizing; sizing
  // uses the validated constants in sizing.ts). Any of these may be undefined if the broker's
  // instrument list doesn't carry it. Used to compare assumed vs actual point value.
  contractSize?: number; tickSize?: number; tickValue?: number; lotSize?: number;
  raw?: unknown };
export type TLQuote = { bid: number | null; ask: number | null; raw?: unknown };
export type TLResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; raw?: unknown };

const TIMEOUT_MS = 15000;

// ── Outbound request pacing + rate-limit retry ─────────────────────────────
// TradeLocker's edge (Cloudflare) rate-limits by IP and returns HTTP 429 with
// "Error 1015: You are being rate limited". When a member has several accounts
// on one broker login, the auto-exec fan-out fires many calls to the SAME host
// in the same tick and trips that limit — so a signal fills on some accounts
// (e.g. Genesis) and fails on others (e.g. Crucial, which has 3 accounts).
// Defense is two-layered: (1) serialize calls PER HOST with a minimum gap so a
// burst is spread out instead of arriving all at once, and (2) retry a 429 /
// 1015 with exponential backoff. A 1015 is blocked at the edge BEFORE it reaches
// the broker, so retrying it is safe even for order placement (nothing was
// submitted). Generic 429s without the 1015 marker are only retried for GETs.
const HOST_MIN_GAP_MS = 150;
const RL_MAX_RETRIES = 4;
const _hostTail = new Map<string, Promise<unknown>>();
const _hostLastAt = new Map<string, number>();
const _sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` after waiting out this host's minimum inter-request gap, serialized
 *  so concurrent callers to the same host queue instead of bursting. */
function pacedByHost<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const prev = _hostTail.get(host) ?? Promise.resolve();
  const run = prev.then(async () => {
    const gap = HOST_MIN_GAP_MS - (Date.now() - (_hostLastAt.get(host) ?? 0));
    if (gap > 0) await _sleep(gap);
    try { return await fn(); } finally { _hostLastAt.set(host, Date.now()); }
  });
  // keep the chain alive even if this call throws, so the queue never wedges
  _hostTail.set(host, run.then(() => {}, () => {}));
  return run;
}

function isCloudflare1015(status: number, text: string): boolean {
  return status === 429 && /1015|error-1015|being rate limited/i.test(text);
}

async function tlFetch(env: TLEnv, path: string, init: RequestInit & { accessToken?: string; accNum?: string } = {}): Promise<{ status: number; json: unknown; text: string }> {
  const host = TL_HOSTS[env];
  const method = String(init.method || "GET").toUpperCase();
  const isGet = method === "GET";
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (init.accessToken) headers["Authorization"] = `Bearer ${init.accessToken}`;
  if (init.accNum) headers["accNum"] = String(init.accNum);

  const once = async (): Promise<{ status: number; json: unknown; text: string }> => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${host}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> || {}) }, signal: ctrl.signal, cache: "no-store" });
      const text = await r.text();
      let json: unknown = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
      return { status: r.status, json, text };
    } finally { clearTimeout(to); }
  };

  return pacedByHost(host, async () => {
    let res = await once();
    for (let attempt = 0; attempt < RL_MAX_RETRIES; attempt++) {
      // Retry a rate-limit: always for the edge-level 1015 (request never reached
      // the broker, so it's safe even for POSTs), and for any 429/503 on a GET.
      const rateLimited = isCloudflare1015(res.status, res.text) || ((res.status === 429 || res.status === 503) && isGet);
      if (!rateLimited) break;
      await _sleep(400 * Math.pow(2, attempt) + Math.floor(Math.random() * 250)); // 0.4s,0.8s,1.6s,3.2s + jitter
      res = await once();
    }
    return res;
  });
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
  if (status < 200 || status >= 300) {
    const detail = (pick<string>(json, "message", "error", "errmsg") || String(text).slice(0, 100)).trim();
    return { ok: false, status, error: `Couldn't load broker instruments (${status})${detail ? ": " + detail : ""}`, raw: json ?? text };
  }
  const arr = (pick<unknown[]>(json, "instruments") ?? pick<unknown[]>(pick(json, "d"), "instruments") ?? (Array.isArray(json) ? json : [])) as unknown[];
  const out: TLInstrument[] = arr.map((i) => {
    // TradeLocker carries routing in a `routes` array on each instrument:
    // a TRADE route (used to place orders) and an INFO route (used for quotes).
    // The old code read a non-existent top-level `routeId`, so orders went out
    // with an empty route and the broker rejected them.
    const routes = (pick<unknown[]>(i, "routes") ?? []) as unknown[];
    const routeType = (r: unknown) => String(pick(r, "type") ?? "").toUpperCase();
    const routeId = (r: unknown) => strOr(pick(r, "id", "routeId"));
    const tradeRoute = routes.find((r) => ["TRADE", "PRIMARY", "ORDER"].includes(routeType(r)));
    const infoRoute = routes.find((r) => routeType(r) === "INFO");
    const firstRouteId = routes.length ? routeId(routes[0]) : undefined;
    return {
      brokerSymbol: String(pick(i, "name", "symbol", "tradableInstrument") ?? ""),
      tradableInstrumentId: String(pick(i, "tradableInstrumentId", "id") ?? ""),
      routeId: String((tradeRoute ? routeId(tradeRoute) : undefined) ?? pick(i, "routeId", "tradableInstrumentRouteId") ?? firstRouteId ?? ""),
      infoRouteId: (infoRoute ? routeId(infoRoute) : undefined) ?? firstRouteId,
      quantityStep: numOr(pick(i, "lotSize", "quantityStep", "minLot")),
      minQuantity: numOr(pick(i, "minLot", "minQuantity")),
      // Diagnostics-only metadata (see TLInstrument). Parsed defensively from whatever the
      // broker carries; often nested under a details object, so look there too.
      contractSize: numOr(pick(i, "contractSize", "contract_size") ?? pick(pick(i, "details"), "contractSize", "contract_size")),
      tickSize: numOr(pick(i, "tickSize", "tick_size", "minPriceIncrement") ?? pick(pick(i, "details"), "tickSize", "tick_size")),
      tickValue: numOr(pick(i, "tickValue", "tick_value", "valuePerTick") ?? pick(pick(i, "details"), "tickValue", "tick_value")),
      lotSize: numOr(pick(i, "lotSize", "lot_size") ?? pick(pick(i, "details"), "lotSize", "lot_size")),
      raw: i,
    };
  }).filter((i) => i.tradableInstrumentId);
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
 * GET /trade/accounts/{accountId}/ordersHistory — filled/cancelled order history.
 * This is the broker's OWN record of how a position ended (the SL/TP/close execution
 * and its fill price), used to book a closed trade's true outcome instead of guessing
 * from a live quote fetched after the position is already gone. Read-only. The row
 * shape is columnar (indices from /trade/config ordersHistoryConfig) OR object-keyed
 * depending on the broker; the reconciler handles both, so this just returns the array.
 */
export async function listOrdersHistory(env: TLEnv, accessToken: string, accNum: string, accountId: string): Promise<TLResult<unknown[]>> {
  const { status, json, text } = await tlFetch(env, `/trade/accounts/${encodeURIComponent(accountId)}/ordersHistory`, { method: "GET", accessToken, accNum });
  if (status < 200 || status >= 300) return { ok: false, status, error: "Couldn't load broker order history.", raw: json ?? text };
  const arr = (
    pick<unknown[]>(pick(json, "d"), "ordersHistory") ??
    pick<unknown[]>(json, "ordersHistory") ??
    pick<unknown[]>(pick(json, "d"), "orders") ??
    pick<unknown[]>(json, "orders") ??
    (Array.isArray(json) ? json : [])
  ) as unknown[];
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

/**
 * PATCH /trade/positions/{positionId} — modify an open position's SL/TP (prices).
 * Per official docs: body { stopLoss, takeProfit, trailingOffset }; 204 on success;
 * set a field to null to remove it. Used by the trade-manager to move stops.
 */
export async function modifyPosition(env: TLEnv, accessToken: string, accNum: string, positionId: string, mod: { stopLoss?: number | null; takeProfit?: number | null }): Promise<TLResult<true>> {
  const body: Record<string, unknown> = {};
  if (mod.stopLoss !== undefined) body.stopLoss = mod.stopLoss;
  if (mod.takeProfit !== undefined) body.takeProfit = mod.takeProfit;
  const { status, json, text } = await tlFetch(env, `/trade/positions/${encodeURIComponent(positionId)}`, { method: "PATCH", accessToken, accNum, body: JSON.stringify(body) });
  if (status < 200 || status >= 300) return { ok: false, status, error: humanOrderError(status, json, text), raw: json ?? text };
  // TradeLocker can return HTTP 200 with s:"error" (stop too close to market, market
  // closed, bad price, throttled) — that is a REJECTION, not a success. Mirror createOrder:
  // NEVER report a stop move the broker didn't apply, or the manager writes a phantom
  // break-even/trail while the real broker stop stays at the initial loss and the trade
  // stops out for the full loss. A genuine success is 204 (empty body → no `s` field).
  const sVal = String(pick(json, "s") ?? "").toLowerCase();
  if (sVal === "error" || sVal === "fail" || sVal === "rejected") {
    return { ok: false, status, error: humanOrderError(status, json, text), raw: json ?? text };
  }
  return { ok: true, data: true };
}

/**
 * DELETE /trade/positions/{positionId} — close a position. Per official docs a
 * PARTIAL close sets body { qty: <lots to close> }; qty 0 (or omitted) closes it
 * in full. Broker places an IOC-then-GTC closing order, so it may not be instant.
 */
export async function closePosition(env: TLEnv, accessToken: string, accNum: string, positionId: string, qty?: number): Promise<TLResult<true>> {
  const body = qty && qty > 0 ? JSON.stringify({ qty }) : JSON.stringify({ qty: 0 });
  const { status, json, text } = await tlFetch(env, `/trade/positions/${encodeURIComponent(positionId)}`, { method: "DELETE", accessToken, accNum, body });
  if (status < 200 || status >= 300) return { ok: false, status, error: humanOrderError(status, json, text), raw: json ?? text };
  // Same HTTP-200-with-s:"error" rejection as modify/create — never record a partial the
  // broker rejected (partial_done=true while the position is still fully open).
  const sVal = String(pick(json, "s") ?? "").toLowerCase();
  if (sVal === "error" || sVal === "fail" || sVal === "rejected") {
    return { ok: false, status, error: humanOrderError(status, json, text), raw: json ?? text };
  }
  return { ok: true, data: true };
}

/**
 * DELETE /trade/orders/{orderId} — cancel a WORKING (pending) order, e.g. a resting
 * limit that hasn't filled yet. This is the counterpart to createOrder(type:"limit")
 * and is REQUIRED to run resting entries safely: a setup that invalidates must be able
 * to pull its unfilled order so it can't fill later at a dead level. Same HTTP-200-with
 * -s:"error" rejection handling as the other mutators — a broker "error" is NOT a
 * success. A not-found (order already filled/cancelled) is treated as ok (nothing to
 * cancel) so the reconciler is idempotent.
 */
export async function cancelOrder(env: TLEnv, accessToken: string, accNum: string, orderId: string): Promise<TLResult<true>> {
  const { status, json, text } = await tlFetch(env, `/trade/orders/${encodeURIComponent(orderId)}`, { method: "DELETE", accessToken, accNum });
  // 404/410 → the order is already gone (filled or cancelled). Nothing to do → success.
  if (status === 404 || status === 410) return { ok: true, data: true };
  if (status < 200 || status >= 300) return { ok: false, status, error: humanOrderError(status, json, text), raw: json ?? text };
  const sVal = String(pick(json, "s") ?? "").toLowerCase();
  if (sVal === "error" || sVal === "fail" || sVal === "rejected") {
    // "order not found / not working" from the broker also means it's already gone → ok.
    const msg = String(pick(json, "errmsg", "message", "error") ?? "").toLowerCase();
    if (/not found|no such|already|not working|unknown order/.test(msg)) return { ok: true, data: true };
    return { ok: false, status, error: humanOrderError(status, json, text), raw: json ?? text };
  }
  return { ok: true, data: true };
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
