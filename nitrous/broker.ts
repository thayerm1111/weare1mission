import type { InstrumentSpec, Side } from "../rapid/core/types";
import type { PortContext } from "../rapid/exec/tradelockerPort";
import { getAccountState, getConfig, listPositions } from "../rapid/broker/tradelocker";
import { brokerError, columnMap, field, readCollection, tlFetch } from "../rapid/broker/http";

type ReadResult<T> = { ok: true; data: T } | { ok: false; error: string };
type History = { rows: unknown[]; hasMore: boolean };
/** Injectable reads only: this module has no order submission or account mutation capability. */
export type NitrousBrokerReads = {
  config(ctx: PortContext): Promise<ReadResult<unknown>>;
  state(ctx: PortContext): Promise<ReadResult<unknown>>;
  accounts(ctx: PortContext): Promise<ReadResult<unknown[]>>;
  positions(ctx: PortContext): Promise<ReadResult<unknown[]>>;
  history(ctx: PortContext, from: number, instrumentId: string): Promise<ReadResult<History>>;
  now(): number;
};

const object = (v: unknown): Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const unwrap = (v: unknown) => object(v).d ?? v;
const str = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : null;
/** In particular null, blank strings, booleans and arrays are not zero balances. */
const number = (v: unknown): number | null => {
  if (typeof v !== "number" && (typeof v !== "string" || !v.trim())) return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
};
const positive = (v: unknown): number | null => { const n = number(v); return n != null && n > 0 ? n : null; };
const currency = (v: unknown): string | null => typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : null;
const error = (message: string): { ok: false; error: string } => ({ ok: false, error: message });

const defaultReads: NitrousBrokerReads = {
  config: (c) => getConfig(c.env, c.token, c.accNum),
  state: (c) => getAccountState(c.env, c.token, c.accNum, c.accountId),
  positions: (c) => listPositions(c.env, c.token, c.accNum, c.accountId),
  async accounts(c) {
    // Keep raw values: the legacy listAccounts parser coerces null balances to zero.
    const r = await tlFetch(c.env, "/auth/jwt/all-accounts", { accessToken: c.token, priority: "background" });
    if (r.status < 200 || r.status >= 300 || brokerError(r.json)) return error("Broker account list unavailable.");
    return readCollection(r.json, "accounts");
  },
  async history(c, from, instrumentId) {
    // The legacy history adapter drops hasMore. A truncated history cannot settle an outcome.
    const query = new URLSearchParams({ from: String(Math.floor(from)), tradableInstrumentId: instrumentId });
    const r = await tlFetch(c.env, `/trade/accounts/${encodeURIComponent(c.accountId)}/ordersHistory?${query}`, { accessToken: c.token, accNum: c.accNum, priority: "normal" });
    if (r.status < 200 || r.status >= 300 || brokerError(r.json)) return error("Broker closing history unavailable.");
    const rows = readCollection(r.json, "ordersHistory", "orders");
    if (!rows.ok) return rows;
    const more = object(unwrap(r.json)).hasMore;
    if (more !== undefined && typeof more !== "boolean") return error("Broker history completeness is unknown.");
    return { ok: true, data: { rows: rows.data, hasMore: more === true } };
  },
  now: Date.now,
};

export type AccountMetrics = { ok: true; balance: number | null; equity: number | null; freeMargin: number | null; currency: string | null } | { ok: false; error: string };

/** State array positions are always resolved by the broker's current accountDetailsConfig. */
export async function readAccountMetrics(ctx: PortContext, reads: NitrousBrokerReads = defaultReads): Promise<AccountMetrics> {
  try {
    const [config, state] = await Promise.all([reads.config(ctx), reads.state(ctx)]);
    if (!state.ok) return error("Broker account state unavailable.");
    const root = unwrap(state.data);
    const row = object(root).accountDetailsData ?? object(root).accountDetails ?? root;
    const cols = config.ok ? columnMap(config.data, "accountDetailsConfig") : {};
    if (Array.isArray(row) && !Object.keys(cols).length) return error("Broker account field mapping unavailable.");
    const pick = (keys: string[]) => {
      for (const key of keys) { const n = number(field(row, cols, [key])); if (n != null) return n; }
      return null;
    };
    let balance = pick(["balance", "cashBalance", "accountBalance"]);
    let equity = pick(["equity", "projectedBalance", "netLiquidationValue"]);
    // TradeLocker /trade/config names its available trading funds `availableFunds`.
    const freeMargin = pick(["freeMargin", "availableFunds", "freeFunds", "availableMargin"]);
    let ccy = currency(field(row, cols, ["currency", "accountCurrency"])) ?? currency(object(root).currency);
    if (balance == null || equity == null || ccy == null) {
      const accounts = await reads.accounts(ctx);
      if (accounts.ok) {
        const matching = accounts.data.filter((a) => str(object(a).id ?? object(a).accountId) === ctx.accountId && str(object(a).accNum ?? object(a).accountNum) === ctx.accNum);
        if (matching.length !== 1) return error("Broker account identity could not be confirmed.");
        const account = object(matching[0]);
        const accountCurrency = currency(account.currency ?? account.accountCurrency);
        if (ccy && accountCurrency && ccy !== accountCurrency) return error("Broker account currency is inconsistent.");
        balance ??= number(account.accountBalance ?? account.balance);
        equity ??= number(account.equity ?? account.projectedBalance);
        ccy ??= accountCurrency;
      }
    }
    // Unknown values stay null; no equity=balance or freeMargin=equity substitution.
    return { ok: true, balance, equity, freeMargin, currency: ccy };
  } catch { return error("Broker account metrics unavailable."); }
}

export type NitrousClosedPosition = {
  broker_position_id: string;
  side: Side;
  /** Confirmed opening fill, not the requested entry or a chart price. */
  entry: number;
  /** Full confirmed original filled quantity, including any partial exits. */
  original_qty: number;
  opened_at: string;
};
export type ClosedOutcome = { ok: true; exitPrice: number; closedAt: string; realisedPnl: number; source: "broker_net" | "calculated_gross"; feesVerified: boolean } | { ok: false; error: string };

const timestamp = (v: unknown): number | null => {
  if (typeof v === "string" && /[T:-]/.test(v)) { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  const n = positive(v); return n == null ? null : n < 100_000_000_000 ? n * 1000 : n;
};
const netFields = ["realizedNetPnl", "realisedNetPnl", "netRealizedPnl", "netRealisedPnl"];

export type OpeningFillLookup = {
  orderId: string | null;
  positionId: string | null;
  strategyId: string;
  side: Side;
  submittedAt: string;
};
export type OpeningFill = { ok: true; positionId: string; entry: number; qty: number; openedAt: string } | { ok: false; error: string };

/** Recover fast completed trades from exact recorded broker identities, never a strategy tag alone. */
export async function readOpeningFill(ctx: PortContext, lookup: OpeningFillLookup, spec: InstrumentSpec, reads: NitrousBrokerReads = defaultReads): Promise<OpeningFill> {
  const submittedAt = timestamp(lookup.submittedAt);
  const orderId = str(lookup.orderId);
  const positionId = str(lookup.positionId);
  if ((!orderId && !positionId) || !str(lookup.strategyId) || !["buy", "sell"].includes(lookup.side) || submittedAt == null || !str(spec.tradableInstrumentId)) return error("Opening order identity is incomplete.");
  try {
    // A small clock allowance only widens the read interval. Exact broker IDs still determine ownership.
    const [config, history] = await Promise.all([reads.config(ctx), reads.history(ctx, submittedAt - 60_000, spec.tradableInstrumentId)]);
    if (!config.ok || !history.ok || history.data.hasMore) return error("Complete broker opening history is unavailable.");
    const cols = columnMap(config.data, "ordersHistoryConfig");
    const matches = new Map<string, { positionId: string; entry: number; qty: number; openedAt: string }>();
    for (const row of history.data.rows) {
      const id = str(field(row, cols, ["id", "orderId"]));
      const pos = str(field(row, cols, ["positionId"]));
      const tag = str(field(row, cols, ["strategyId"]));
      if (orderId ? id !== orderId : pos !== positionId || tag !== lookup.strategyId) continue;
      if (!pos || (positionId && positionId !== pos) || (tag && tag !== lookup.strategyId)) return error("Broker opening identity conflicts with the recorded intent.");
      const side = str(field(row, cols, ["side"]))?.toLowerCase();
      // Position-based history contains closing rows too. Only its opening side is relevant.
      if (!orderId && side !== lookup.side) continue;
      const status = str(field(row, cols, ["status"]))?.toLowerCase();
      const qty = positive(field(row, cols, ["filledQty", "filledQuantity"]));
      const entry = positive(field(row, cols, ["avgPrice", "averageFillPrice", "filledPrice"]));
      const at = timestamp(field(row, cols, ["filledAt", "executedAt", "lastModified"]));
      const instrument = str(field(row, cols, ["tradableInstrumentId"]));
      const isOpen = field(row, cols, ["isOpen"]);
      if (!id || side !== lookup.side || !["filled", "cancelled", "canceled"].includes(status ?? "") || !qty || !entry || at == null || at < submittedAt - 60_000 || at > reads.now() + 60_000 || instrument !== spec.tradableInstrumentId || isOpen === false || isOpen === "false") return error("Terminal broker opening fill is unconfirmed.");
      const fill = { positionId: pos, entry, qty, openedAt: new Date(at).toISOString() };
      const previous = matches.get(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(fill)) return error("Broker opening history has conflicting duplicate rows.");
      matches.set(id, fill);
    }
    if (matches.size !== 1) return error("Exactly one terminal opening order could not be confirmed.");
    return { ok: true, ...[...matches.values()][0] };
  } catch { return error("Broker opening fill is unavailable; the entry remains unresolved."); }
}

/** No price touch, absent position, requested order price, or generic `profit` is a realised result. */
export async function readClosedOutcome(ctx: PortContext, position: NitrousClosedPosition, spec: InstrumentSpec, accountCurrency: string | null, reads: NitrousBrokerReads = defaultReads): Promise<ClosedOutcome> {
  const openedAt = timestamp(position.opened_at);
  if (!str(position.broker_position_id) || !["buy", "sell"].includes(position.side) || !positive(position.entry) || !positive(position.original_qty) || openedAt == null || !str(spec.tradableInstrumentId)) return error("Opening fill evidence is incomplete.");
  try {
    const [config, positions, history] = await Promise.all([reads.config(ctx), reads.positions(ctx), reads.history(ctx, openedAt, spec.tradableInstrumentId)]);
    if (!config.ok || !positions.ok || !history.ok) return error("Broker closure evidence is unavailable.");
    if (history.data.hasMore) return error("Broker history is incomplete; outcome remains unknown.");
    const positionCols = columnMap(config.data, "positionsConfig");
    for (const row of positions.data) {
      const id = str(field(row, positionCols, ["id", "positionId"]));
      if (!id) return error("Broker open-position identity is unreadable.");
      if (id === position.broker_position_id) return error("Broker position remains open.");
    }
    const cols = columnMap(config.data, "ordersHistoryConfig");
    const expectedSide = position.side === "buy" ? "sell" : "buy";
    const fills = new Map<string, { qty: number; price: number; at: number; net: number | null }>();
    const ccy = currency(accountCurrency);
    for (const row of history.data.rows) {
      const positionId = str(field(row, cols, ["positionId"]));
      // Rejected opening orders may have no position ID; they cannot become closing evidence.
      if (!positionId) continue;
      if (positionId !== position.broker_position_id) continue;
      const side = str(field(row, cols, ["side"]))?.toLowerCase();
      if (side !== "buy" && side !== "sell") return error("Broker closing side is unknown.");
      if (side !== expectedSide) continue;
      const filledQty = number(field(row, cols, ["filledQty", "filledQuantity"]));
      const status = str(field(row, cols, ["status"]))?.toLowerCase();
      if (filledQty === 0 && ["rejected", "cancelled", "canceled"].includes(status ?? "")) continue;
      if (filledQty == null || filledQty <= 0 || !["filled", "cancelled", "canceled"].includes(status ?? "")) return error("Broker executed closing quantity is unconfirmed.");
      const id = str(field(row, cols, ["id", "orderId"]));
      const instrument = str(field(row, cols, ["tradableInstrumentId"]));
      const isOpen = field(row, cols, ["isOpen"]);
      const price = positive(field(row, cols, ["avgPrice", "averageFillPrice", "filledPrice"]));
      const at = timestamp(field(row, cols, ["filledAt", "executedAt", "lastModified"]));
      if (!id || instrument !== spec.tradableInstrumentId || isOpen === true || isOpen === "true" || !price || at == null || at < openedAt || at > reads.now() + 60_000) return error("Broker closing fill evidence is incomplete or inconsistent.");
      // Explicit NET realised fields only. A generic pnl/profit field may exclude fees.
      const netCurrency = currency(field(row, cols, ["pnlCurrency", "accountCurrency", "currency"]));
      const net = netCurrency && ccy && netCurrency === ccy ? number(field(row, cols, netFields)) : null;
      const fill = { qty: filledQty, price, at, net };
      const existing = fills.get(id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(fill)) return error("Broker history has conflicting duplicate fills.");
      fills.set(id, fill);
    }
    if (!fills.size) return error("No confirmed closing fills for this broker position.");
    const rows = [...fills.values()];
    const qty = rows.reduce((sum, row) => sum + row.qty, 0);
    // Numerical epsilon only, never a lot-step allowance that could hide a partial close.
    if (Math.abs(qty - position.original_qty) > Math.max(1e-9, position.original_qty * 1e-8)) return error("Closing fills do not exactly cover the original position quantity.");
    const exitPrice = rows.reduce((sum, row) => sum + row.qty * row.price, 0) / qty;
    const closedAt = new Date(Math.max(...rows.map((row) => row.at))).toISOString();
    if (rows.every((row) => row.net != null)) return { ok: true, exitPrice, closedAt, realisedPnl: rows.reduce((sum, row) => sum + row.net!, 0), source: "broker_net", feesVerified: true };
    if (!ccy || ccy !== currency(spec.currency) || !positive(spec.contractSize)) return error("Contract or account-currency conversion is unverified; P&L remains unknown.");
    const realisedPnl = (position.side === "buy" ? 1 : -1) * (exitPrice - position.entry) * qty * spec.contractSize!;
    if (!Number.isFinite(realisedPnl)) return error("Broker fill calculation is invalid.");
    return { ok: true, exitPrice, closedAt, realisedPnl, source: "calculated_gross", feesVerified: false };
  } catch { return error("Broker outcome is unknown; closure reconciliation must retry reading."); }
}

/** Broker-spec estimate, not an order preview. No default leverage or FX conversion is permitted. */
export function marginRequirement(spec: InstrumentSpec, qty: number, price: number, accountCurrency: string | null): number | null {
  if (!positive(qty) || !positive(price) || !positive(spec.contractSize) || !currency(accountCurrency) || currency(accountCurrency) !== currency(spec.currency)) return null;
  const raw = object(unwrap(spec.raw));
  const candidates = [raw.leverage, object(raw.details).leverage].filter((v) => v !== undefined && v !== null);
  if (!candidates.length) return null;
  const values = candidates.map(positive);
  if (values.some((v) => v == null) || new Set(values).size !== 1) return null;
  const amount = qty * price * spec.contractSize! / values[0]!;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
