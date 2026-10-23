/**
 * Test doubles for the FX Scalper worker: an in-memory store with the same rules as the SQL functions
 * (lease and fence, reserve checks, compare-and-set updates), and a simulated TradeLocker broker served
 * through a fake `fetch`. Nothing here talks to a real database or a real broker.
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS, type Settings } from "../src/lib/fxscalper/settings";
import { LIVE_STATES, type ControlRow, type TradeRow } from "../src/lib/fxscalper/store";
import type { CommandRow, ConnectionRow, DayRow, EventInput, WorkerStore } from "../fxscalper/worker/db";
import type { Bar } from "../src/lib/fxscalper/strategy";

export class MemoryStore implements WorkerStore {
  lease = { owner: null as string | null, fence: 0, expiresAt: 0 };
  control: ControlRow = {
    id: 1, mode: "live", entries_paused: false, pause_reason: null, pause_until: null, version: 1, connection_id: "conn-1", account_id: "810219",
    acc_num: "2", account_label: "GENFX · Live", account_currency: "USD", started_at: null, started_by: null, start_settings_version: 1,
    stopped_at: null, stop_reason: null, close_all_reason: null, close_all_at: null, updated_at: new Date(0).toISOString(), updated_by: null,
  };
  settings: Settings = { ...DEFAULT_SETTINGS, costs: { ...DEFAULT_SETTINGS.costs, commissionPerLotPerSide: 3, confirmed: true } };
  settingsVersion = 1;
  conn: ConnectionRow;
  trades = new Map<string, TradeRow>();
  events: EventInput[] = [];
  instruments = new Map<string, Record<string, unknown>>();
  days = new Map<string, DayRow>();
  commands: CommandRow[] = [];
  status: Record<string, unknown> | null = null;

  constructor(sealedRefresh: string, sealedAccess: string) {
    this.conn = { id: "conn-1", server: "GENFX", email_masked: "t***@x.com", enc_email: null, enc_password: null, enc_refresh: sealedRefresh, enc_access: sealedAccess, access_expires_at: new Date(Date.now() + 3_600_000).toISOString(), status: "connected", last_error: null, last_auth_at: new Date(Date.now()).toISOString() };
  }

  private leaseHeld(owner: string, fence: number) { return this.lease.owner === owner && this.lease.fence === fence && this.lease.expiresAt > Date.now(); }

  async acquireLease(owner: string, ttlMs: number) {
    if (this.lease.owner && this.lease.owner !== owner && this.lease.expiresAt > Date.now()) return { acquired: false, fence: this.lease.fence };
    if (this.lease.owner !== owner) this.lease.fence++;
    this.lease.owner = owner;
    this.lease.expiresAt = Date.now() + ttlMs;
    return { acquired: true, fence: this.lease.fence };
  }
  async extendLease(owner: string, fence: number, ttlMs: number) {
    if (!this.leaseHeld(owner, fence)) return false;
    this.lease.expiresAt = Date.now() + ttlMs;
    return true;
  }
  async releaseLease(owner: string, fence: number) { if (this.lease.owner === owner && this.lease.fence === fence) this.lease.expiresAt = Date.now(); }
  async readControl() { return { ...this.control }; }
  async updateControl(patch: Partial<ControlRow>, by: string | null, expect: number | null = null) {
    if (expect != null && expect !== this.control.version) return { ok: false, version: this.control.version, reason: "stale" };
    this.control = { ...this.control, ...patch, version: this.control.version + 1, updated_by: by };
    return { ok: true, version: this.control.version, reason: "updated" };
  }
  async readSettings() { return { settings: this.settings, version: this.settingsVersion, warnings: [] }; }
  async event(e: EventInput) { this.events.push(e); }
  async readConnection(id: string) { return id === this.conn.id ? { ...this.conn } : null; }
  async saveConnection(_id: string, patch: Partial<ConnectionRow>) { this.conn = { ...this.conn, ...patch }; }
  async saveInstrument(row: Record<string, unknown>) { this.instruments.set(String(row.pair), row); }
  async reserveTrade(inp: { owner: string; fence: number; controlVersion: number; maxLive: number; maxRisk: number; row: Record<string, unknown> }) {
    if (!this.leaseHeld(inp.owner, inp.fence)) return { id: null, reason: "stale lease" };
    const c = this.control;
    if (c.mode !== "live" || c.entries_paused || c.close_all_reason || c.version !== inp.controlVersion) return { id: null, reason: "the bot was stopped, paused, closing all or changed after this decision" };
    const all = [...this.trades.values()];
    if (all.some((t) => t.signal_key === inp.row.signal_key)) return { id: null, reason: "this signal candle already has an entry intent" };
    const live = all.filter((t) => (LIVE_STATES as readonly string[]).includes(t.state));
    if (live.length >= inp.maxLive) return { id: null, reason: "max live" };
    if (live.reduce((a, t) => a + Number(t.reserved_risk), 0) + Number(inp.row.reserved_risk) > inp.maxRisk) return { id: null, reason: "risk cap" };
    if (live.some((t) => t.pair === inp.row.pair)) return { id: null, reason: "this pair already has a bot trade in flight or open" };
    const id = randomUUID();
    const r = inp.row as Record<string, unknown>;
    const now = new Date(Date.now()).toISOString();
    this.trades.set(id, {
      id, signal_key: String(r.signal_key), tag: String(r.tag), fence: inp.fence, control_version: inp.controlVersion, settings_version: Number(r.settings_version),
      account_id: String(r.account_id), acc_num: String(r.acc_num), pair: String(r.pair), broker_symbol: String(r.broker_symbol), tradable_instrument_id: String(r.tradable_instrument_id),
      side: r.side as "buy" | "sell", state: "reserved", candle_t: String(r.candle_t), signal: r.signal as Record<string, unknown>, plan: r.plan as Record<string, unknown>,
      qty: Number(r.qty), planned_entry: Number(r.planned_entry), planned_stop: Number(r.planned_stop), planned_target: Number(r.planned_target), stop_pips: Number(r.stop_pips),
      reserved_risk: Number(r.reserved_risk), order_id: null, position_id: null, sent_at: null, ack_at: null, ack_latency_ms: null, filled_qty: null, fill_price: null, filled_at: null,
      stop_price: Number(r.planned_stop), target_price: Number(r.planned_target), protection: "pending", protection_verified_at: null, time_exit_due_at: null,
      close_requested_at: null, close_reason: null, exit_price: null, closed_at: null, gross_pnl: null, commission: null, other_charges: null, net_pnl: null, pnl_final: false,
      conversion: null, closed_lots: null, eligible_lots: null, error: null, notes: [], broker: {}, created_at: now, updated_at: now,
    });
    return { id, reason: "reserved" };
  }
  async updateTrade(owner: string, fence: number, id: string, from: string[] | null, patch: Partial<TradeRow>) {
    if (!this.leaseHeld(owner, fence)) return false;
    const t = this.trades.get(id);
    if (!t || (from && !from.includes(t.state))) return false;
    const next = { ...t, ...patch, updated_at: new Date(Date.now()).toISOString() };
    if ((LIVE_STATES as readonly string[]).includes(next.state) && [...this.trades.values()].some((x) => x.id !== id && x.pair === next.pair && (LIVE_STATES as readonly string[]).includes(x.state))) {
      throw new Error("duplicate key value violates unique constraint fx_scalper_trades_one_live_per_pair");
    }
    this.trades.set(id, next);
    return true;
  }
  async liveTrades() { return [...this.trades.values()].filter((t) => (LIVE_STATES as readonly string[]).includes(t.state)).map((t) => ({ ...t })); }
  async tradeById(id: string) { const t = this.trades.get(id); return t ? { ...t } : null; }
  async tradeByTag(tag: string) { const t = [...this.trades.values()].find((x) => x.tag === tag); return t ? { ...t } : null; }
  async recentClosed(limit: number) { return [...this.trades.values()].filter((t) => t.state === "closed").sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at))).slice(0, limit); }
  async closedSince(iso: string) { return [...this.trades.values()].filter((t) => t.state === "closed" && String(t.closed_at) >= iso); }
  async recentFills(limit: number) { return [...this.trades.values()].filter((t) => t.fill_price != null).slice(0, limit); }
  async countTodaysTrades() { return [...this.trades.values()].filter((t) => t.order_id).length; }
  async readDay(key: string) { return this.days.get(key) ?? null; }
  async startDay(row: DayRow) { if (!this.days.has(row.day)) this.days.set(row.day, row); return this.days.get(row.day)!; }
  async markDayLimit(key: string, at: string) { const d = this.days.get(key); if (d && !d.limit_hit_at) this.days.set(key, { ...d, limit_hit_at: at }); }
  async writeStatus(_w: string, snapshot: Record<string, unknown>) { this.status = snapshot; }
  private takeable(c: CommandRow, fence: number) { return c.status === "pending" || (c.status === "running" && (c.claimed_fence == null || c.claimed_fence < fence)); }
  async pendingCommands(fence: number) { return this.commands.filter((c) => this.takeable(c, fence)); }
  async claimCommand(id: string, fence: number) { const c = this.commands.find((x) => x.id === id && this.takeable(x, fence)); if (!c) return false; c.status = "running"; c.claimed_fence = fence; return true; }
  async finishCommand(id: string, ok: boolean) { const c = this.commands.find((x) => x.id === id); if (c) c.status = ok ? "done" : "failed"; }
  async paidIntoAccount() { return 0; }
}

// ---- The simulated broker ------------------------------------------------------------------------

type SimPosition = { id: string; tradableInstrumentId: string; routeId: string; side: "buy" | "sell"; qty: number; avgPrice: number; stopLossId: string | null; takeProfitId: string | null; openDate: number; unrealizedPl: number; strategyId: string };
type SimOrder = { id: string; tradableInstrumentId: string; routeId: string; qty: number; side: "buy" | "sell"; type: string; status: string; filledQty: number; avgPrice: number | null; price: number | null; stopPrice: number | null; validity: string; createdDate: number; lastModified: number; isOpen: boolean; positionId: string | null; stopLoss: number | null; takeProfit: number | null; strategyId: string | null };
type SimExec = { id: string; price: number; side: "buy" | "sell"; createdDate: number; qty: number; orderId: string; positionId: string; tradableInstrumentId: string };

const POS_COLS = ["id", "tradableInstrumentId", "routeId", "side", "qty", "avgPrice", "stopLossId", "takeProfitId", "openDate", "unrealizedPl", "strategyId"];
const ORD_COLS = ["id", "tradableInstrumentId", "routeId", "qty", "side", "type", "status", "filledQty", "avgPrice", "price", "stopPrice", "validity", "expireDate", "createdDate", "lastModified", "isOpen", "positionId", "stopLoss", "stopLossType", "takeProfit", "takeProfitType", "strategyId"];
const EXEC_COLS = ["id", "price", "side", "createdDate", "qty", "orderId", "positionId", "tradableInstrumentId"];
const STATE_COLS = ["balance", "projectedBalance", "availableFunds", "initialMarginReq", "maintMarginReq", "todayNet", "todayFees", "openGrossPnL", "openNetPnL", "positionsCount"];

export type PlaceMode = "fill" | "timeout_filled" | "timeout_lost" | "reject" | "fill_no_brackets" | "fill_no_tp";

export class SimBroker {
  seq = 1000;
  quotes = new Map<string, { bid: number; ask: number }>();
  bars = new Map<string, Bar[]>();
  positions: SimPosition[] = [];
  orders: SimOrder[] = [];        // working (SL/TP and anything resting)
  history: SimOrder[] = [];       // final
  execs: SimExec[] = [];
  balance = 100_000;
  placeMode: PlaceMode = "fill";
  refuseModify = false;
  /** Refuses any change that sets a take-profit price (a removal, takeProfit: null, is accepted). */
  refuseTpChange = false;
  /** The positions endpoint answers 503 (an outage of that one route). */
  failPositions = false;
  fillSlipPips = 0;
  calls: Array<{ method: string; path: string; body: unknown }> = [];
  instruments = [
    { tradableInstrumentId: "1", name: "EURUSD", type: "FOREX", barSource: "BID", routes: [{ id: "10", type: "TRADE" }, { id: "11", type: "INFO" }] },
    { tradableInstrumentId: "2", name: "USDJPY", type: "FOREX", barSource: "BID", routes: [{ id: "20", type: "TRADE" }, { id: "21", type: "INFO" }] },
  ];
  details: Record<string, Record<string, unknown>> = {
    "1": { lotSize: 100000, lotStep: 0.01, minLot: 0.01, maxLot: 100, tickSize: [{ leftRangeLimit: null, tickSize: 0.00001 }], barSource: "BID", quotingCurrency: "USD", leverage: "500.00", symbolStatus: "FULLY_OPEN" },
    "2": { lotSize: 100000, lotStep: 0.01, minLot: 0.01, maxLot: 100, tickSize: [{ leftRangeLimit: null, tickSize: 0.001 }], barSource: "BID", quotingCurrency: "JPY", leverage: "500.00", symbolStatus: "FULLY_OPEN" },
  };

  private id() { return String(++this.seq); }
  /** A position's open P&L in the account currency (USD) at the current quote, as the broker reports it. */
  private openPl(p: SimPosition): number {
    const q = this.quotes.get(p.tradableInstrumentId);
    if (!q) return p.unrealizedPl;
    const pl = (p.side === "buy" ? q.bid - p.avgPrice : p.avgPrice - q.ask) * p.qty * 100000;
    return +(p.tradableInstrumentId === "2" ? pl / q.bid : pl).toFixed(2);
  }
  private pip(instr: string) { return instr === "2" ? 0.01 : 0.0001; }

  /** The broker's stop or target fills: the position is closed by that order. */
  hit(positionId: string, which: "sl" | "tp") {
    const p = this.positions.find((x) => x.id === positionId);
    if (!p) return;
    const oid = which === "sl" ? p.stopLossId : p.takeProfitId;
    const o = this.orders.find((x) => x.id === oid);
    const price = which === "sl" ? (o?.stopPrice as number) : (o?.price as number);
    this.closeAt(p, price, oid ?? this.id());
  }

  private closeAt(p: SimPosition, price: number, orderId: string) {
    const side = p.side === "buy" ? "sell" : "buy";
    this.execs.push({ id: this.id(), price, side, createdDate: Date.now(), qty: p.qty, orderId, positionId: p.id, tradableInstrumentId: p.tradableInstrumentId });
    this.history.push({ id: orderId, tradableInstrumentId: p.tradableInstrumentId, routeId: p.routeId, qty: p.qty, side, type: "market", status: "Filled", filledQty: p.qty, avgPrice: price, price: null, stopPrice: null, validity: "IOC", createdDate: Date.now(), lastModified: Date.now(), isOpen: false, positionId: p.id, stopLoss: null, takeProfit: null, strategyId: null });
    this.orders = this.orders.filter((o) => o.positionId !== p.id);
    this.positions = this.positions.filter((x) => x.id !== p.id);
    const pnl = (p.side === "buy" ? price - p.avgPrice : p.avgPrice - price) * p.qty * 100000;
    this.balance += pnl;
  }

  handle(method: string, url: string, body: unknown): { status: number; body?: unknown; text?: string; throws?: string } {
    const u = new URL(url);
    const path = u.pathname.replace("/backend-api", "");
    this.calls.push({ method, path: `${path}${u.search}`, body });
    const ok = (d: unknown) => ({ status: 200, body: { s: "ok", d } });
    if (path === "/auth/jwt/refresh") return { status: 201, body: { accessToken: "acc2", refreshToken: "ref2", expireDate: new Date(Date.now() + 3_600_000).toISOString() } };
    if (path === "/auth/jwt/all-accounts") return { status: 200, body: { accounts: [{ id: "810219", accNum: "2", name: "Live", currency: "USD", status: "ACTIVE", aaccountBalance: this.balance }] } };
    if (path === "/trade/config") {
      const lim = ["GET_ACCOUNTS", "GET_EXECUTIONS", "GET_INSTRUMENTS", "GET_ORDERS", "GET_ORDERS_HISTORY", "GET_POSITIONS", "GET_ACCOUNTS_STATE", "GET_INSTRUMENT_DETAILS", "PLACE_ORDER", "MODIFY_ORDER", "MODIFY_POSITION", "QUOTES", "QUOTES_HISTORY"].map((t) => ({ rateLimitType: t, measure: "SECONDS", intervalNum: 1, limit: 100 }));
      const cols = (ids: string[]) => ({ columns: ids.map((id) => ({ id })) });
      return ok({ rateLimits: lim, limits: [{ limitType: "QUOTES_HISTORY_BARS", limit: 20000 }], positionsConfig: cols(POS_COLS), ordersConfig: cols(ORD_COLS), ordersHistoryConfig: cols(ORD_COLS), filledOrdersConfig: cols(EXEC_COLS), accountDetailsConfig: cols(STATE_COLS) });
    }
    if (path === "/trade/accounts") return ok({ accounts: [{ id: "810219", accNum: "2", status: "ACTIVE", type: "LIVE", currency: "USD", riskRules: {}, tradingRules: { supportBrackets: true } }] });
    if (path === "/trade/accounts/810219/instruments") return ok({ instruments: this.instruments });
    let m = path.match(/^\/trade\/instruments\/(\w+)$/);
    if (m) return ok(this.details[m[1]] ?? {});
    if (path === "/trade/quotes") {
      const q = this.quotes.get(u.searchParams.get("tradableInstrumentId") ?? "");
      return q ? ok({ ap: q.ask, bp: q.bid, as: 1e6, bs: 1e6 }) : { status: 200, body: { s: "error", errmsg: "no quote" } };
    }
    if (path === "/trade/history") {
      const id = u.searchParams.get("tradableInstrumentId") ?? "";
      const from = Number(u.searchParams.get("from")), to = Number(u.searchParams.get("to"));
      const bars = (this.bars.get(id) ?? []).filter((b) => b.t >= from && b.t <= to);
      return bars.length ? ok({ barDetails: bars }) : { status: 200, body: { s: "no_data" } };
    }
    if (path === "/trade/accounts/810219/state") {
      const open = this.positions.reduce((a, p) => a + this.openPl(p), 0);
      const vals: Record<string, number> = { balance: this.balance, projectedBalance: this.balance + open, availableFunds: this.balance * 0.9, initialMarginReq: 0, maintMarginReq: 0, todayNet: 0, todayFees: 0, openGrossPnL: open, openNetPnL: open, positionsCount: this.positions.length };
      return ok({ accountDetailsData: STATE_COLS.map((c) => vals[c]) });
    }
    if (path === "/trade/accounts/810219/positions" && method === "GET" && this.failPositions) return { status: 503, text: "unavailable" };
    if (path === "/trade/accounts/810219/positions" && method === "GET") return ok({ positions: this.positions.map((p) => { const live = { ...p, unrealizedPl: this.openPl(p) }; return POS_COLS.map((c) => (live as unknown as Record<string, unknown>)[c]); }) });
    if (path === "/trade/accounts/810219/orders" && method === "GET") return ok({ orders: this.orders.map((o) => ORD_COLS.map((c) => (o as unknown as Record<string, unknown>)[c] ?? null)) });
    if (path === "/trade/accounts/810219/ordersHistory") return ok({ ordersHistory: this.history.map((o) => ORD_COLS.map((c) => (o as unknown as Record<string, unknown>)[c] ?? null)), hasMore: false });
    if (path === "/trade/accounts/810219/executions") return ok({ executions: this.execs.map((e) => EXEC_COLS.map((c) => (e as unknown as Record<string, unknown>)[c])) });
    if (path === "/trade/accounts/810219/orders" && method === "POST") {
      const b = body as { tradableInstrumentId: string; routeId: string; side: "buy" | "sell"; qty: number; stopLoss: number; takeProfit: number; strategyId: string };
      if (this.placeMode === "reject") return { status: 200, body: { s: "error", errmsg: "Market closed" } };
      if (this.placeMode === "timeout_lost") return { status: 0, throws: "abort" };
      const q = this.quotes.get(b.tradableInstrumentId)!;
      const slip = this.fillSlipPips * this.pip(b.tradableInstrumentId) * (b.side === "buy" ? 1 : -1);
      const fill = +((b.side === "buy" ? q.ask : q.bid) + slip).toFixed(this.pip(b.tradableInstrumentId) === 0.01 ? 3 : 5);
      const orderId = this.id();
      const posId = this.id();
      const brackets = this.placeMode !== "fill_no_brackets";
      const withTp = brackets && this.placeMode !== "fill_no_tp";
      const slId = brackets ? this.id() : null, tpId = withTp ? this.id() : null;
      this.positions.push({ id: posId, tradableInstrumentId: b.tradableInstrumentId, routeId: b.routeId, side: b.side, qty: b.qty, avgPrice: fill, stopLossId: slId, takeProfitId: tpId, openDate: Date.now(), unrealizedPl: 0, strategyId: b.strategyId });
      this.history.push({ id: orderId, tradableInstrumentId: b.tradableInstrumentId, routeId: b.routeId, qty: b.qty, side: b.side, type: "market", status: "Filled", filledQty: b.qty, avgPrice: fill, price: null, stopPrice: null, validity: "IOC", createdDate: Date.now(), lastModified: Date.now(), isOpen: false, positionId: posId, stopLoss: b.stopLoss, takeProfit: b.takeProfit, strategyId: b.strategyId });
      this.execs.push({ id: this.id(), price: fill, side: b.side, createdDate: Date.now(), qty: b.qty, orderId, positionId: posId, tradableInstrumentId: b.tradableInstrumentId });
      const exit: "buy" | "sell" = b.side === "buy" ? "sell" : "buy";
      if (brackets) {
        this.orders.push({ id: slId!, tradableInstrumentId: b.tradableInstrumentId, routeId: b.routeId, qty: b.qty, side: exit, type: "stop", status: "New", filledQty: 0, avgPrice: null, price: null, stopPrice: b.stopLoss, validity: "GTC", createdDate: Date.now(), lastModified: Date.now(), isOpen: true, positionId: posId, stopLoss: null, takeProfit: null, strategyId: b.strategyId });
        if (withTp) this.orders.push({ id: tpId!, tradableInstrumentId: b.tradableInstrumentId, routeId: b.routeId, qty: b.qty, side: exit, type: "limit", status: "New", filledQty: 0, avgPrice: null, price: b.takeProfit, stopPrice: null, validity: "GTC", createdDate: Date.now(), lastModified: Date.now(), isOpen: true, positionId: posId, stopLoss: null, takeProfit: null, strategyId: b.strategyId });
      }
      if (this.placeMode === "timeout_filled") return { status: 0, throws: "abort" };
      return ok({ orderId });
    }
    m = path.match(/^\/trade\/positions\/(\w+)$/);
    if (m && method === "PATCH") {
      if (this.refuseModify) return { status: 200, body: { s: "error", errmsg: "Invalid stop" } };
      if (this.refuseTpChange && typeof (body as { takeProfit?: unknown }).takeProfit === "number") return { status: 200, body: { s: "error", errmsg: "Invalid take profit" } };
      if (this.placeMode === "fill_no_tp") {
        // This broker keeps the stop but will not take a target on the position.
        const p0 = this.positions.find((x) => x.id === m![1]);
        const b0 = body as { stopLoss?: number };
        for (const o of this.orders.filter((x) => x.positionId === p0?.id && x.type === "stop")) if (b0.stopLoss != null) o.stopPrice = b0.stopLoss;
        return { status: 200, body: { s: "error", errmsg: "Take profit not supported" } };
      }
      const p = this.positions.find((x) => x.id === m![1]);
      if (!p) return { status: 200, body: { s: "error", errmsg: "Position not found" } };
      const b = body as { stopLoss?: number | null; takeProfit?: number | null };
      for (const o of this.orders.filter((x) => x.positionId === p.id)) {
        if (o.type === "stop" && b.stopLoss != null) o.stopPrice = b.stopLoss;
        if (o.type === "limit" && b.takeProfit != null) o.price = b.takeProfit;
      }
      if (b.takeProfit === null) {
        // Removing the target: its order is cancelled.
        this.orders = this.orders.filter((o) => !(o.positionId === p.id && o.type === "limit"));
        p.takeProfitId = null;
      }
      return ok({});
    }
    if (m && method === "DELETE") {
      const p = this.positions.find((x) => x.id === m![1]);
      if (!p) return { status: 200, body: { s: "error", errmsg: "Position not found" } };
      const q = this.quotes.get(p.tradableInstrumentId)!;
      this.closeAt(p, p.side === "buy" ? q.bid : q.ask, this.id());
      return ok({});
    }
    if (path === "/trade/accounts/810219/positions" && method === "DELETE") {
      for (const p of [...this.positions]) { const q = this.quotes.get(p.tradableInstrumentId)!; this.closeAt(p, p.side === "buy" ? q.bid : q.ask, this.id()); }
      return ok({});
    }
    return { status: 404, text: "not found" };
  }

  fetch(): typeof fetch {
    return (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const r = this.handle(String(init.method ?? "GET"), url, body);
      if (r.throws) throw Object.assign(new Error("timed out"), { name: "AbortError" });
      const text = r.text ?? JSON.stringify(r.body ?? null);
      return { status: r.status, text: async () => text, headers: { get: () => null } } as unknown as Response;
    }) as unknown as typeof fetch;
  }
}
