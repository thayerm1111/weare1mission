import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeQuantity } from "@/lib/flow/instruments";
import { freshAccessToken } from "@/lib/flow/connection";
import { listInstruments, createOrder, type TLInstrument } from "@/lib/flow/tradelocker";

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

  const ord = await createOrder(fresh.env, fresh.token, {
    accountId, accNum,
    tradableInstrumentId: tl.tradableInstrumentId, routeId: tl.routeId,
    side: opts.side, type: "market", qty,
    stopLoss: opts.stop ?? null, takeProfit: opts.tp ?? null,
    validity: "IOC",
  });

  if (!ord.ok) {
    await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty, status: "error", reason: `${opts.source}: ${ord.error}`.slice(0, 200) });
    return { status: "error", reason: ord.error, environment: fresh.env };
  }
  const orderId = ord.data.orderId ?? null;
  await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty, status: "placed", reason: opts.source, order_id: orderId });
  return { status: "placed", symbol: canonical, side: opts.side, qty, orderId, positionId: ord.data.positionId ?? null, environment: fresh.env, accountId };
}
