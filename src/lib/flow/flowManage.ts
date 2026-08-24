import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { matchInstrument } from "@/lib/flow/executor";
import { normalizeQuantity, getInstrument } from "@/lib/flow/instruments";
import { contractKey } from "@/lib/flow/sizing";
import { listInstruments, listPositions, getQuote, getConfig, modifyPosition, closePosition, type TLEnv, type TLInstrument } from "@/lib/flow/tradelocker";

// Fallback price source. The broker's own quote endpoint is intermittently down for
// a symbol/account (we've observed a persistent "no_quote" on an open gold position
// while the broker still held it), which stalls break-even/partials indefinitely.
// When the broker quote is unavailable we fall back to the market-data feed so the
// manager keeps protecting the trade. Cached briefly so many positions on one symbol
// share a single upstream call.
const feedCache = new Map<string, { at: number; px: number }>();
const FEED_TTL_MS = 20_000;
async function feedPrice(symbol: string): Promise<number | null> {
  try {
    const td = getInstrument(contractKey(symbol))?.twelveDataSymbol;
    if (!td) return null;
    const hit = feedCache.get(td);
    if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.px;
    const key = process.env.TWELVEDATA_API_KEY;
    if (!key) return null;
    const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(td)}&apikey=${key}`, { cache: "no-store" });
    const j = (await r.json()) as { price?: unknown };
    const p = Number(j?.price);
    if (Number.isFinite(p) && p > 0) { feedCache.set(td, { at: Date.now(), px: p }); return p; }
  } catch { /* feed down → null */ }
  return null;
}

// Recent intra-minute EXTREMES from the market-data feed. The manager runs once a minute
// off the instantaneous bid/ask, so a spike that reverses inside the minute (common on
// gold around news) is invisible to the sample — break-even/partials never fire even though
// the trade clearly reached the level on the chart. We pull the last few 1-min candle
// highs/lows so the trigger sees the TRUE favorable excursion the trade reached. Cached per
// symbol for the tick. Feed down / no key → null (caller falls back to the sampled price).
const extCache = new Map<string, { at: number; high: number; low: number }>();
async function feedExtremes(symbol: string): Promise<{ high: number; low: number } | null> {
  try {
    const td = getInstrument(contractKey(symbol))?.twelveDataSymbol;
    if (!td) return null;
    const hit = extCache.get(td);
    if (hit && Date.now() - hit.at < FEED_TTL_MS) return { high: hit.high, low: hit.low };
    const key = process.env.TWELVEDATA_API_KEY;
    if (!key) return null;
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=1min&outputsize=3&apikey=${key}`, { cache: "no-store" });
    const j = (await r.json()) as { values?: Array<{ high?: unknown; low?: unknown }> };
    const vals = Array.isArray(j?.values) ? j.values : [];
    let hi = 0, lo = Infinity;
    for (const v of vals) {
      const h = Number(v.high), l = Number(v.low);
      if (Number.isFinite(h) && h > 0) hi = Math.max(hi, h);
      if (Number.isFinite(l) && l > 0) lo = Math.min(lo, l);
    }
    if (hi > 0 && Number.isFinite(lo)) { extCache.set(td, { at: Date.now(), high: hi, low: lo }); return { high: hi, low: lo }; }
  } catch { /* feed down → null */ }
  return null;
}

/**
 * FLOW AUTO TRADE-MANAGER (server-only). Runs the member's playbook on every position
 * FLOW opened (recorded in flow_managed_positions by executor.placeOnActiveAccounts).
 *
 * THE RULES (simple, and anchored to the broker's OWN numbers so it can never act on a
 * phantom profit):
 *   0. Start with the entry, stop and take-profit exactly as placed — untouched.
 *   1. BREAK-EVEN: when price reaches the break-even point (the halfway mark to take-profit,
 *      or an earlier per-account gold-pips setting if one is configured), move the STOP to
 *      the ENTRY. The trade can no longer lose.
 *   2. PARTIAL: only on a 1:2 (or wider) target — bank a 50% partial at that same halfway
 *      point. On a ~1:1 there is no partial; the stop just moves to entry.
 *   3. TRAIL (runner only): once break-even is set (and, on a 1:2, the partial is banked),
 *      ratchet the remaining runner's stop up behind the best price it reaches — anchored to
 *      the REAL fill and the true favorable excursion — so a winner that reverses keeps most
 *      of its gain. Ratchet only (a long's stop never drops), never below break-even, and
 *      never through the current market.
 *
 * HARD SAFETY: every stop-to-entry and every partial is gated on the broker itself showing
 * the position IN PROFIT (its unrealized P&L, or price beyond the real fill). We NEVER close
 * a "partial" or set a "break-even" at a price that is actually a loss. The entry we measure
 * from is the account's REAL average fill read back from the broker — not the shared signal
 * price, which differs per account and was the cause of losers being banked as wins.
 *
 * It also detects a position that has closed (SL/TP hit or member-closed) and books the
 * outcome. It never OPENS a position, and all broker writes go through the confirmed
 * TradeLocker modify/close endpoints.
 */

export type ManagedRow = {
  id: string; user_id: string; connection_id: string; account_id: string; acc_num: string; environment: string;
  position_id: string; symbol: string; side: "buy" | "sell";
  entry: number; init_stop: number; tp1: number | null; r: number; qty: number;
  cur_stop: number | null; best_price: number | null; be_done: boolean | null; partial_done: boolean | null; status: string;
  last_error?: string | null;
};

export type ManageAction = { positionId: string; symbol: string; account: string; action: string; detail?: string };
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

// Max positions to touch per tick (backstop; the manager runs every ~60s).
const MAX_PER_TICK = 300;

// A target counts as "1:2 or wider" (→ take the partial) at this reward:risk or above.
// Below it the trade is treated as ~1:1 (→ break-even only, no partial).
const DOUBLE_RR = 1.8;
// Never move the break-even stop on a scratch smaller than this (pips) — avoids nudging the
// stop for a spread-width blip on an ultra-tight stop.
const BE_MIN_PIPS = 8;

// GOLD default break-even trigger (pips) when an account has no per-account gold_be_pips
// override set. Gold moves the stop to entry once it's this many pips in profit — so every
// account protects a gold winner early, not only ones with the override configured.
const DEFAULT_GOLD_BE_PIPS = 35;

// PROTECTIVE TRAIL (after break-even). The runner's stop rides GIVEBACK_R behind the best
// price (loose enough to breathe toward target); once the move gets CLOSE — within NEAR_TP_R
// of take-profit, or NEAR_PARTIAL_R below the halfway/partial level — it tightens to
// GIVEBACK_NEAR_R so a run that gets "super close" and reverses locks in most of the gain.
const GIVEBACK_R = 0.6;
const GIVEBACK_NEAR_R = 0.25;
const NEAR_TP_R = 0.4;
const NEAR_PARTIAL_R = 0.2;

/** Extract a position id from a TradeLocker position entry (object OR column array). */
function posIdOf(p: unknown): string {
  if (Array.isArray(p)) return p.length ? String(p[0]) : "";
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    const v = o.id ?? o.positionId ?? o.positionID;
    return v == null ? "" : String(v);
  }
  return "";
}

/** Read a numeric field from a TradeLocker position, whether it comes back as a columnar
 *  array (use the config-derived index) or an object (use one of the known field names). */
function numAt(p: unknown, idx: number, keys: string[]): number | null {
  let v: number = NaN;
  if (Array.isArray(p)) { if (idx >= 0 && idx < p.length) v = Number(p[idx]); }
  else if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    for (const k of keys) { const n = Number(o[k]); if (Number.isFinite(n)) { v = n; break; } }
  }
  return Number.isFinite(v) ? v : null;
}

const AVG_KEYS = ["avgPrice", "openPrice", "avg_price", "price"];
const UPL_KEYS = ["unrealizedPl", "unrealizedPnl", "unrealizedPnL", "upl", "rpl"];

/** Round a stop price to the instrument's own precision so the broker accepts it. */
function roundPx(symbol: string, price: number): number {
  const prec = getInstrument(contractKey(symbol)).pricePrecision ?? 2;
  return +price.toFixed(prec);
}

/**
 * Where the 50% partial fires, as a fraction of R, from the signal's REWARD:RISK — used by
 * the outcome classifier to weight banked pips. ~1:1 banks at +0.5R (halfway to a 1R target),
 * 1:2/1:3 banks at +1R (halfway to a 2R target) — i.e. always the halfway-to-target point.
 */
function partialTriggerR(entry: number, initStop: number, tp1: number | null): number {
  const risk = Math.abs(entry - initStop);
  const reward = tp1 != null && tp1 > 0 ? Math.abs(tp1 - entry) : risk;
  const rr = risk > 0 ? reward / risk : 1;
  return rr <= 1.5 ? 0.5 : 1;
}

export type FlowOutcomeKind = "stop" | "breakeven" | "trail" | "target";
export type FlowOutcome = { outcome: FlowOutcomeKind; result_pips: number; exit_price: number; partial_taken: boolean };

/**
 * Classify a CLOSED managed position into the track-record outcome, from the lifecycle we
 * recorded — measured from the REAL entry (re-anchored while the trade was live). 'stop' is
 * the only negative outcome; a trade that reached break-even can at worst scratch.
 */
export function classifyOutcome(
  row: Pick<ManagedRow, "symbol" | "side" | "entry" | "init_stop" | "tp1" | "best_price" | "cur_stop" | "be_done" | "partial_done">,
  exitPrice?: number | null,
): FlowOutcome {
  const sym = contractKey(row.symbol);
  const pip = getInstrument(sym).pipSize || 0.0001;
  const long = row.side === "buy";
  const rPips = Math.round(Math.abs(row.entry - row.init_stop) / pip);
  const bankPips = Math.round(partialTriggerR(row.entry, row.init_stop, row.tp1) * rPips);
  const banked = !!row.partial_done;
  const tp1 = row.tp1;
  const best = row.best_price;
  const hitTarget = tp1 != null && best != null && (long ? best >= tp1 : best <= tp1);
  const signed = (px: number) => Math.round((long ? px - row.entry : row.entry - px) / pip);

  if (row.be_done && hitTarget && tp1 != null) {
    const pips = banked ? Math.round(0.5 * bankPips + 0.5 * signed(tp1)) : signed(tp1);
    return { outcome: "target", result_pips: pips, exit_price: tp1, partial_taken: banked };
  }

  const exit = (exitPrice != null && exitPrice > 0)
    ? exitPrice
    : (row.be_done ? (row.cur_stop ?? row.entry) : row.init_stop);
  const exitPips = signed(exit);

  if (row.be_done) {
    const total = banked ? Math.round(0.5 * bankPips + 0.5 * exitPips) : exitPips;
    const isBE = Math.abs(exitPips) <= Math.max(1, 0.2 * rPips);
    return { outcome: isBE ? "breakeven" : (exitPips > 0 ? "trail" : "breakeven"), result_pips: total, exit_price: exit, partial_taken: banked };
  }
  if (exitPips > 0) return { outcome: "trail", result_pips: exitPips, exit_price: exit, partial_taken: false };
  return { outcome: "stop", result_pips: exitPips, exit_price: exit, partial_taken: false };
}

/**
 * Manage every OPEN position FLOW is tracking, per THE RULES in the file header.
 * Safe to call blind — if the tracking table doesn't exist yet, it no-ops.
 */
export async function manageOpenPositions(): Promise<{ managed: number; actions: ManageAction[]; note?: string }> {
  const admin = createAdminClient();
  if (!admin) return { managed: 0, actions: [], note: "no_admin_client" };

  const { data, error } = await admin
    .from("flow_managed_positions")
    .select("*")
    .eq("status", "open")
    .order("updated_at", { ascending: true })
    .limit(MAX_PER_TICK);
  if (error) return { managed: 0, actions: [], note: `no_table: ${error.message}`.slice(0, 120) };
  const rows = (data ?? []) as ManagedRow[];
  if (!rows.length) return { managed: 0, actions: [] };

  // Per-account MANAGEMENT switch + optional GOLD break-even-pips override (moves BE earlier
  // than the halfway-to-target point, gold only). Loaded once for every account this tick.
  const manageOff = new Set<string>();
  const goldBePips = new Map<string, number>();
  try {
    const acctIds = [...new Set(rows.map((r) => String(r.account_id)))];
    if (acctIds.length) {
      type AcctCfg = { account_id: string; manage_trades?: boolean | null; gold_be_pips?: number | null };
      let cfg: AcctCfg[] = [];
      const withGold = await admin.from("flow_broker_accounts").select("account_id, manage_trades, gold_be_pips").in("account_id", acctIds);
      if (!withGold.error) cfg = (withGold.data ?? []) as unknown as AcctCfg[];
      else {
        const fb = await admin.from("flow_broker_accounts").select("account_id, manage_trades").in("account_id", acctIds);
        cfg = (fb.data ?? []) as unknown as AcctCfg[];
      }
      for (const a of cfg) {
        if (a.manage_trades === false) manageOff.add(String(a.account_id));
        if (typeof a.gold_be_pips === "number" && a.gold_be_pips > 0) goldBePips.set(String(a.account_id), a.gold_be_pips);
      }
    }
  } catch { /* column missing / read blip → treat all as managed */ }

  const tokenCache = new Map<string, { token: string; env: TLEnv } | null>();
  const colCache = new Map<string, { avgIdx: number; uplIdx: number }>();
  const acctCache = new Map<string, { openIds: Set<string>; avgPx: Map<string, number>; upl: Map<string, number>; instruments: TLInstrument[] } | null>();
  const quoteCache = new Map<string, number | null>();

  const actions: ManageAction[] = [];

  async function tokenFor(connId: string): Promise<{ token: string; env: TLEnv } | null> {
    if (tokenCache.has(connId)) return tokenCache.get(connId)!;
    const t = await connectionToken(connId);
    const v = t.ok ? { token: t.token, env: t.env } : null;
    tokenCache.set(connId, v);
    return v;
  }

  // The broker returns positions as columnar arrays; the column ORDER comes from the account
  // config's positionsConfig. Read it once per connection to find the avgPrice (real fill)
  // and unrealizedPl columns — so we never hardcode a fragile index. Falls back to the
  // documented TradeLocker layout (avgPrice at index 5) if the config can't be parsed.
  async function colsFor(connId: string, tok: { token: string; env: TLEnv }, accNum: string): Promise<{ avgIdx: number; uplIdx: number }> {
    if (colCache.has(connId)) return colCache.get(connId)!;
    let v = { avgIdx: 5, uplIdx: -1 };
    try {
      const cfg = await getConfig(tok.env, tok.token, accNum);
      if (cfg.ok) {
        const d = ((cfg.data as Record<string, unknown>)?.d ?? cfg.data) as Record<string, unknown>;
        const raw = d?.positionsConfig as unknown;
        const cols = (Array.isArray(raw) ? raw : (raw as Record<string, unknown>)?.columns) as unknown[] | undefined;
        if (Array.isArray(cols) && cols.length) {
          const idOf = (c: unknown) => String((c as Record<string, unknown>)?.id ?? (c as Record<string, unknown>)?.key ?? (c as Record<string, unknown>)?.name ?? "");
          const ai = cols.findIndex((c) => idOf(c) === "avgPrice");
          const ui = cols.findIndex((c) => UPL_KEYS.includes(idOf(c)));
          if (ai >= 0) v = { avgIdx: ai, uplIdx: ui };
        }
      }
    } catch { /* keep defaults */ }
    colCache.set(connId, v);
    return v;
  }

  async function acctState(tok: { token: string; env: TLEnv }, accNum: string, accountId: string, cols: { avgIdx: number; uplIdx: number }) {
    const key = `${accountId}`;
    if (acctCache.has(key)) return acctCache.get(key)!;
    const pos = await listPositions(tok.env, tok.token, accNum, accountId);
    const inst = await listInstruments(tok.env, tok.token, accNum, accountId);
    const avgPx = new Map<string, number>();
    const upl = new Map<string, number>();
    if (pos.ok) for (const p of pos.data) {
      const id = posIdOf(p);
      if (!id) continue;
      const a = numAt(p, cols.avgIdx, AVG_KEYS); if (a != null && a > 0) avgPx.set(id, a);
      const u = numAt(p, cols.uplIdx, UPL_KEYS); if (u != null) upl.set(id, u);
    }
    const v = pos.ok && inst.ok
      ? { openIds: new Set(pos.data.map(posIdOf).filter(Boolean)), avgPx, upl, instruments: inst.data }
      : null;
    acctCache.set(key, v);
    return v;
  }

  // Current EXIT price for a side (bid for a long you'd sell, ask for a short you'd buy back)
  // — conservative, so break-even/partials can't fire off a stale/one-sided quote. Cached
  // per account+symbol for the tick.
  async function exitPrice(tok: { token: string; env: TLEnv }, accNum: string, inst: TLInstrument, symbol: string, side: "buy" | "sell", accountId: string): Promise<number | null> {
    const key = `${accountId}|${symbol}`;
    if (quoteCache.has(key)) return quoteCache.get(key)!;
    const q = await getQuote(tok.env, tok.token, accNum, inst.tradableInstrumentId, inst.infoRouteId || inst.routeId);
    let px: number | null = null;
    if (q.ok) {
      const bid = q.data.bid, ask = q.data.ask;
      px = side === "buy" ? (bid ?? ask) : (ask ?? bid);
    }
    if (px == null || !(px > 0)) px = await feedPrice(symbol);
    quoteCache.set(key, px);
    return px;
  }

  let managed = 0;
  for (const row of rows) {
    try {
      const tok = await tokenFor(row.connection_id);
      if (!tok) { await admin.from("flow_managed_positions").update({ last_error: "token", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const cols = await colsFor(row.connection_id, tok, row.acc_num);
      const st = await acctState(tok, row.acc_num, row.account_id, cols);
      if (!st) { await admin.from("flow_managed_positions").update({ last_error: "account_read", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      // Position gone from the broker → it closed (SL/TP hit, or member closed it). Require 3
      // consecutive misses before booking closed (a fresh fill / paginated read can omit one).
      if (!st.openIds.has(String(row.position_id))) {
        const goneN = (typeof row.last_error === "string" && row.last_error.startsWith("gone_")) ? (parseInt(row.last_error.slice(5)) || 0) : 0;
        if (goneN < 2) {
          await admin.from("flow_managed_positions").update({ last_error: `gone_${goneN + 1}`, updated_at: new Date().toISOString() }).eq("id", row.id);
          actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "gone_wait", detail: `${goneN + 1}/3` });
          continue;
        }
        let exitPx: number | null = null;
        const cinst = matchInstrument(contractKey(row.symbol), st.instruments) ?? matchInstrument(row.symbol, st.instruments);
        if (cinst) { try { exitPx = await exitPrice(tok, row.acc_num, cinst, row.symbol, row.side, row.account_id); } catch { /* fall back to recorded levels */ } }
        const oc = classifyOutcome(row, exitPx);
        await admin.from("flow_managed_positions").update({
          status: "closed", last_error: null,
          outcome: oc.outcome, result_pips: oc.result_pips, exit_price: oc.exit_price, partial_taken: oc.partial_taken,
          resolved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq("id", row.id);
        actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "closed", detail: `${oc.outcome} ${oc.result_pips>0?"+":""}${oc.result_pips}p` });
        continue;
      }

      const inst = matchInstrument(contractKey(row.symbol), st.instruments) ?? matchInstrument(row.symbol, st.instruments);
      if (!inst) { await admin.from("flow_managed_positions").update({ last_error: "no_instrument", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const price = await exitPrice(tok, row.acc_num, inst, row.symbol, row.side, row.account_id);
      if (price == null || !(price > 0)) { await admin.from("flow_managed_positions").update({ last_error: "no_quote", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const long = row.side === "buy";
      const pip = getInstrument(contractKey(row.symbol)).pipSize || 0.0001;
      const update: Record<string, unknown> = { last_error: null, updated_at: new Date().toISOString() };
      let didAction = false;

      // ── RE-ANCHOR TO THE REAL FILL. The row was recorded with the SIGNAL's entry, which is
      //    identical for every account — but each account fills at its OWN price. Anchoring
      //    break-even/partials to the signal price makes "break-even" a real loss and banks
      //    losers as wins. Trust the broker's average open price whenever it's available and
      //    within a sane band of the recorded entry; persist the correction so the math and the
      //    track record use the true entry. ──
      const brokerAvg = st.avgPx.get(String(row.position_id)) ?? null;
      let entry = row.entry;
      if (brokerAvg != null) {
        const band = Math.max(row.entry * 0.02, Math.abs(row.entry - row.init_stop) * 6);
        if (Math.abs(brokerAvg - row.entry) <= band) entry = brokerAvg;
      }
      if (Math.abs(entry - row.entry) > pip * 2) {
        const newR = Math.abs(entry - row.init_stop);
        update.entry = entry; update.r = newR;
        actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "reanchor", detail: `entry ${row.entry.toFixed(2)}→${entry.toFixed(2)}` });
        row.entry = entry; row.r = newR;
      }

      const R = row.r && row.r > 0 ? row.r : Math.abs(entry - row.init_stop);
      if (!(R > 0)) { await admin.from("flow_managed_positions").update({ last_error: "no_R", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      // FAVORABLE EXCURSION: the best price the trade actually reached (current sample + recent
      // 1-min candle extremes), so a spike that reversed inside the once-a-minute window still
      // counts toward the triggers.
      const ext = await feedExtremes(row.symbol);
      const favRaw = long
        ? Math.max(price, ext?.high && ext.high > 0 ? ext.high : price)
        : Math.min(price, ext?.low && ext.low > 0 ? ext.low : price);
      const bestPrev = row.best_price ?? entry;
      const best = long ? Math.max(bestPrev, favRaw) : Math.min(bestPrev, favRaw);
      update.best_price = best;

      const manageOn = !manageOff.has(String(row.account_id));

      // ── THE LEVELS ──────────────────────────────────────────────────────────────────────
      const tp = row.tp1 != null && row.tp1 > 0 ? row.tp1 : null;
      const towardTp = tp != null && (long ? tp > entry : tp < entry);
      const rr = towardTp ? Math.abs(tp! - entry) / R : 1;
      const isDouble = rr >= DOUBLE_RR;                       // 1:2 or wider → take a partial
      const halfway = towardTp ? (entry + tp!) / 2 : null;    // the "break-even point"

      // GOLD pips override (if set) moves break-even EARLIER than halfway. The floor keeps a
      // no-TP trade sane. Partial always uses the halfway-to-target point (1:2+ only).
      // Gold uses a break-even-pips trigger: the account's own override if set, else the gold
      // default — so every gold trade protects early, not only accounts with a custom value.
      const goldPips = contractKey(row.symbol) === "XAUUSD"
        ? (goldBePips.get(String(row.account_id)) ?? DEFAULT_GOLD_BE_PIPS)
        : undefined;
      const beByPips = typeof goldPips === "number" && goldPips > 0
        ? (long ? entry + goldPips * pip : entry - goldPips * pip)
        : null;
      const beFloor = long ? entry + BE_MIN_PIPS * pip : entry - BE_MIN_PIPS * pip;
      // Break-even trigger price = earliest of {gold-pips, halfway, +1R-fallback}, but never
      // closer to entry than the small floor.
      const beCandidates = [beByPips, halfway, long ? entry + R : entry - R].filter((x): x is number => x != null);
      let beTriggerPx = long ? Math.min(...beCandidates) : Math.max(...beCandidates);
      beTriggerPx = long ? Math.max(beTriggerPx, beFloor) : Math.min(beTriggerPx, beFloor);
      const partialTriggerPx = halfway;

      // Compare against BEST (the furthest the trade has EVER reached), not this tick's momentary
      // favRaw — otherwise a move that hit the trigger and ticked back before the once-a-minute
      // sample is missed and break-even never fires even though best_price recorded it.
      const favReachedBE = long ? best >= beTriggerPx : best <= beTriggerPx;
      const favReachedPartial = partialTriggerPx != null && (long ? best >= partialTriggerPx : best <= partialTriggerPx);

      // HARD PROFIT GUARD — broker's own truth. Prefer the position's unrealized P&L; else fall
      // back to price beyond the real fill. We NEVER move to break-even or bank a partial unless
      // this is satisfied, so a "partial" can never execute at a loss.
      const brokerUpl = st.upl.get(String(row.position_id)) ?? null;
      const priceInProfit = long ? price > entry : price < entry;
      const inProfit = brokerUpl != null ? brokerUpl > 0 : priceInProfit;
      const bePx = roundPx(row.symbol, entry);

      // ── STEP 1: BREAK-EVEN — move the stop to the entry. Only while genuinely in profit and
      //    with the market still beyond entry (so the stop isn't rejected / isn't a loss). ──
      if (manageOn && !row.be_done && favReachedBE && inProfit && priceInProfit) {
        const mv = await modifyPosition(tok.env, tok.token, row.acc_num, row.position_id, { stopLoss: bePx });
        if (mv.ok) { update.be_done = true; update.cur_stop = bePx; didAction = true; actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "breakeven", detail: `SL→entry ${bePx}` }); }
        else { update.last_error = `be_err: ${mv.error}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "be_err", detail: mv.error.slice(0, 60) }); }
      }

      // ── STEP 2: PARTIAL — 1:2 or wider only, 50% at the halfway-to-target point. Gated on the
      //    same in-profit guard, so it can only ever bank a WIN. ──
      if (manageOn && isDouble && !row.partial_done && favReachedPartial && inProfit && priceInProfit) {
        const half = normalizeQuantity(contractKey(row.symbol), row.qty * 0.5, { quantityStep: inst.quantityStep, minQuantity: inst.minQuantity });
        if (half.ok && half.qty > 0 && half.qty < row.qty) {
          const cl = await closePosition(tok.env, tok.token, row.acc_num, row.position_id, half.qty);
          if (cl.ok) { update.partial_done = true; update.qty = +(row.qty - half.qty).toFixed(6); didAction = true; actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "partial", detail: `−${half.qty} @${(rr).toFixed(1)}R` }); }
          else { update.last_error = `partial_err: ${cl.error}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "partial_err", detail: cl.error.slice(0, 60) }); }
        }
      }

      // ── STEP 3: TRAIL — runner only. After break-even (and, on a 1:2, after the partial),
      //    ratchet the stop up behind the best price the trade has reached. Anchored to the
      //    real fill + the favorable excursion; tightens near the target; never below break-
      //    even and never through the current market. ──
      if (manageOn && row.be_done && (!isDouble || row.partial_done)) {
        const peakR = (long ? best - entry : entry - best) / R;
        const toTargetR = tp != null ? (long ? tp - best : best - tp) / R : 99;
        const partialR = halfway != null ? (long ? halfway - entry : entry - halfway) / R : 1;
        const near = toTargetR <= NEAR_TP_R || peakR >= partialR - NEAR_PARTIAL_R;
        const givebackR = near ? GIVEBACK_NEAR_R : GIVEBACK_R;
        let candidate = roundPx(row.symbol, long ? best - givebackR * R : best + givebackR * R);
        // Never through the current market (broker rejects it, and `best` may be a spike the
        // price has pulled back from) — cap a small buffer inside the current price.
        const trailBuf = Math.max(R * 0.1, pip * 2);
        candidate = long ? Math.min(candidate, roundPx(row.symbol, price - trailBuf)) : Math.max(candidate, roundPx(row.symbol, price + trailBuf));
        candidate = long ? Math.max(candidate, bePx) : Math.min(candidate, bePx); // never below BE
        const cur = row.cur_stop ?? bePx;
        const eps = R * 0.05; // don't spam the broker on sub-5%-of-R nudges
        const improved = long ? candidate > cur + eps : candidate < cur - eps;
        if (improved) {
          const mv = await modifyPosition(tok.env, tok.token, row.acc_num, row.position_id, { stopLoss: candidate });
          if (mv.ok) { update.cur_stop = candidate; didAction = true; actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail", detail: `SL→${candidate} gb${givebackR}R` }); }
          else { update.last_error = `trail_err: ${mv.error}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail_err", detail: mv.error.slice(0, 60) }); }
        }
      }

      if (!didAction) {
        const profit = long ? price - entry : entry - price;
        actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: manageOn ? "watching" : "unmanaged", detail: `${(profit / R).toFixed(2)}R` });
      }

      await admin.from("flow_managed_positions").update(update).eq("id", row.id);
      if (didAction) managed += 1;
    } catch (e) {
      try { await admin.from("flow_managed_positions").update({ last_error: (e instanceof Error ? e.message : "error").slice(0, 120), updated_at: new Date().toISOString() }).eq("id", row.id); } catch { /* ignore */ }
    }
  }

  return { managed, actions };
}
