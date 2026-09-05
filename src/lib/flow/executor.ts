import { createAdminClient } from "@/lib/supabase/admin";
import { logTrade } from "@/lib/flow/tradeLog";
import { normalizeQuantity, getInstrument } from "@/lib/flow/instruments";
import { freshAccessToken, activeAccounts, type ActiveAccount } from "@/lib/flow/connection";
import { sizeFromRisk, contractKey, floorStop } from "@/lib/flow/sizing";
import { listInstruments, createOrder, getQuote, listOrders, listPositions, listAccounts, modifyPosition, type TLEnv, type TLInstrument } from "@/lib/flow/tradelocker";

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
export function matchInstrument(canonical: string, instruments: TLInstrument[]): TLInstrument | null {
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
/** Broker rejections that mean "not this session" — rollover, closed, pre-open,
 *  or the instrument's session phase forbids protected orders. These are NOT
 *  failures to fix; the executor simply retries on the next tick once the session
 *  reopens. Matched case-insensitively against the broker's message. */
function isSessionClosedReject(msg: string): boolean {
  return /session|market[^a-z]*(clos|halt)|forbidden|not[^a-z]*open|trading[^a-z]*(clos|halt|disabl)/i.test(String(msg || ""));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull a position id out of a TradeLocker position entry (object OR columnar array). */
function posIdOf(p: unknown): string {
  if (Array.isArray(p)) return p.length ? String(p[0]) : "";
  if (p && typeof p === "object") { const o = p as Record<string, unknown>; const v = o.id ?? o.positionId ?? o.positionID; return v == null ? "" : String(v); }
  return "";
}

/**
 * Find the position a just-placed MARKET order created. TradeLocker returns an
 * orderId (not a positionId) for market orders, and the position registers a beat
 * after the order call returns — so we diff the open-position ids against a
 * pre-order snapshot and poll briefly for the new one. This is what lets the
 * trade-manager track the fill for break-even + partials.
 */
async function resolveNewPositionId(a: { env: TLEnv; token: string; accNum: string; accountId: string }, beforeIds: Set<string>): Promise<string | null> {
  for (let i = 0; i < 4; i++) {
    await sleep(600);
    try {
      const pp = await listPositions(a.env, a.token, a.accNum, a.accountId);
      if (pp.ok) {
        const fresh = pp.data.map(posIdOf).filter(Boolean).find((id) => !beforeIds.has(id));
        if (fresh) return fresh;
      }
    } catch { /* keep polling */ }
  }
  return null;
}

// Instrument lists change rarely, but we were re-fetching the WHOLE list from the
// broker on every single order, for every account. With many accounts trading the
// same minute that tripped TradeLocker's rate limit (429 → "Couldn't load broker
// instruments"), so a trade would fill on some accounts and fail on others.
// Cache the list per account for a few minutes and retry once on a transient
// failure — dramatically fewer broker calls, so fills land on all accounts.
const INSTRUMENT_TTL_MS = 10 * 60_000;
const instrumentCache = new Map<string, { at: number; data: TLInstrument[] }>();
async function instrumentsFor(a: { env: TLEnv; token: string; accNum: string; accountId: string; connId?: string }): Promise<{ ok: true; data: TLInstrument[] } | { ok: false; error: string }> {
  // Key by CONNECTION when we know it: every account under one broker login shares
  // the same instrument universe, so the accounts on a multi-account login (e.g. the
  // 3 Crucial accounts) reuse ONE fetch instead of each hammering the broker — which
  // is what was tripping the broker's rate limit and failing all but one account.
  const key = a.connId ? `conn:${a.env}:${a.connId}` : `${a.env}:${a.accountId}`;
  const hit = instrumentCache.get(key);
  if (hit && Date.now() - hit.at < INSTRUMENT_TTL_MS) return { ok: true, data: hit.data };
  let lastErr = "instrument_list_failed";
  for (let i = 0; i < 2; i++) {
    const r = await listInstruments(a.env, a.token, a.accNum, a.accountId);
    if (r.ok && r.data.length) { instrumentCache.set(key, { at: Date.now(), data: r.data }); return { ok: true, data: r.data }; }
    lastErr = r.ok ? "no_instruments" : r.error;
    if (i === 0) await sleep(500); // brief backoff, then one retry
  }
  // Fall back to a stale cached copy if we have one — better than dropping the trade.
  if (hit) return { ok: true, data: hit.data };
  return { ok: false, error: lastErr };
}

async function placeOnAccount(a: { env: TLEnv; token: string; accNum: string; accountId: string; connId?: string }, canonical: string, side: "buy" | "sell", qty: number, stop?: number | null, tp?: number | null, ensureBrackets?: boolean): Promise<{ ok: true; qty: number; orderId: string | null; positionId: string | null; note: string } | { ok: false; error: string; deferred?: boolean }> {
  const instRes = await instrumentsFor(a);
  if (!instRes.ok) return { ok: false, error: `instrument_list_failed: ${instRes.error}`.slice(0, 160) };
  const tl = matchInstrument(canonical, instRes.data);
  if (!tl) return { ok: false, error: `instrument_not_found: ${canonical}` };

  // Round SL/TP to the instrument's price precision BEFORE they reach the
  // broker. Play levels can carry excess decimals (a BTC play at 79541.456789)
  // and some brokers reject — or silently DROP — a bracket at an off-grid
  // price while still filling the market order, leaving the position naked.
  const prec = getInstrument(canonical).pricePrecision;
  if (stop != null) stop = +stop.toFixed(prec);
  if (tp != null) tp = +tp.toFixed(prec);

  const norm = normalizeQuantity(canonical, qty, { quantityStep: tl.quantityStep, minQuantity: tl.minQuantity });
  const base = {
    accountId: a.accountId, accNum: a.accNum,
    tradableInstrumentId: tl.tradableInstrumentId, routeId: tl.routeId,
    side, type: "market" as const, qty: norm.qty, validity: "IOC" as const,
  };
  const hasBracket = stop != null || tp != null;
  const hasStop = stop != null;
  // Snapshot open positions BEFORE a stop-protected order so we can identify the
  // NEW position after the fill (needed for the trade-manager, since market
  // orders return an orderId, not a positionId).
  let beforeIds = new Set<string>();
  if (hasStop) {
    try { const bp = await listPositions(a.env, a.token, a.accNum, a.accountId); if (bp.ok) beforeIds = new Set(bp.data.map(posIdOf).filter(Boolean)); } catch { /* best-effort */ }
  }
  let ord = await createOrder(a.env, a.token, { ...base, stopLoss: stop ?? null, takeProfit: tp ?? null });
  let note = "";
  if (!ord.ok && hasBracket) {
    // Session-closed / rollover / pre-open: the broker won't accept a protected
    // order right now. Do NOT open anything — defer and let the next tick retry
    // once the session reopens. (This is the gold 21:00–22:00 UTC window.)
    if (isSessionClosedReject(ord.error)) return { ok: false, error: ord.error, deferred: true };
    // Non-session rejection. Take-profit is the leg brokers most often restrict,
    // so retry with the STOP still attached (drop only the TP). We NEVER open a
    // position without its stop-loss — an unprotected fill defeats the risk model
    // and is catastrophic on a large account. If a stop was required and the
    // stop-only retry still fails, we skip rather than open bare.
    if (hasStop) {
      const stopOnly = await createOrder(a.env, a.token, { ...base, stopLoss: stop, takeProfit: null });
      if (stopOnly.ok) { ord = stopOnly; note = " (TP dropped — SL kept)"; }
    } else {
      const bare = await createOrder(a.env, a.token, { ...base, stopLoss: null, takeProfit: null });
      if (bare.ok) { ord = bare; note = " (TP rejected — opened)"; }
    }
  }
  if (!ord.ok) return { ok: false, error: ord.error, deferred: isSessionClosedReject(ord.error) };
  // Resolve the position id for the trade-manager when the broker didn't hand one
  // back (the usual case for market orders).
  let positionId = ord.data.positionId ?? null;
  if (!positionId && hasStop) positionId = await resolveNewPositionId(a, beforeIds);

  // BELT AND BRACES (member play executes): some TradeLocker routes accept a
  // market order but silently drop its SL/TP brackets — the fill lands NAKED
  // with no error anywhere. A member's play trade must never sit unprotected,
  // so once the position resolves, explicitly (re)apply the exact same levels
  // via modifyPosition. Idempotent when the brackets did attach; the repair
  // when they didn't. Any failure is surfaced in the note, never swallowed.
  if (ensureBrackets && hasBracket && positionId) {
    try {
      const fix = await modifyPosition(a.env, a.token, a.accNum, positionId, {
        ...(stop != null ? { stopLoss: stop } : {}),
        ...(tp != null ? { takeProfit: tp } : {}),
      });
      if (!fix.ok) note += ` (bracket verify failed: ${String(fix.error).slice(0, 80)} — CHECK SL/TP ON THE POSITION)`;
    } catch {
      note += " (bracket verify threw — CHECK SL/TP ON THE POSITION)";
    }
  }
  return { ok: true, qty: norm.qty, orderId: ord.data.orderId ?? null, positionId, note };
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

  const r = await placeOnAccount({ env: fresh.env, token: fresh.token, accNum, accountId, connId: conn.id }, canonical, opts.side, opts.qty, opts.stop, opts.tp);
  if (!r.ok) {
    await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty: opts.qty, status: r.deferred ? "deferred" : "error", reason: `${opts.source}: ${r.error}`.slice(0, 200), account_id: accountId });
    return { status: "error", reason: r.deferred ? "Market session closed — will retry when it reopens." : r.error, environment: fresh.env };
  }
  await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty: r.qty, status: "placed", reason: `${opts.source}${r.note}`.slice(0, 60), order_id: r.orderId, account_id: accountId });
  return { status: "placed", symbol: canonical, side: opts.side, qty: r.qty, orderId: r.orderId, positionId: r.positionId, environment: fresh.env, accountId };
}

/**
 * GENX FOLLOWER placement — place ONE raw market order at a FIXED lot on a SPECIFIC
 * account (identified by a pre-minted token + connId/accountId/accNum). Unlike
 * placeOnActiveAccounts this does NO risk sizing (flat qty) and NO guards. It returns
 * the broker positionId so the caller can OPTIONALLY hand the fill to the trade-manager
 * (breakeven + partials) when the account has management turned on; with management off
 * the follower simply rides the broker-held SL/TP to its outcome, untouched.
 * The caller owns dedup (one fill per signal per account).
 */
export async function placeFixedLotFollower(opts: {
  userId: string; env: TLEnv; token: string; connId: string; accountId: string; accNum: string;
  symbol: string; side: "buy" | "sell"; qty: number; stop?: number | null; tp?: number | null; source: string;
}): Promise<{ ok: true; orderId: string | null; positionId: string | null; qty: number } | { ok: false; reason: string; deferred: boolean }> {
  const canonical = normSym(opts.symbol) || "XAUUSD";
  const r = await placeOnAccount(
    { env: opts.env, token: opts.token, accNum: opts.accNum, accountId: opts.accountId, connId: opts.connId },
    canonical, opts.side, opts.qty, opts.stop ?? null, opts.tp ?? null,
  );
  if (!r.ok) {
    const st = r.deferred ? "deferred" : "error";
    await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty: opts.qty, status: st, reason: `${opts.source}: ${r.error}`.slice(0, 200), account_id: opts.accountId });
    return { ok: false, reason: r.error, deferred: !!r.deferred };
  }
  await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty: r.qty, status: "placed", reason: `${opts.source}${r.note}`.slice(0, 60), order_id: r.orderId, account_id: opts.accountId });
  return { ok: true, orderId: r.orderId, positionId: r.positionId, qty: r.qty };
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
  // Widen a too-tight signal stop to the instrument's minimum distance BEFORE sizing and
  // placing — so the position is sized off a sane stop (no ballooned lots) and the broker
  // holds a stop with room to breathe (no noise whipsaw). Same risk %, professional size.
  const stop = floorStop(canonical, opts.side, opts.entry, opts.stop);
  const accts = opts.accounts ?? (await activeAccounts(opts.userId));
  const tlog = createAdminClient(); // flight-recorder handle (best-effort; null-safe below)
  const fills: AccountFill[] = [];
  let placed = 0;
  for (const a of accts) {
    if (a.equity == null) { fills.push({ accountId: a.accountId, accNum: a.accNum, name: a.name, environment: a.env, status: "skipped", reason: "no_equity" }); continue; }
    // Whenever risk-sizing rounds BELOW the broker minimum lot, take the minimum
    // (e.g. 0.01) rather than skip — so a small account still gets the trade. On a
    // tiny account that minimum may risk a bit more than the target %, but the broker
    // minimum is the smallest tradeable size, so it's take-the-minimum or sit out.
    // Each account risk-sizes to ITS OWN risk % when one is set, else the caller's
    // default — so one account can run aggressive and another conservative.
    const acctRisk = a.riskPct != null && a.riskPct > 0 ? a.riskPct : opts.riskPct;
    const s = sizeFromRisk({ canonical, entry: opts.entry, stop, equity: a.equity, riskPct: acctRisk, floorToMinLot: true });
    if (!s.ok || !(s.lots > 0)) { fills.push({ accountId: a.accountId, accNum: a.accNum, name: a.name, environment: a.env, status: "skipped", reason: s.reason || "size_too_small" }); continue; }
    const lots = Math.min(s.lots, 100); // fat-finger backstop
    const t0 = Date.now();
    if (tlog) await logTrade(tlog, { account_id: a.accountId, user_id: opts.userId, symbol: canonical, phase: "entry_submitted", reason: opts.source, price: opts.entry, qty: lots, detail: { side: opts.side, stop, tp: opts.tp ?? null } });
    let r: Awaited<ReturnType<typeof placeOnAccount>>;
    try {
      // Member play executes get the bracket verify+repair pass (ensureBrackets):
      // low volume, member-initiated, and the trade is unmanaged afterward — so
      // the SL/TP the card promised MUST actually be on the broker position.
      r = await placeOnAccount({ env: a.env, token: a.token, accNum: a.accNum, accountId: a.accountId, connId: a.connId }, canonical, opts.side, lots, stop, opts.tp ?? null, opts.source === "play");
    } catch (e) {
      // The order request THREW (e.g. a network timeout AFTER the broker may already have
      // filled). Never assume it failed and never abort the rest of the fan-out — log an
      // 'uncertain' intent (with the levels) so the manager's orphan-recovery can find and
      // adopt the live position if it did fill, then move on to the next account.
      await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty: lots, status: "uncertain", reason: `${opts.source}: ${(e instanceof Error ? e.message : "order_threw")}`.slice(0, 200), account_id: a.accountId, entry: opts.entry, stop, tp: opts.tp ?? null });
      if (tlog) await logTrade(tlog, { account_id: a.accountId, user_id: opts.userId, symbol: canonical, phase: "entry_uncertain", reason: (e instanceof Error ? e.message : "order_threw").slice(0, 80), price: opts.entry, qty: lots, detail: { latencyMs: Date.now() - t0 } });
      fills.push({ accountId: a.accountId, accNum: a.accNum, name: a.name, environment: a.env, status: "error", lots: s.lots, reason: "order_uncertain (timeout — recovery will adopt if it filled)" });
      continue;
    }
    if (!r.ok) {
      // Session-closed rejection isn't a failure — the next tick retries once the
      // market reopens. Record it as "deferred"/skipped so it doesn't spam errors.
      const st = r.deferred ? "deferred" : "error";
      await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty: s.lots, status: st, reason: `${opts.source}: ${r.error}`.slice(0, 200), account_id: a.accountId });
      fills.push({ accountId: a.accountId, accNum: a.accNum, name: a.name, environment: a.env, status: r.deferred ? "skipped" : "error", lots: s.lots, reason: r.deferred ? "session_closed" : r.error });
      continue;
    }
    await logEvent(opts.userId, { symbol: canonical, side: opts.side, qty: r.qty, status: "placed", reason: `${opts.source}${r.note}`.slice(0, 60), order_id: r.orderId, account_id: a.accountId, entry: opts.entry, stop, tp: opts.tp ?? null });
    fills.push({ accountId: a.accountId, accNum: a.accNum, name: a.name, environment: a.env, status: "placed", qty: r.qty, lots: r.qty, estLossAtStop: s.estLossAtStop, orderId: r.orderId });
    if (tlog) await logTrade(tlog, { account_id: a.accountId, user_id: opts.userId, symbol: canonical, phase: "entry_confirmed", reason: opts.source, position_id: r.positionId, price: opts.entry, qty: r.qty, detail: { latencyMs: Date.now() - t0, orderId: r.orderId, estLossAtStop: s.estLossAtStop } });
    placed += 1;
    // Hand the fill to the trade-manager (breakeven → partial → trail). Needs a
    // positionId + a real stop; a bare/unstopped fill isn't managed. OM AI PLAYS ARE
    // NOT ENROLLED (owner directive 09-01: "OM AI plays should not be managed — only
    // the FLOW and GENX trades"): a member who taps Execute on a play runs that trade
    // themselves with the stop/TP exactly as placed; the manager never moves them.
    if (opts.source !== "play" && r.positionId && stop != null) {
      try {
        const admin = createAdminClient();
        if (admin) await admin.from("flow_managed_positions").insert({
          user_id: opts.userId, connection_id: a.connId, account_id: a.accountId, acc_num: a.accNum, environment: a.env,
          position_id: r.positionId, symbol: canonical, side: opts.side,
          entry: opts.entry, init_stop: stop, tp1: opts.tp ?? null,
          r: Math.abs(opts.entry - stop), qty: r.qty, cur_stop: stop, best_price: opts.entry,
        });
      } catch { /* management is best-effort */ }
    }
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
