/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/*
 * A harness for the REAL trade manager (src/lib/flow/flowManage.ts → manageOpenPositions): the in-memory
 * database and fixed clock of _routes.ts, and a stand-in TradeLocker account that holds positions, quotes
 * a price, and moves a stop, banks a partial or closes a trade when the manager asks — recording every
 * request. Nothing leaves the process.
 *
 * The broker functions are swapped in before the manager is loaded (the module cache is seeded with a
 * copy of each real module, with the network calls replaced), so the manager's own code — every gate,
 * every level, every write — is the code that runs.
 *
 * IMPORT THIS FIRST in a test file, then `loadManager()`.
 */
import "./_routes";
import { T, db, setNow, T0, fail } from "./_routes";
export { T, db, fail };
import Module from "node:module";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
// The manager folds in recent 1-minute candle extremes from the market-data feed. Without a key it
// skips them, so the best price a trade reached is exactly the prices a test walks it through.
delete process.env.TWELVEDATA_API_KEY;

// The manager waits half a second before reading a stop back, and 400ms before retrying a failed read.
// Real time is not what is under test: those waits run at once here.
const realSetTimeout = global.setTimeout;
(global as any).setTimeout = (fn: (...a: any[]) => void, ms?: number, ...a: any[]) => realSetTimeout(fn, ms != null && ms >= 100 ? 0 : ms, ...a);

/* ── the broker ───────────────────────────────────────────────────────────────────────────────── */
export type FakePos = { id: string; accountId: string; inst: string; side: "buy" | "sell"; qty: number; avgPrice: number; sl: number | null; tp: number | null; pendingQty?: number; lag?: number };
export const INSTRUMENTS = [
  { brokerSymbol: "XAUUSD", tradableInstrumentId: "101", routeId: "1", infoRouteId: "2", quantityStep: 0.01, minQuantity: 0.01, pricePrecision: 2 },
  { brokerSymbol: "EURUSD", tradableInstrumentId: "278", routeId: "1", infoRouteId: "2", quantityStep: 0.01, minQuantity: 0.01, pricePrecision: 5 },
  { brokerSymbol: "GBPJPY", tradableInstrumentId: "300", routeId: "1", infoRouteId: "2", quantityStep: 0.01, minQuantity: 0.01, pricePrecision: 3 },
];
const INST_OF: Record<string, string> = { XAUUSD: "101", EURUSD: "278", GBPJPY: "300" };
export const broker = {
  positions: new Map<string, FakePos>(),
  /** Closing fills, per account, as the broker's order history reports them (array rows). */
  history: new Map<string, unknown[][]>(),
  quotes: new Map<string, { bid: number; ask: number }>(),
  /** Every request that would change something at the broker, in order: "modify 9001 sl=4012.3", "close 9001 qty=0.25". */
  calls: [] as string[],
  /** TradeLocker's own position rows carry stopLossId / takeProfitId, not prices (so the manager cannot see a
   *  stop or target on the row). `true` lays the prices on the row instead, the way some brokers do. */
  pricesOnRow: false,
  /** Position reads served — to count what a pass costs the broker. */
  reads: 0,
  /** A part-close that the broker carries out but shows one read late. */
  qtyLag: false,
  /** A part-close that times out at the broker: "done" carries it out anyway, "not_done" does not — either
   *  way the answer is the broker's "outcome unknown" (a 504). */
  closeUncertain: null as null | "done" | "not_done",
  /** Answer a modify or close with an error instead of doing it. */
  refuse: { modify: null as null | ((id: string, mod: any) => string | null), close: null as null | ((id: string, qty?: number) => string | null) },
};
const COLS = () => broker.pricesOnRow
  ? ["id", "tradableInstrumentId", "routeId", "side", "qty", "avgPrice", "stopLoss", "takeProfit", "openDate", "unrealizedPl"]
  : ["id", "tradableInstrumentId", "routeId", "side", "qty", "avgPrice", "stopLossId", "takeProfitId", "openDate", "unrealizedPl"];
const rowOf = (p: FakePos): unknown[] => {
  const q = broker.quotes.get(p.inst);
  const mark = q ? (p.side === "buy" ? q.bid : q.ask) : p.avgPrice;
  const o: Record<string, unknown> = { id: p.id, tradableInstrumentId: p.inst, routeId: "1", side: p.side, qty: p.qty, avgPrice: p.avgPrice,
    stopLoss: p.sl, takeProfit: p.tp, stopLossId: p.sl != null ? 7000 + Number(p.id) : 0, takeProfitId: p.tp != null ? 8000 + Number(p.id) : 0,
    openDate: T0, unrealizedPl: +((p.side === "buy" ? mark - p.avgPrice : p.avgPrice - mark) * p.qty * 100).toFixed(2) };
  return COLS().map((c) => o[c] ?? null);
};
const ok = <D>(data: D) => ({ ok: true as const, data });

function seedModule(rel: string, overrides: Record<string, unknown>): void {
  const file = require.resolve(path.join(ROOT, rel));
  const real = require(file);
  const copy: Record<string, unknown> = { ...real, ...overrides };
  const m = new (Module as any)(file, module);
  m.filename = file; m.loaded = true; m.exports = copy;
  require.cache[file] = m;
}

export const logs: Array<{ phase: string; reason?: string; price?: number; qty?: number; position_id?: string }> = [];
export const choch = { now: null as null | "bullish" | "bearish" };

seedModule("src/lib/flow/tradelocker", {
  listInstruments: async () => ok(INSTRUMENTS),
  listPositions: async (_e: string, _t: string, _n: string, accountId: string) => {
    broker.reads++;
    const mine = [...broker.positions.values()].filter((p) => p.accountId === String(accountId));
    for (const p of mine) if (p.pendingQty != null && (p.lag ?? 0) <= 0) { p.qty = p.pendingQty; delete p.pendingQty; }
    const rows = mine.map(rowOf);
    for (const p of mine) if (p.pendingQty != null) p.lag = (p.lag ?? 0) - 1;
    return ok(rows);
  },
  getConfig: async () => ok({ d: { positionsConfig: { columns: COLS().map((id) => ({ id })) }, ordersHistoryConfig: { columns: ["id", "positionId", "side", "type", "status", "avgPrice", "lastModified"].map((id) => ({ id })) } } }),
  getQuote: async (_e: string, _t: string, _n: string, inst: string) => { const q = broker.quotes.get(String(inst)); return q ? ok({ bid: q.bid, ask: q.ask }) : { ok: false, status: 503, error: "no quote" }; },
  modifyPosition: async (_e: string, _t: string, _n: string, id: string, mod: { stopLoss?: number | null; takeProfit?: number | null }) => {
    broker.calls.push(`modify ${id}${mod.stopLoss != null ? ` sl=${mod.stopLoss}` : ""}${mod.takeProfit != null ? ` tp=${mod.takeProfit}` : ""}`);
    const why = broker.refuse.modify?.(id, mod); if (why) return { ok: false, status: 400, error: why };
    const p = broker.positions.get(String(id)); if (!p) return { ok: false, status: 404, error: "Position not found" };
    if (mod.stopLoss != null) p.sl = mod.stopLoss; if (mod.takeProfit != null) p.tp = mod.takeProfit;
    return ok(true);
  },
  closePosition: async (_e: string, _t: string, _n: string, id: string, qty?: number) => {
    broker.calls.push(`close ${id}${qty != null ? ` qty=${qty}` : ""}`);
    const why = broker.refuse.close?.(id, qty); if (why) return { ok: false, status: 400, error: why };
    const p = broker.positions.get(String(id)); if (!p) return { ok: false, status: 404, error: "Position not found" };
    if (broker.closeUncertain) {
      const done = broker.closeUncertain === "done";
      if (done && qty != null && qty < p.qty - 1e-9) p.qty = +(p.qty - qty).toFixed(6);
      return { ok: false, status: 504, error: "Gateway timeout", uncertain: true };
    }
    if (qty == null || qty >= p.qty - 1e-9) broker.positions.delete(String(id));
    else if (broker.qtyLag) { p.pendingQty = +(p.qty - qty).toFixed(6); p.lag = 1; }
    else p.qty = +(p.qty - qty).toFixed(6);
    return ok(true);
  },
  listOrdersHistory: async (_e: string, _t: string, _n: string, accountId: string) => ok(broker.history.get(String(accountId)) ?? []),
});
seedModule("src/lib/flow/connection", { connectionToken: async () => ({ ok: true, token: "tok", env: "demo" }) });
seedModule("src/lib/flow/brokerEvidence", { readProtectiveStop: async (_e: string, _t: string, _n: string, _a: string, id: string) => broker.positions.get(String(id))?.sl ?? null });
seedModule("src/lib/flow/feedPrice", { feedPrice: async () => null });
seedModule("src/lib/genx/choch", { goldChangeOfCharacter: async () => choch.now });
seedModule("src/lib/flow/recover", { recoverOrphans: async () => ({ adopted: 0, checked: 0 }) });
seedModule("src/lib/genx2/cancelReconcile", { reconcileStaleGoldEntries: async () => ({ scanned: 0, released: 0, filled: 0, held: 0 }) });
seedModule("src/lib/genx2/reservation", { releaseGold: async () => true });
seedModule("src/lib/flow/health", { beat: async () => {} });
seedModule("src/lib/flow/tradeLog", { logTrade: async (_a: unknown, e: any) => { logs.push({ phase: e.phase, reason: e.reason, price: e.price, qty: e.qty, position_id: e.position_id }); } });

/** `noNewColumns`: the database as it was before the 10-08 migration — a read of trail_mode or partial_pct
 *  is refused the way Postgres refuses an unknown column. */
export const schema = { noNewColumns: false, flaky: false };

// The database refuses a second partial reservation for one position, as the real unique key does.
const routedFetch = (globalThis as any).fetch;
(globalThis as any).fetch = async (input: any, init: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (schema.noNewColumns && url.pathname === "/rest/v1/flow_broker_accounts" && /trail_mode|partial_pct/.test(url.searchParams.get("select") ?? ""))
    return new Response(JSON.stringify({ code: "42703", message: "column flow_broker_accounts.trail_mode does not exist" }), { status: 400, headers: { "content-type": "application/json" } });
  // `flaky`: the full settings read times out (a blip), while a smaller read of the same table would answer.
  if (schema.flaky && url.pathname === "/rest/v1/flow_broker_accounts" && /trail_mode/.test(url.searchParams.get("select") ?? ""))
    return new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
  if (url.pathname === "/rest/v1/flow_partial_operations" && String(init.method ?? "GET").toUpperCase() === "POST") {
    const body = JSON.parse(String(init.body));
    const r = Array.isArray(body) ? body[0] : body;
    if (T("flow_partial_operations").some((x) => x.environment === r.environment && x.account_id === r.account_id && x.position_id === r.position_id))
      return new Response(JSON.stringify({ code: "23505", message: "duplicate key value violates unique constraint" }), { status: 409, headers: { "content-type": "application/json" } });
  }
  return routedFetch(input, init);
};

/** The manager module at `rel` (default: the real one), loaded against the stand-ins above. */
export function loadManager(rel = "src/lib/flow/flowManage"): { manageOpenPositions: () => Promise<{ managed: number; actions: any[] }> } {
  return require(path.join(ROOT, rel));
}

/* ── a scenario ───────────────────────────────────────────────────────────────────────────────── */
let clock = T0, posSeq = 9000;
export function reset(): void {
  for (const t of ["flow_managed_positions", "flow_broker_accounts", "flow_partial_operations", "flow_trade_log"]) db[t] = [];
  broker.positions.clear(); broker.quotes.clear(); broker.history.clear(); broker.calls.length = 0; broker.pricesOnRow = false; broker.reads = 0; broker.qtyLag = false; broker.closeUncertain = null;
  broker.refuse.modify = null; broker.refuse.close = null; logs.length = 0; choch.now = null; posSeq = 9000;
  schema.noNewColumns = false; schema.flaky = false; fail.tables.clear();
  // A fresh day, at the same liquid hour: every module-level cache and wait from the last scenario has run out
  // (the manager keeps a broker's column layout for six hours).
  clock += 24 * 3_600_000; setNow(clock);
}

/** An account row as the settings screen leaves it (defaults: AI Pips on, as it is today after the migration). */
export function account(id: string, o: Record<string, unknown> = {}): void {
  T("flow_broker_accounts").push({ id: `acct-${id}-${T("flow_broker_accounts").length}`, user_id: "u1", connection_id: `conn-${id}`, account_id: id, acc_num: id,
    manage_trades: true, gold_be_pips: null, be_enabled: true, trail_mode: "normal", partial_pct: 0, ...o });
}

const PIP: Record<string, number> = { XAUUSD: 0.1, EURUSD: 0.0001, GBPJPY: 0.01 };
/** An open trade FLOW placed: on the broker, and in the manager's ledger. `tpAtBroker` is the take-profit order
 *  actually resting (gold's near target); `tp1` is the plan's target the ledger keeps. */
export function trade(o: { account: string; symbol: "XAUUSD" | "EURUSD" | "GBPJPY"; side: "buy" | "sell"; entry: number; stop: number; tp1: number | null; qty: number; tpAtBroker?: number | null; fill?: number }): string {
  const id = String(++posSeq);
  broker.positions.set(id, { id, accountId: o.account, inst: INST_OF[o.symbol], side: o.side, qty: o.qty, avgPrice: o.fill ?? o.entry, sl: o.stop, tp: o.tpAtBroker === undefined ? o.tp1 : o.tpAtBroker });
  T("flow_managed_positions").push({ id: `row-${id}`, user_id: "u1", connection_id: `conn-${o.account}`, account_id: o.account, acc_num: o.account, environment: "demo",
    position_id: id, symbol: o.symbol, side: o.side, entry: o.entry, init_stop: o.stop, tp1: o.tp1, r: Math.abs(o.entry - o.stop), qty: o.qty,
    cur_stop: o.stop, best_price: o.entry, worst_price: null, be_done: false, partial_done: false, status: "open", last_error: null,
    created_at: new Date(clock - 60_000).toISOString(), updated_at: new Date(clock - 60_000).toISOString(), partial_px: null, partial_frac: null });
  return id;
}

/** Quote a symbol around `mid` (pips of spread), move the clock on, and run one pass of the manager. */
export async function pass(mgr: ReturnType<typeof loadManager>, symbol: "XAUUSD" | "EURUSD" | "GBPJPY", mid: number, spreadPips = 3, stepMs = 2_500): Promise<void> {
  const half = (spreadPips * PIP[symbol]) / 2;
  const q = { bid: +(mid - half).toFixed(6), ask: +(mid + half).toFixed(6) };
  broker.quotes.set(INST_OF[symbol], q);
  clock += stepMs; setNow(clock);
  // The broker's resting stop and take-profit fill when price trades through them.
  for (const p of [...broker.positions.values()]) {
    if (p.inst !== INST_OF[symbol]) continue;
    const exit = p.side === "buy" ? q.bid : q.ask;
    const stopHit = p.sl != null && (p.side === "buy" ? exit <= p.sl : exit >= p.sl);
    const tpHit = p.tp != null && (p.side === "buy" ? exit >= p.tp : exit <= p.tp);
    if (!stopHit && !tpHit) continue;
    broker.positions.delete(p.id);
    const h = broker.history.get(p.accountId) ?? [];
    h.push([`h${p.id}`, p.id, p.side === "buy" ? "sell" : "buy", stopHit ? "stop" : "limit", "Filled", stopHit ? p.sl : p.tp, clock]);
    broker.history.set(p.accountId, h);
  }
  await mgr.manageOpenPositions();
}

/** Run passes with time moving on fast enough for the manager to book a trade that left the broker (it waits
 *  three misses and 45 seconds before it believes a position is gone). */
export async function settle(mgr: ReturnType<typeof loadManager>, symbol: "XAUUSD" | "EURUSD" | "GBPJPY", mid: number, passes = 4): Promise<void> {
  for (let i = 0; i < passes; i++) await pass(mgr, symbol, mid, 3, 20_000);
}

/** Walk the price through `path` (one pass at each). */
export async function walk(mgr: ReturnType<typeof loadManager>, symbol: "XAUUSD" | "EURUSD" | "GBPJPY", path: number[], spreadPips = 3): Promise<void> {
  for (const p of path) await pass(mgr, symbol, p, spreadPips);
}

export const ledger = (positionId: string) => T("flow_managed_positions").find((r) => r.position_id === positionId)!;
/** What the manager did, comparable across two versions of it: broker requests, the ledger, and the log. */
export function record(): { calls: string[]; rows: any[]; logs: any[] } {
  const rows = T("flow_managed_positions").map(({ updated_at: _u, created_at: _c, resolved_at: _r, ...r }) => ({ ...r, last_error: r.last_error == null ? null : String(r.last_error).replace(/\d{12,}/g, "<ms>") }));
  return { calls: [...broker.calls], rows: JSON.parse(JSON.stringify(rows)), logs: logs.map((l) => ({ ...l })) };
}
