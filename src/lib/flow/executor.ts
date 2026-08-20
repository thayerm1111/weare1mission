import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeQuantity } from "@/lib/flow/instruments";
import { freshAccessToken, activeAccounts, type ActiveAccount } from "@/lib/flow/connection";
import { sizeFromRisk, contractKey } from "@/lib/flow/sizing";
import { listInstruments, createOrder, getQuote, listOrders, listPositions, listAccounts, type TLEnv, type TLInstrument } from "@/lib/flow/tradelocker";

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

/**
 * Live equity of the member's SELECTED connected account (for risk-based sizing).
 * Returns { ok:false } when no account is connected so callers can fall back to a
 * saved account size.
 */
export async function accountEquity(userId: string): Promise<{ ok: true; equity: number; balance: number | null; currency: string | null; accountId: string; environment: string } | { ok: false; reason: string }> {
  const fresh = await freshAccessToken(userId);
  if (!fresh.ok) return { ok: false, reason: fresh.error };
  const accountId = fresh.conn.selected_account_id;
  if (!accountId) return { ok: false, reason: "no_account_selected" };
  const res = await listAccounts(fresh.env, fresh.token);
  if (!res.ok) return { ok: false, reason: res.error };
  const acc = res.data.find((a) => String(a.accountId) === String(accountId)) ?? res.data[0];
  if (!acc) return { ok: false, reason: "account_not_found" };
  const equity = typeof acc.equity === "number" ? acc.equity : (typeof acc.balance === "number" ? acc.balance : NaN);
  if (!Number.isFinite(equity)) return { ok: false, reason: "no_equity" };
  return { ok: true, equity, balance: acc.balance ?? null, currency: acc.currency ?? null, accountId, environment: fresh.env };
}

async function logEvent(userId: string, e: Record<string, unknown>): Promise<void> {
  try {
    const admin = createAdminClient();
    if (admin) await admin.from("flow_auto_events").insert({ user_id: userId, ...e });
  } catch { /* logging is best-effort */ }
}

/** Core: place ONE market order on a specific (env, token, account). No logging;
 *  the caller records the event so multi-account fan-out can log per account. */
async function placeOnAccount(a: { env: TLEnv; token: string; accNum: string; accountId: string }, canonical: string, side: "buy" | "sell", qty: number, stop?: number | null, tp?: number | null): Promise<{ ok: true; qty: number; orderId: string | null; positionId: string | null; note: string } | { ok: false; error: string }> {
  const instRes = await listInstruments(a.env, a.token, a.accNum, a.accountId);
  if (!instRes.ok) return { ok: false, error: `instrument_list_failed: ${instRes.error}`.slice(0, 160) };
  const tl = matchInstrument(canonical, instRes.data);
  if (!tl) return { ok: false, error: `instrument_not_found: ${canonical}` };

  const norm = normalizeQuantity(canonical, qty, { quantityStep: tl.quantityStep, minQuantity: tl.minQuantity });
  const base = {
    accountId: a.accountId, accNum: a.accNum,
    tradableInstrumentId: tl.tradableInstrumentId, routeId: tl.routeId,
    side, type: "market" as const, qty: norm.qty, validity: "IOC" as const,
  };
  const hasBracket = stop != null || tp != null;
  let ord = await createOrder(a.env, a.token, { ...base, stopLoss: stop ?? null, takeProfit: tp ?? null });
  let note = "";
  if (!ord.ok && hasBracket) {
    const bare = await createOrder(a.env, a.token, { ...base, stopLoss: null, takeProfit: null });
    if (bare.ok) { ord = bare; note = " (SL/TP rejected — opened bare)"; }
  }
  if (!ord.ok) return { ok: false, error: ord.error };
  return { ok: true, qty: norm.qty, orderId: ord.data.orderId ?? null, positionId: ord.data.positionId ?? null, note };
}

/** Place ONE market order on the member's PRIMARY selected account (single-account
 *  path — the read-only test button and legacy callers). */
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

  const r = await placeOnAccount({ env: fresh.env, token: fresh.token, accNum, accountId }, canonical, opts.side, opts.qty, opts.stop, opts.tp);
  if (!r.ok) {
    await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty: opts.qty, status: "error", reason: `${opts.source}: ${r.error}`.slice(0, 200), account_id: accountId });
    return { status: "error", reason: r.error, environment: fresh.env };
  }
  await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty: r.qty, status: "placed", reason: `${opts.source}${r.note}`.slice(0, 60), order_id: r.orderId, account_id: accountId });
  return { status: "placed", symbol: canonical, side: opts.side, qty: r.qty, orderId: r.orderId, positionId: r.positionId, environment: fresh.env, accountId };
}

export type AccountFill = {
  accountId: string; accNum: string; name: string | null; environment: string;
  status: "placed" | "error" | "skipped"; qty?: number; lots?: number; estLossAtStop?: number;
  orderId?: string | null; reason?: string;
};

/**
 * Risk-size and place THE SAME setup on EVERY account the member has toggled ON
 * (across all their connections), each sized to its own live equity. This is what
 * auto-run and one-tap Execute use. Returns a per-account outcome list. Billing /
 * guardrails are handled by the caller (they're per-member, not per-account).
 */
export async function placeOnActiveAccounts(opts: {
  userId: string; symbol: string; side: "buy" | "sell";
  entry: number; stop: number; tp?: number | null; riskPct: number; source: string;
  accounts?: ActiveAccount[]; // pass a pre-fetched list to avoid re-minting tokens
}): Promise<{ accounts: AccountFill[]; placed: number }> {
  const canonical = normSym(opts.symbol) || "XAUUSD";
  const isGold = contractKey(canonical) === "XAUUSD";
  const accts = opts.accounts ?? (await activeAccounts(opts.userId));
  const fills: AccountFill[] = [];
  let placed = 0;
  for (const a of accts) {
    if (a.equity == null) { fills.push({ accountId: a.accountId, accNum: a.accNum, name: a.name, environment: a.env, status: "skipped", reason: "no_equity" }); continue; }
    const floorToMinLot = isGold && a.equity < 500;
    const s = sizeFromRisk({ canonical, entry: opts.entry, stop: opts.stop, equity: a.equity, riskPct: opts.riskPct, floorToMinLot });
    if (!s.ok || !(s.lots > 0)) { fills.push({ accountId: a.accountId, accNum: a.accNum, name: a.name, environment: a.env, status: "skipped", reason: s.reason || "size_too_small" }); continue; }
    const lots = Math.min(s.lots, 100); // fat-finger backstop
    const r = await placeOnAccount({ env: a.env, token: a.token, accNum: a.accNum, accountId: a.accountId }, canonical, opts.side, lots, opts.stop, opts.tp ?? null);
    if (!r.ok) {
      await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty: s.lots, status: "error", reason: `${opts.source}: ${r.error}`.slice(0, 200), account_id: a.accountId });
      fills.push({ accountId: a.accountId, accNum: a.accNum, name: a.name, environment: a.env, status: "error", lots: s.lots, reason: r.error });
      continue;
    }
    await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty: r.qty, status: "placed", reason: `${opts.source}${r.note}`.slice(0, 60), order_id: r.orderId, account_id: a.accountId });
    fills.push({ accountId: a.accountId, accNum: a.accNum, name: a.name, environment: a.env, status: "placed", qty: r.qty, lots: r.qty, estLossAtStop: s.estLossAtStop, orderId: r.orderId });
    placed += 1;
  }
  return { accounts: fills, placed };
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
