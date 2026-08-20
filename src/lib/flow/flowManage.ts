import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { matchInstrument } from "@/lib/flow/executor";
import { normalizeQuantity, getInstrument } from "@/lib/flow/instruments";
import { contractKey } from "@/lib/flow/sizing";
import { listInstruments, listPositions, getQuote, modifyPosition, closePosition, type TLEnv, type TLInstrument } from "@/lib/flow/tradelocker";

/**
 * FLOW AUTO TRADE-MANAGER (server-only).
 *
 * After a fill, a pro doesn't just set-and-forget — they protect the trade and
 * bank into strength. This runs that playbook automatically on every position
 * FLOW opened (recorded in flow_managed_positions by executor.placeOnActiveAccounts):
 *
 *   Phase 1 — at +1R (price has moved its own initial risk distance in profit):
 *     • move the STOP to break-even (entry), so the trade can no longer lose, AND
 *     • take a 50% PARTIAL, banking profit and de-risking the position.
 *   Phase 2 — after break-even is done, TRAIL the runner's stop 1R behind the
 *     best price it has reached (ratchet only — a long's stop never drops, a
 *     short's never rises), letting a winner run while locking in more each push.
 *
 * It reads the live broker quote per position, and detects a position that has
 * closed (SL/TP hit or the member closed it) and marks it done. This is a
 * value-add safety layer — it is NOT gated by credits, and it never OPENS a new
 * position, only protects/scales ones already open. All broker writes go through
 * the confirmed TradeLocker modify/close endpoints.
 */

export type ManagedRow = {
  id: string; user_id: string; connection_id: string; account_id: string; acc_num: string; environment: string;
  position_id: string; symbol: string; side: "buy" | "sell";
  entry: number; init_stop: number; tp1: number | null; r: number; qty: number;
  cur_stop: number | null; best_price: number | null; be_done: boolean | null; partial_done: boolean | null; status: string;
};

export type ManageAction = { positionId: string; symbol: string; account: string; action: string; detail?: string };
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

// Max positions to touch per tick (backstop; the manager runs every ~30s).
const MAX_PER_TICK = 300;

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

/** Round a stop price to the instrument's own precision so the broker accepts it. */
function roundPx(symbol: string, price: number): number {
  const prec = getInstrument(contractKey(symbol)).pricePrecision ?? 2;
  return +price.toFixed(prec);
}

/**
 * Manage every OPEN position FLOW is tracking: break-even + 50% partial at +1R,
 * then trail the runner 1R behind its best price. Returns a per-position summary.
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

  // One fresh token per connection; one instrument list + positions list + quote
  // cache per account — so N positions on one account cost one round-trip each.
  const tokenCache = new Map<string, { token: string; env: TLEnv } | null>();
  const acctCache = new Map<string, { openIds: Set<string>; instruments: TLInstrument[] } | null>();
  const quoteCache = new Map<string, number | null>(); // key: acctKey|symbol → exit price

  const actions: ManageAction[] = [];

  async function tokenFor(connId: string): Promise<{ token: string; env: TLEnv } | null> {
    if (tokenCache.has(connId)) return tokenCache.get(connId)!;
    const t = await connectionToken(connId);
    const v = t.ok ? { token: t.token, env: t.env } : null;
    tokenCache.set(connId, v);
    return v;
  }

  async function acctState(tok: { token: string; env: TLEnv }, accNum: string, accountId: string) {
    const key = `${accountId}`;
    if (acctCache.has(key)) return acctCache.get(key)!;
    const pos = await listPositions(tok.env, tok.token, accNum, accountId);
    const inst = await listInstruments(tok.env, tok.token, accNum, accountId);
    const v = pos.ok && inst.ok
      ? { openIds: new Set(pos.data.map(posIdOf).filter(Boolean)), instruments: inst.data }
      : null;
    acctCache.set(key, v);
    return v;
  }

  // Current EXIT price for a side (bid for a long you'd sell, ask for a short you'd
  // buy back) — conservative, so break-even/trail can't fire off a stale/one-sided
  // quote. Cached per account+symbol for the tick.
  async function exitPrice(tok: { token: string; env: TLEnv }, accNum: string, inst: TLInstrument, symbol: string, side: "buy" | "sell", accountId: string): Promise<number | null> {
    const key = `${accountId}|${symbol}`;
    if (quoteCache.has(key)) return quoteCache.get(key)!;
    const q = await getQuote(tok.env, tok.token, accNum, inst.tradableInstrumentId, inst.infoRouteId || inst.routeId);
    let px: number | null = null;
    if (q.ok) {
      const bid = q.data.bid, ask = q.data.ask;
      px = side === "buy" ? (bid ?? ask) : (ask ?? bid);
    }
    quoteCache.set(key, px);
    return px;
  }

  let managed = 0;
  for (const row of rows) {
    try {
      const tok = await tokenFor(row.connection_id);
      if (!tok) { await admin.from("flow_managed_positions").update({ last_error: "token", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const st = await acctState(tok, row.acc_num, row.account_id);
      if (!st) { await admin.from("flow_managed_positions").update({ last_error: "account_read", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      // Position gone from the broker → it closed (SL/TP hit, or member closed it).
      if (!st.openIds.has(String(row.position_id))) {
        await admin.from("flow_managed_positions").update({ status: "closed", last_error: null, updated_at: new Date().toISOString() }).eq("id", row.id);
        actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "closed" });
        continue;
      }

      const inst = matchInstrument(contractKey(row.symbol), st.instruments) ?? matchInstrument(row.symbol, st.instruments);
      if (!inst) { await admin.from("flow_managed_positions").update({ last_error: "no_instrument", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const price = await exitPrice(tok, row.acc_num, inst, row.symbol, row.side, row.account_id);
      if (price == null || !(price > 0)) { await admin.from("flow_managed_positions").update({ last_error: "no_quote", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const long = row.side === "buy";
      const R = row.r && row.r > 0 ? row.r : Math.abs(row.entry - row.init_stop);
      if (!(R > 0)) { await admin.from("flow_managed_positions").update({ last_error: "no_R", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const profit = long ? price - row.entry : row.entry - price;
      const bestPrev = row.best_price ?? row.entry;
      const best = long ? Math.max(bestPrev, price) : Math.min(bestPrev, price);
      const update: Record<string, unknown> = { best_price: best, last_error: null, updated_at: new Date().toISOString() };
      let didAction = false;

      if (!row.be_done) {
        // ── Phase 1: reached +1R → break-even stop + 50% partial. ──
        if (profit >= R) {
          const bePx = roundPx(row.symbol, row.entry);
          const mv = await modifyPosition(tok.env, tok.token, row.acc_num, row.position_id, { stopLoss: bePx });
          // Partial: close half the CURRENT lots (broker-rounded); keep the runner.
          const half = normalizeQuantity(contractKey(row.symbol), row.qty * 0.5, { quantityStep: inst.quantityStep, minQuantity: inst.minQuantity });
          let remaining = row.qty;
          let partialNote = "no_partial";
          if (half.ok && half.qty > 0 && half.qty < row.qty) {
            const cl = await closePosition(tok.env, tok.token, row.acc_num, row.position_id, half.qty);
            if (cl.ok) { remaining = +(row.qty - half.qty).toFixed(6); partialNote = `−${half.qty}`; }
            else partialNote = `partial_err:${cl.error}`.slice(0, 60);
          }
          update.be_done = true;
          update.partial_done = true;
          update.cur_stop = bePx;
          update.qty = remaining;
          didAction = true;
          actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: mv.ok ? "breakeven+partial" : "partial_only", detail: `${mv.ok ? "SL→BE" : "SL_err:" + mv.error} ${partialNote}`.slice(0, 90) });
        } else {
          actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "watching", detail: `${(profit / R).toFixed(2)}R` });
        }
      } else {
        // ── Phase 2: runner — trail the stop 1R behind the best price (ratchet). ──
        const candidate = roundPx(row.symbol, long ? best - R : best + R);
        const cur = row.cur_stop ?? (long ? row.entry : row.entry);
        const eps = R * 0.05; // don't spam the broker on sub-5%-of-R nudges
        const improved = long ? candidate > cur + eps : candidate < cur - eps;
        if (improved) {
          const mv = await modifyPosition(tok.env, tok.token, row.acc_num, row.position_id, { stopLoss: candidate });
          if (mv.ok) { update.cur_stop = candidate; didAction = true; actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail", detail: `SL→${candidate}` }); }
          else actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail_err", detail: mv.error.slice(0, 60) });
        } else {
          actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "runner_hold", detail: `${(profit / R).toFixed(2)}R` });
        }
      }

      await admin.from("flow_managed_positions").update(update).eq("id", row.id);
      if (didAction) managed += 1;
    } catch (e) {
      try { await admin.from("flow_managed_positions").update({ last_error: (e instanceof Error ? e.message : "error").slice(0, 120), updated_at: new Date().toISOString() }).eq("id", row.id); } catch { /* ignore */ }
    }
  }

  return { managed, actions };
}
