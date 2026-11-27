import type { InstrumentSpec, Quote, Side } from "../core/types";
import type { BrokerPort, BrokerPosition } from "./port";
import { columnMap, field, type TLEnv } from "../broker/http";
import {
  cancelOrder, closePosition, createOrder, getAccountState, getConfig, getInstrumentDetails,
  getQuote, listInstruments, listOrders, listOrdersHistory, listPositions, modifyPosition, positionForOrder,
  resolveGold, toInstrumentSpec,
} from "../broker/tradelocker";
import { applyPublishedRateLimits } from "../broker/http";

/**
 * The live TradeLocker implementation of the broker port.
 *
 * It caches only what is safe to cache: the instrument contract and the column maps, both of which
 * change on a deploy rather than on a tick. Prices, positions and protection state are always read
 * fresh, because a cached answer to "is this position protected" is worthless.
 */

export type PortContext = {
  env: TLEnv;
  token: string;
  accNum: string;
  accountId: string;
  /** The strategy's canonical symbol, used only to break an otherwise ambiguous gold match. */
  preferredSymbol?: string | null;
};

const isSessionClosed = (msg: string) => /session|market[^a-z]*(clos|halt)|not[^a-z]*open|trading[^a-z]*(clos|halt|disabl)/i.test(msg);

export class TradeLockerPort implements BrokerPort {
  private config: unknown = null;
  private cols: { positions: Record<string, number>; orders: Record<string, number>; history: Record<string, number> } | null = null;
  private cachedSpec: { spec: InstrumentSpec; missing: string[] } | null = null;

  constructor(private readonly ctx: PortContext, private readonly readProtectionOrders = false) {}

  private async ensureConfig(): Promise<void> {
    if (this.config) return;
    const c = await getConfig(this.ctx.env, this.ctx.token, this.ctx.accNum);
    if (!c.ok) throw new Error(`rapid_broker_config_unavailable: ${c.error}`);
    this.config = c.data;
    // The broker publishes its own limits. Honour them rather than a guessed constant.
    applyPublishedRateLimits(`rapid:${this.ctx.env}`, c.data);
    this.cols = {
      positions: columnMap(c.data, "positionsConfig"),
      orders: columnMap(c.data, "ordersConfig"),
      history: columnMap(c.data, "ordersHistoryConfig"),
    };
  }

  async spec(): Promise<{ ok: true; spec: InstrumentSpec; missing: string[] } | { ok: false; error: string }> {
    if (this.cachedSpec) return { ok: true, ...this.cachedSpec };
    const list = await listInstruments(this.ctx.env, this.ctx.token, this.ctx.accNum, this.ctx.accountId);
    if (!list.ok) return { ok: false, error: list.error };
    const gold = resolveGold(list.data, this.ctx.preferredSymbol ?? null);
    if (!gold.ok) return { ok: false, error: `${gold.reason}${gold.candidates.length ? `: ${gold.candidates.join(", ")}` : ""}` };
    const details = await getInstrumentDetails(this.ctx.env, this.ctx.token, this.ctx.accNum, gold.row.tradableInstrumentId, gold.row.tradeRouteId);
    if (!details.ok) return { ok: false, error: details.error };
    this.cachedSpec = toInstrumentSpec(gold.row, details.data);
    return { ok: true, ...this.cachedSpec };
  }

  async quote(): Promise<{ ok: true; quote: Quote } | { ok: false; error: string }> {
    const s = await this.spec();
    if (!s.ok) return { ok: false, error: s.error };
    // Quotes go on the INFO route; orders go on the TRADE route. Swapping them fails obscurely.
    const q = await getQuote(this.ctx.env, this.ctx.token, this.ctx.accNum, s.spec.tradableInstrumentId, s.spec.infoRouteId);
    return q.ok ? { ok: true, quote: q.data } : { ok: false, error: q.error };
  }

  async accountState() {
    const r = await getAccountState(this.ctx.env, this.ctx.token, this.ctx.accNum, this.ctx.accountId);
    if (!r.ok) return { ok: false as const, error: r.error };
    const d = r.data as Record<string, unknown>;
    const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const arr = Array.isArray(d.accountDetailsData) ? (d.accountDetailsData as unknown[]) : null;
    return {
      ok: true as const,
      equity: num(d.projectedBalance ?? d.equity ?? (arr ? arr[0] : undefined)),
      freeMargin: num(d.freeFunds ?? d.freeMargin ?? (arr ? arr[3] : undefined)),
      currency: (d.currency as string) ?? null,
    };
  }

  async submit(o: { side: Side; qty: number; stopLoss: number | null; takeProfit: number | null; strategyId: string }) {
    const s = await this.spec();
    if (!s.ok) return { ok: false as const, error: s.error, uncertain: false };
    const r = await createOrder(this.ctx.env, this.ctx.token, {
      accountId: this.ctx.accountId,
      accNum: this.ctx.accNum,
      tradableInstrumentId: s.spec.tradableInstrumentId,
      routeId: s.spec.tradeRouteId,
      side: o.side,
      qty: o.qty,
      type: "market",
      validity: "IOC",
      stopLoss: o.stopLoss,
      takeProfit: o.takeProfit,
      strategyId: o.strategyId,
    });
    if (r.ok) return { ok: true as const, orderId: r.data.orderId, positionId: r.data.positionId };
    return { ok: false as const, error: r.error, uncertain: r.uncertain === true, sessionClosed: isSessionClosed(r.error) };
  }

  async resolvePosition(orderId: string) {
    await this.ensureConfig();
    // A few short attempts: the history lags the acknowledgement by a moment, not by minutes.
    for (const delay of [0, 250, 500, 800]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const h = await listOrdersHistory(this.ctx.env, this.ctx.token, this.ctx.accNum, this.ctx.accountId);
      if (!h.ok) continue;
      const positionId = positionForOrder(h.data, this.cols!.history, orderId);
      if (!positionId) continue;
      const rows = await this.positions();
      const row = rows.ok ? rows.rows.find((p) => p.positionId === positionId) : undefined;
      return { positionId, fillPrice: row?.entry ?? null, filledQty: row?.qty ?? null };
    }
    return null;
  }

  async positions(): Promise<{ ok: true; rows: BrokerPosition[] } | { ok: false; error: string }> {
    // A config refusal is an answer ("could not read"), not a crash: prepare and the account loop
    // record it on the account and carry on to the next one.
    try { await this.ensureConfig(); } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
    const p = await listPositions(this.ctx.env, this.ctx.token, this.ctx.accNum, this.ctx.accountId);
    if (!p.ok) return { ok: false, error: p.error };
    const cols = this.cols!.positions;
    const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const linkedId = (value: unknown) => typeof value === "string" || Number.isSafeInteger(value) ? String(value) : "";
    const needsOrders = this.readProtectionOrders && p.data.some(row =>
      ["stopLossId", "takeProfitId"].some(key => /^[1-9]\d*$/.test(linkedId(field(row, cols, [key])))));
    const orders = needsOrders ? await listOrders(this.ctx.env, this.ctx.token, this.ctx.accNum, this.ctx.accountId) : null;
    const leg = (row: unknown, stop: boolean): number | null => {
      const direct = num(field(row, cols, stop ? ["stopLoss", "stopLossPrice", "sl"] : ["takeProfit", "takeProfitPrice", "tp"]));
      if (!this.readProtectionOrders || (direct != null && direct > 0)) return direct;
      const id = linkedId(field(row, cols, [stop ? "stopLossId" : "takeProfitId"]));
      if (!orders?.ok || !/^[1-9]\d*$/.test(id)) return null;
      const oc = this.cols!.orders;
      const matches = orders.data.filter(o => linkedId(field(o, oc, ["id", "orderId"])) === id);
      if (matches.length !== 1) return null;
      const get = (key: string) => field(matches[0], oc, [key]);
      const position = linkedId(get("positionId"));
      const side = String(field(row, cols, ["side"])).toLowerCase();
      const expectedSide = side === "buy" ? "sell" : side === "sell" ? "buy" : "";
      if (position && position !== "0" && position !== linkedId(field(row, cols, ["id", "positionId"]))) return null;
      if (String(get("type")).toLowerCase() !== (stop ? "stop" : "limit") ||
          String(get("side")).toLowerCase() !== expectedSide ||
          !["new", "working", "open", "pending", "accepted"].includes(String(get("status")).toLowerCase()) ||
          Number(get("qty")) !== Number(field(row, cols, ["qty", "quantity"]))) return null;
      const price = num(get(stop ? "stopPrice" : "price"));
      return price != null && price > 0 ? price : null;
    };
    const rows: BrokerPosition[] = [];
    for (const row of p.data) {
      const id = field(row, cols, ["id", "positionId"]);
      if (id == null) continue;
      const sideRaw = String(field(row, cols, ["side"]) ?? "").toLowerCase();
      const rawPnl = field(row, cols, ["unrealizedPl"]);
      const floating = typeof rawPnl === "number" || (typeof rawPnl === "string" && rawPnl.trim()) ? Number(rawPnl) : NaN;
      const stopLoss = leg(row, true), takeProfit = leg(row, false);
      const unreadable = (price: number | null, idKey: string, priceKeys: string[]) => {
        if (!this.readProtectionOrders || (price != null && price > 0)) return false;
        const link = field(row, cols, [idKey]);
        if (link != null && String(link) !== "0" && String(link) !== "") {
          // A failed read is inconclusive. A successful read that lacks a valid
          // full-size protective order must still reach the existing risk checks.
          return !orders?.ok;
        }
        return link === undefined && field(row, cols, priceKeys) === undefined;
      };
      rows.push({
        positionId: String(id),
        strategyId: (field(row, cols, ["strategyId"]) as string) ?? null,
        side: sideRaw === "buy" || sideRaw === "sell" ? (sideRaw as Side) : null,
        qty: num(field(row, cols, ["qty", "quantity"])),
        entry: num(field(row, cols, ["avgPrice", "openPrice", "price"])),
        stopLoss, takeProfit,
        ...(unreadable(stopLoss, "stopLossId", ["stopLoss", "stopLossPrice", "sl"]) ? { stopReadUnknown: true } : {}),
        ...(unreadable(takeProfit, "takeProfitId", ["takeProfit", "takeProfitPrice", "tp"]) ? { targetReadUnknown: true } : {}),
        ...(Number.isFinite(floating) ? { unrealizedPnl: floating } : {}),
      });
    }
    return { ok: true, rows };
  }

  async amend(positionId: string, mod: { stopLoss?: number | null; takeProfit?: number | null }) {
    const r = await modifyPosition(this.ctx.env, this.ctx.token, this.ctx.accNum, positionId, mod);
    return r.ok ? { ok: true as const } : { ok: false as const, error: r.error, uncertain: r.uncertain === true };
  }

  async close(positionId: string, qty?: number) {
    const r = await closePosition(this.ctx.env, this.ctx.token, this.ctx.accNum, positionId, qty);
    return r.ok ? { ok: true as const } : { ok: false as const, error: r.error, uncertain: r.uncertain === true };
  }

  async cancelOrder(orderId: string) {
    const r = await cancelOrder(this.ctx.env, this.ctx.token, this.ctx.accNum, orderId);
    return r.ok ? { ok: true as const } : { ok: false as const, error: r.error };
  }
}

