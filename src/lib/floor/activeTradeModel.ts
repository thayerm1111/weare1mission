import { createHash } from "node:crypto";
import { field, columnMap, protectiveStop } from "@/lib/flow/brokerEvidence";
import { INSTRUMENTS } from "@/lib/flow/instruments";
import { contractKey } from "@/lib/flow/sizing";
import { can, type AccountRow, type PermissionKey } from "@/lib/flow/permissions";
import type { TLInstrumentSpec } from "../../../command-center/adapters/tradelocker";
import { ACTIVE_TRADE_FRESH_MS, type ActiveTrade, type ActiveTradeScope, type ActiveTradeActionRequest, type ActiveTradePlan } from "./activeTradeTypes";

export type BrokerPosition = {
  id: string; instrumentId: string; symbol: string; side: "buy" | "sell"; qty: number;
  entry: number | null; stop: number | null; target: number | null; stopKnown: boolean; unrealizedPnl?: number;
};
export const positive = (value: unknown): number | null => {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
const id = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const has = (row: unknown, cols: Record<string, number> | undefined, names: string[]): boolean => names.some((key) =>
  Array.isArray(row) ? cols?.[key] != null && cols[key] < row.length : !!row && typeof row === "object" && Object.prototype.hasOwnProperty.call(row, key));
const rawField = (row: unknown, cols: Record<string, number> | undefined, keys: string[]): unknown => {
  const key = keys.find((name) => has(row, cols, [name]));
  return key == null ? undefined : Array.isArray(row) ? row[cols![key]] : (row as Record<string, unknown>)[key];
};

/** A malformed broker row makes the read unavailable, never a fabricated empty account. */
export function parseOpenPositions(rows: unknown[], config: unknown, accountId: string, orders: unknown[] | null = null): BrokerPosition[] {
  if (!Array.isArray(rows) || rows.length > 500) throw new Error("positions_unreadable");
  const cols = columnMap(config, "positionsConfig"), oc = columnMap(config, "ordersConfig");
  const seen = new Set<string>();
  return rows.map((row) => {
    const f = (names: string[]) => field(row, cols, names);
    const pid = id(f(["id", "positionId", "positionID"]));
    const instrumentId = id(f(["tradableInstrumentId", "instrumentId"]));
    const side = String(f(["side"]) ?? "").toLowerCase();
    const qty = positive(f(["qty", "quantity", "volume", "size"]));
    const statedAccount = id(f(["accountId", "accountID", "account_id"]));
    if (!pid || pid === "0" || !instrumentId || !qty || !["buy", "sell"].includes(side) || seen.has(pid)
      || statedAccount && statedAccount !== accountId) throw new Error("positions_unreadable");
    seen.add(pid);
    const slKeys = ["stopLoss", "stopLossPrice", "sl"];
    const stopId = id(f(["stopLossId"]));
    const linked = stopId !== "" && stopId !== "0";
    const direct = positive(f(slKeys));
    const linkedStop = orders ? protectiveStop(orders, oc, pid, linked ? stopId : undefined) : null;
    const stops = [direct, linkedStop].filter((v): v is number => v != null);
    const stop = stops.length ? (side === "buy" ? Math.max(...stops) : Math.min(...stops)) : null;
    const rawStop = rawField(row, cols, slKeys), rawStopId = rawField(row, cols, ["stopLossId"]);
    const explicitEmpty = (value: unknown) => value === null || value === "" || value === 0 || value === "0";
    const stopKnown = linked ? linkedStop != null : direct != null || explicitEmpty(rawStop) || rawStop === undefined && explicitEmpty(rawStopId);
    let target = positive(f(["takeProfit", "takeProfitPrice", "tp"]));
    const tpId = id(f(["takeProfitId"]));
    if (!target && tpId && tpId !== "0" && orders) {
      const matching = orders.filter((order) => {
        const read = (names: string[]) => field(order, oc, names);
        const linkedPosition = id(read(["positionId", "positionID", "posId"]));
        const orderType = id(read(["type", "orderType"])).toLowerCase().replace(/[ _-]/g, "");
        const status = id(read(["status", "orderStatus"])).toLowerCase().replace(/[ _-]/g, "");
        return id(read(["id", "orderId"])) === tpId && (!linkedPosition || linkedPosition === "0" || linkedPosition === pid)
          && ["limit", "takeprofit"].includes(orderType) && ["new", "working", "open", "pending", "accepted", "partiallyfilled"].includes(status);
      });
      if (matching.length === 1) target = positive(field(matching[0], oc, ["price", "limitPrice"]));
    }
    const rawPnl = f(["unrealizedPl", "unrealizedPnl", "unrealizedPnL", "upl"]);
    const pnl = typeof rawPnl === "number" || typeof rawPnl === "string" && rawPnl.trim() ? Number(rawPnl) : NaN;
    return { id: pid, instrumentId, symbol: id(f(["symbol", "name"])), side: side as "buy" | "sell", qty,
      entry: positive(f(["avgPrice", "openPrice", "entryPrice", "price"])), stop, target, stopKnown,
      ...(Number.isFinite(pnl) ? { unrealizedPnl: pnl } : {}) };
  });
}

/** Known product conventions only. An unfamiliar symbol never inherits gold's pip size. */
export function activePipSize(symbol: string): number | null {
  const withoutSuffix = symbol.replace(/[._-](?:r|m|pro|raw|micro|mini|ecn|cash|std)$/i, "");
  for (const key of [contractKey(symbol), contractKey(withoutSuffix)]) {
    if (INSTRUMENTS[key]) return INSTRUMENTS[key].pipSize;
    if (/^(USD|EUR|GBP|AUD|NZD|CAD|CHF|JPY)(USD|EUR|GBP|AUD|NZD|CAD|CHF|JPY)$/.test(key)) return key.endsWith("JPY") ? 0.01 : 0.0001;
  }
  return null;
}
export function positionRevision(scope: ActiveTradeScope, position: BrokerPosition): string {
  return createHash("sha256").update(JSON.stringify([scope.environment, scope.accountId, position.id, position.instrumentId, position.side, position.qty, position.entry])).digest("hex").slice(0, 32);
}
export function validScope(input: unknown): input is ActiveTradeScope {
  const o = input as ActiveTradeScope | null;
  return !!o && ["live", "demo"].includes(o.environment) && typeof o.accountId === "string" && /^[\w.-]{1,100}$/.test(o.accountId);
}
export function parseTradeAction(input: unknown): ActiveTradeActionRequest | null {
  if (!validScope(input)) return null;
  const o = input as ActiveTradeActionRequest;
  if (o.confirm !== true || !["close", "partial", "breakeven"].includes(o.action) || typeof o.positionId !== "string"
    || !/^[\w.-]{1,100}$/.test(o.positionId) || typeof o.revision !== "string" || !/^[a-f0-9]{32}$/.test(o.revision)
    || o.action === "partial" && o.fraction !== 0.25 && o.fraction !== 0.5) return null;
  return { accountId: o.accountId, environment: o.environment, positionId: o.positionId, action: o.action,
    ...(o.action === "partial" ? { fraction: o.fraction } : {}), revision: o.revision, confirm: true };
}
export function activeQuote(quote: { bid: number | null; ask: number | null; raw?: unknown } | null, receivedAt: number, now = receivedAt): ActiveTrade["quote"] {
  const unavailable: ActiveTrade["quote"] = { bid: null, ask: null, at: null, state: "unavailable" };
  if (!quote || !positive(quote.bid) || !positive(quote.ask) || quote.bid! > quote.ask!) return unavailable;
  const root = quote.raw as Record<string, unknown> | null;
  const raw = (root?.d ?? root) as Record<string, unknown> | null;
  const stamp = raw?.timestamp ?? raw?.time ?? raw?.ts;
  let at = receivedAt;
  if (stamp != null) {
    const numeric = typeof stamp === "number" ? stamp : typeof stamp === "string" && /^\d+(\.\d+)?$/.test(stamp) ? Number(stamp) : NaN;
    at = Number.isFinite(numeric) ? numeric < 1e12 ? numeric * 1000 : numeric : typeof stamp === "string" ? Date.parse(stamp) : NaN;
  }
  if (!Number.isFinite(at) || now - at > ACTIVE_TRADE_FRESH_MS || at - now > 5000) return unavailable;
  return { bid: quote.bid, ask: quote.ask, at: new Date(at).toISOString(), state: "live" };
}
export const refuse = (reason: string): ActiveTradePlan => ({ allowed: false, reason });
export const quoteIsFresh = (quote: ActiveTrade["quote"], now = Date.now()): boolean => {
  const age = quote.at ? now - Date.parse(quote.at) : NaN;
  return quote.state === "live" && Number.isFinite(age) && age >= -5000 && age <= ACTIVE_TRADE_FRESH_MS;
};
export function partialQuantity(qty: number, fraction: 0.25 | 0.5, spec: TLInstrumentSpec | null): ActiveTradePlan {
  const step = positive(spec?.lotStep), minimum = positive(spec?.minLot);
  if (!step || !minimum) return refuse("The broker’s lot increments are unavailable.");
  const units = qty / step;
  if (Math.abs(units - Math.round(units)) > 1e-6) return refuse("The broker quantity needs to be refreshed.");
  const close = Number((Math.floor((qty * fraction + step * 1e-8) / step) * step).toFixed(10));
  const remaining = Number((qty - close).toFixed(10));
  if (close + 1e-10 < minimum || remaining + 1e-10 < minimum || close <= 0 || close >= qty) return refuse("This trade is too small to split at the broker’s minimum lot.");
  return { allowed: true, reason: null, qty: close };
}
export function breakEvenPosition(position: BrokerPosition, symbol: string, quote: ActiveTrade["quote"], spec: TLInstrumentSpec | null): ActiveTradePlan {
  if (!position.entry || !position.stopKnown) return refuse("The broker’s entry and current stop must be verified first.");
  const pip = activePipSize(symbol), tick = positive(spec?.tickSize) ?? (spec?.pricePrecision != null && Number.isInteger(spec.pricePrecision) && spec.pricePrecision >= 0 && spec.pricePrecision <= 10 ? 10 ** -spec.pricePrecision : null);
  if (!pip) return refuse("The pip size for this symbol is unavailable.");
  if (!tick) return refuse("The broker’s price increments are unavailable.");
  const buy = position.side === "buy", desired = position.entry + (buy ? 1 : -1) * 5 * pip;
  // Round toward profit so an increment cannot silently erase the five-pip cushion.
  const stop = Number(((buy ? Math.ceil(desired / tick - 1e-8) : Math.floor(desired / tick + 1e-8)) * tick).toFixed(10));
  if (!(stop > 0)) return refuse("A valid break-even price is unavailable.");
  if (position.stop != null && (buy ? position.stop >= stop - tick * 1e-6 : position.stop <= stop + tick * 1e-6)) return refuse("The stop is already at break-even or better.");
  const price = quoteIsFresh(quote) ? buy ? quote.bid : quote.ask : null;
  if (price == null) return refuse("A fresh broker quote is required for break-even.");
  if (buy ? price < stop + Math.max(5 * pip, tick) : price > stop - Math.max(5 * pip, tick)) return refuse("Needs at least 10 pips of profit before break-even.");
  return { allowed: true, reason: null, stop };
}
export function tradeView(scope: ActiveTradeScope, position: BrokerPosition, symbol: string, quote: ActiveTrade["quote"], spec: TLInstrumentSpec | null, accounts: AccountRow[], partial: "available" | "reserved" | "unavailable"): ActiveTrade {
  if (!quoteIsFresh(quote)) quote = activeQuote(null, Date.now());
  const permission = (key: PermissionKey): ActiveTradePlan | null => {
    if (!accounts.length) return refuse("The account’s permissions could not be verified.");
    const blocked = accounts.map((account) => can(account, key)).find((verdict) => !verdict.allowed);
    return blocked ? refuse(blocked.reason) : null;
  };
  const pip = activePipSize(symbol), price = position.side === "buy" ? quote.bid : quote.ask;
  const pips = quote.state === "live" && pip && price != null && position.entry != null ? (price - position.entry) * (position.side === "buy" ? 1 : -1) / pip : null;
  const partialBlocked = permission("allow_partial") ?? (partial !== "available" ? refuse(partial === "reserved" ? "A partial has already been requested for this trade." : "The previous partial status could not be verified.") : null)
    ?? (quote.state !== "live" ? refuse("A fresh broker quote is required to record this partial accurately.") : null);
  return { id: position.id, symbol, side: position.side, qty: position.qty, entry: position.entry, stop: position.stopKnown ? position.stop : null, target: position.target,
    quote, pips: pips == null ? null : Number(pips.toFixed(2)), revision: positionRevision(scope, position), actions: {
      close: permission("allow_close") ?? { allowed: true, reason: null, qty: position.qty },
      partial: ([0.25, 0.5] as const).map((fraction) => ({ ...(partialBlocked ?? partialQuantity(position.qty, fraction, spec)), fraction })),
      breakeven: permission("allow_break_even") ?? permission("allow_stop_move") ?? breakEvenPosition(position, symbol, quote, spec),
    } };
}
