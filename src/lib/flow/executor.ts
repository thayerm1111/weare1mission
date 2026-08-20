import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeQuantity } from "@/lib/flow/instruments";
import { freshAccessToken } from "@/lib/flow/connection";
import { listInstruments, createOrder, getQuote, listOrders, listPositions, type TLInstrument } from "@/lib/flow/tradelocker";

/**
 * FLOW order placement (server-only). Places a single market order on the
 * member's connected + selected TradeLocker account. This is only ever reached
 * through /api/flow/execute, which requires the member's own authenticated
 * session and (for the test path) is triggered by an explicit member tap.
 * It never runs on its own and never loops.
 */

export type PlaceOutcome =
  | { status: "placed"; symbol: string; side: "buy" | "sell"; qty: number; orderId: string | null; positionId: string | null; environment: string; accountId: string }
  | { status: "error"; reason: string; environment?: string };

function normSym(s: string): string { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }

// Broker symbols vary (GOLD vs XAUUSD, US100 vs NAS100). Match canonical first,
// then a few common aliases, then a normalized prefix (e.g. "XAUUSD.r").
const ALIASES: Record<string, string[]> = {
  XAUUSD: ["XAUUSD", "GOLD", "XAUUSDT"],
  XAGUSD: ["XAGUSD", "SILVER"],
  NAS100: ["NAS100", "US100", "USTEC", "NASDAQ", "USTECH"],
  US30: ["US30", "DJ30", "US30USD", "DOW"],
  USOIL: ["USOIL", "WTI", "CRUDE", "OIL", "USOUSD"],
};
function matchInstrument(canonical: string, instruments: TLInstrument[]): TLInstrument | null {
  const want = normSym(canonical);
  const aliases = (ALIASES[canonical] ?? [canonical]).map(normSym);
  for (const i of instruments) {
    const bs = normSym(i.brokerSymbol || i.canonical || "");
    if (bs === want || aliases.includes(bs)) return i;
  }
  for (const i of instruments) {
    const bs = normSym(i.brokerSymbol || i.canonical || "");
    if (bs.startsWith(want) || aliases.some((a) => bs.startsWith(a))) return i;
  }
  return null;
}

async function logEvent(userId: string, e: Record<string, unknown>): Promise<void> {
  try {
    const admin = createAdminClient();
    if (admin) await admin.from("flow_auto_events").insert({ user_id: userId, ...e });
  } catch { /* logging is best-effort */ }
}

/** Place ONE market order on the member's selected account. */
export async function placeMarketOrder(opts: {
  userId: string; symbol: string; side: "buy" | "sell"; qty: number;
  stop?: number | null; tp?: number | null; source: string;
}): Promise<PlaceOutcome> {
  const canonical = normSym(opts.symbol) || "XAUUSD";

  const fresh = await freshAccessToken(opts.userId);
  if (!fresh.ok) return { status: "error", reason: fresh.error };
  const conn = fresh.conn;
  const accountId = conn.selected_account_id;
  if (!accountId) return { status: "error", reason: "no_account_selected", environment: fresh.env };

  const admin = createAdminClient();
  const { data: acctRow } = admin
    ? await admin.from("flow_broker_accounts").select("acc_num").eq("connection_id", conn.id).eq("account_id", accountId).maybeSingle()
    : { data: null };
  const accNum = acctRow?.acc_num ? String(acctRow.acc_num) : null;
  if (!accNum) return { status: "error", reason: "no_acc_num", environment: fresh.env };

  const instRes = await listInstruments(fresh.env, fresh.token, accNum, accountId);
  if (!instRes.ok) return { status: "error", reason: `instrument_list_failed: ${instRes.error}`.slice(0, 160), environment: fresh.env };
  const tl = matchInstrument(canonical, instRes.data);
  if (!tl) return { status: "error", reason: `instrument_not_found: ${canonical}`, environment: fresh.env };

  const norm = normalizeQuantity(canonical, opts.qty, { quantityStep: tl.quantityStep, minQuantity: tl.minQuantity });
  const qty = norm.qty;

  const base = {
    accountId, accNum,
    tradableInstrumentId: tl.tradableInstrumentId, routeId: tl.routeId,
    side: opts.side, type: "market" as const, qty, validity: "IOC" as const,
  };
  const hasBracket = opts.stop != null || opts.tp != null;
  let ord = await createOrder(fresh.env, fresh.token, { ...base, stopLoss: opts.stop ?? null, takeProfit: opts.tp ?? null });

  // If the broker rejected the bracketed order (a stop/TP too close to market,
  // wrong side after a move, etc.), fall back to a bare market order so the
  // position still opens rather than the member silently taking no trade.
  let bracketNote = "";
  if (!ord.ok && hasBracket) {
    const bare = await createOrder(fresh.env, fresh.token, { ...base, stopLoss: null, takeProfit: null });
    if (bare.ok) { ord = bare; bracketNote = " (SL/TP rejected — opened bare)"; }
  }

  if (!ord.ok) {
    await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty, status: "error", reason: `${opts.source}: ${ord.error}`.slice(0, 200) });
    return { status: "error", reason: ord.error, environment: fresh.env };
  }
  const orderId = ord.data.orderId ?? null;
  await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty, status: "placed", reason: `${opts.source}${bracketNote}`.slice(0, 60), order_id: orderId });
  return { status: "placed", symbol: canonical, side: opts.side, qty, orderId, positionId: ord.data.positionId ?? null, environment: fresh.env, accountId };
}

/**
 * Read-only diagnostics — places NO order. Confirms the connection, the matched
 * instrument + its quantity rules, a live quote (is the market open / are we
 * getting prices?), and any working orders / open positions on the account.
 * Used to explain why a test order "didn't enter."
 */
export async function probeBroker(userId: string, symbol = "XAUUSD"): Promise<Record<string, unknown>> {
  const canonical = normSym(symbol) || "XAUUSD";
  const fresh = await freshAccessToken(userId);
  if (!fresh.ok) return { ok: false, reason: fresh.error };
  const conn = fresh.conn;
  const accountId = conn.selected_account_id;
  if (!accountId) return { ok: false, reason: "no_account_selected", environment: fresh.env };

  const admin = createAdminClient();
  const { data: acctRow } = admin
    ? await admin.from("flow_broker_accounts").select("acc_num").eq("connection_id", conn.id).eq("account_id", accountId).maybeSingle()
    : { data: null };
  const accNum = acctRow?.acc_num ? String(acctRow.acc_num) : null;
  if (!accNum) return { ok: false, reason: "no_acc_num", environment: fresh.env };

  const instRes = await listInstruments(fresh.env, fresh.token, accNum, accountId);
  if (!instRes.ok) return { ok: false, reason: `instrument_list_failed: ${instRes.error}`, environment: fresh.env };
  const tl = matchInstrument(canonical, instRes.data);
  if (!tl) {
    return { ok: false, reason: `instrument_not_found: ${canonical}`, environment: fresh.env, availableSymbols: instRes.data.slice(0, 40).map((i) => i.brokerSymbol) };
  }

  const norm = normalizeQuantity(canonical, 0.01, { quantityStep: tl.quantityStep, minQuantity: tl.minQuantity });
  const quote = await getQuote(fresh.env, fresh.token, accNum, tl.tradableInstrumentId, tl.infoRouteId || tl.routeId);
  const orders = await listOrders(fresh.env, fresh.token, accNum, accountId);
  const positions = await listPositions(fresh.env, fresh.token, accNum, accountId);
  const rawRoutes = (tl.raw && typeof tl.raw === "object") ? (tl.raw as Record<string, unknown>).routes : undefined;

  return {
    ok: true,
    environment: fresh.env,
    accountId,
    accNum,
    instrument: { brokerSymbol: tl.brokerSymbol, tradableInstrumentId: tl.tradableInstrumentId, routeId: tl.routeId, infoRouteId: tl.infoRouteId, quantityStep: tl.quantityStep, minQuantity: tl.minQuantity },
    rawRoutes,
    normalizedQty: { qty: norm.qty, ok: norm.ok, reason: norm.reason },
    quote: quote.ok ? quote.data : { error: quote.error },
    orders: orders.ok ? orders.data : { error: orders.error },
    positions: positions.ok ? positions.data : { error: positions.error },
  };
}
