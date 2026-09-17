/**
 * MEMBER TRADE CONTROLS (owner 09-17): from the live trade card a member can, on THEIR OWN open GENX gold
 * trades, (1) close the trade, (2) take a partial (half), or (3) move the stop to break-even. Each action is
 * sent to TradeLocker per account.
 *
 * Safety rules:
 * - Only the signed-in member's own ledger rows; the connection must belong to that member.
 * - Nothing ever adds risk: break-even only TIGHTENS a stop (never widens it), lands +5 pips in profit so fees
 *   are covered, and only fires once price is past it; partial and close only reduce size. TP is never touched.
 * - Partial uses the same lifetime reservation as the trade manager (flow_partial_operations), so a double tap
 *   or a manager partial can never close a second slice.
 * - A position the broker no longer lists is skipped (already closed). The trade manager books the final
 *   outcome from broker history as usual (a hand close is graded 'manual' → Self manage).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { normalizeQuantity } from "@/lib/flow/instruments";
import { listPositions, modifyPosition, closePosition, withBrokerPriority } from "@/lib/flow/tradelocker";
import { logTrade } from "@/lib/flow/tradeLog";
import { feedPrice } from "@/lib/flow/feedPrice";

export type MemberAction = "close" | "partial" | "breakeven";
export const MEMBER_ACTIONS: MemberAction[] = ["close", "partial", "breakeven"];
export const PARTIAL_SHARE = 0.5;

type Row = {
  id: string; user_id: string; connection_id: string; account_id: string; acc_num: string; environment: string | null;
  position_id: string; side: string; entry: number | string; cur_stop: number | string | null; qty: number | string | null;
  be_done: boolean | null; partial_done: boolean | null;
};
export type ActionResult = { account: string; ok: boolean; message: string };

/** Break-even stop for a position, or why not. Pure (unit-tested).
 *  BE IS SET +5 PIPS IN PROFIT, NEVER AT THE RAW ENTRY (owner 09-17): at the exact entry a stop-out still
 *  costs the spread and commission, so the member ends red on a "break-even". Gold pip = $0.10, so the stop
 *  goes entry ± $0.50, and price must be at least 10 pips past entry first, so the stop is never asked for
 *  on the wrong side of the market (the broker would reject it). */
export const BE_PROFIT_PIPS = 5;
export const GOLD_PIP = 0.1;
export function breakEvenPlan(side: string, entry: number, curStop: number | null, price: number | null): { ok: true; stop: number } | { ok: false; why: string } {
  const long = side.toLowerCase() === "buy";
  if (!(entry > 0)) return { ok: false, why: "No entry price on record" };
  const lock = BE_PROFIT_PIPS * GOLD_PIP;                    // $0.50 = 5 pips of gold
  const stop = +(long ? entry + lock : entry - lock).toFixed(2);
  if (curStop != null && (long ? curStop >= stop - 1e-6 : curStop <= stop + 1e-6)) return { ok: false, why: "Stop is already at break-even or better" };
  if (price == null) return { ok: false, why: "No live price — try again in a moment" };
  if (long ? price < stop + lock : price > stop - lock) return { ok: false, why: `Needs ${BE_PROFIT_PIPS * 2} pips of profit first` };
  return { ok: true, stop };
}

/** Lots to close for a partial, or why not. Pure (unit-tested). */
export function partialPlan(qty: number | null, alreadyDone: boolean): { ok: true; close: number } | { ok: false; why: string } {
  if (alreadyDone) return { ok: false, why: "Partial already taken on this trade" };
  if (!(qty != null && qty > 0)) return { ok: false, why: "Position size unknown" };
  const part = normalizeQuantity("XAUUSD", qty * PARTIAL_SHARE);
  if (!part.ok || !(part.qty > 0) || part.qty >= qty) return { ok: false, why: "Too small to split (minimum lot)" };
  return { ok: true, close: part.qty };
}

const posIdOf = (p: unknown): string => {
  if (Array.isArray(p)) return p.length ? String(p[0]) : "";
  if (p && typeof p === "object") { const o = p as Record<string, unknown>; const v = o.id ?? o.positionId; return v == null ? "" : String(v); }
  return "";
};

export async function runMemberAction(userId: string, action: MemberAction): Promise<{ ok: boolean; results: ActionResult[]; error?: string }> {
  const admin = createAdminClient();
  if (!admin) return { ok: false, results: [], error: "not_configured" };
  const { data, error } = await admin.from("flow_managed_positions")
    .select("id,user_id,connection_id,account_id,acc_num,environment,position_id,side,entry,cur_stop,qty,be_done,partial_done")
    .eq("user_id", userId).eq("symbol", "XAUUSD").eq("status", "open").order("created_at", { ascending: false }).limit(50);
  if (error) return { ok: false, results: [], error: "load_failed" };
  const seen = new Set<string>();
  const rows = ((data ?? []) as Row[]).filter((r) => { const k = `${r.account_id}|${r.position_id}`; if (!r.position_id || seen.has(k)) return false; seen.add(k); return true; });
  if (!rows.length) return { ok: false, results: [], error: "no_open_trade" };

  // Every connection used must belong to this member.
  const connIds = [...new Set(rows.map((r) => r.connection_id))];
  const { data: conns } = await admin.from("flow_broker_connections").select("id,user_id").in("id", connIds);
  const owned = new Set(((conns ?? []) as { id: string; user_id: string }[]).filter((c) => c.user_id === userId).map((c) => c.id));

  const price = action === "breakeven" ? await feedPrice("XAUUSD") : null;
  const byConn = new Map<string, Row[]>();
  for (const r of rows) { if (!byConn.has(r.connection_id)) byConn.set(r.connection_id, []); byConn.get(r.connection_id)!.push(r); }

  const results: ActionResult[] = [];
  await Promise.all([...byConn.entries()].map(([connId, list]) => withBrokerPriority("critical", async () => {
    const label = (r: Row) => `#${r.acc_num || r.account_id}`;
    if (!owned.has(connId)) { for (const r of list) results.push({ account: label(r), ok: false, message: "Not your connection" }); return; }
    const tok = await connectionToken(connId);
    if (!tok.ok) { for (const r of list) results.push({ account: label(r), ok: false, message: "Couldn't log in to the broker" }); return; }
    const openByAcct = new Map<string, Set<string> | null>();
    for (const r of list) {                                   // serial within one login (broker rate limits)
      if (!openByAcct.has(r.account_id)) {
        const pos = await listPositions(tok.env, tok.token, r.acc_num, r.account_id);
        openByAcct.set(r.account_id, pos.ok ? new Set(pos.data.map(posIdOf)) : null);
      }
      const open = openByAcct.get(r.account_id);
      if (open == null) { results.push({ account: label(r), ok: false, message: "Couldn't read the account — try again" }); continue; }
      if (!open.has(String(r.position_id))) { results.push({ account: label(r), ok: true, message: "Already closed" }); continue; }
      const base = { position_id: r.position_id, account_id: r.account_id, user_id: userId, symbol: "XAUUSD" };

      if (action === "close") {
        const c = await closePosition(tok.env, tok.token, r.acc_num, r.position_id);
        results.push({ account: label(r), ok: c.ok, message: c.ok ? "Closed" : c.error });
        await logTrade(admin, { ...base, phase: c.ok ? "member_close" : "member_close_err", reason: c.ok ? "card" : c.error.slice(0, 80) });
        if (c.ok) await admin.from("flow_managed_positions").update({ last_error: "member_close_sent", updated_at: new Date().toISOString() }).eq("id", r.id);
        continue;
      }

      if (action === "breakeven") {
        const plan = breakEvenPlan(r.side, Number(r.entry), r.cur_stop == null ? null : Number(r.cur_stop), price);
        if (!plan.ok) { results.push({ account: label(r), ok: plan.why.startsWith("Stop is already"), message: plan.why }); continue; }
        const m = await modifyPosition(tok.env, tok.token, r.acc_num, r.position_id, { stopLoss: plan.stop });
        const already = !m.ok && /nothing\s+to\s+change/i.test(m.error);
        if (m.ok || already) await admin.from("flow_managed_positions").update({ be_done: true, cur_stop: plan.stop, updated_at: new Date().toISOString() }).eq("id", r.id);
        results.push({ account: label(r), ok: m.ok || already, message: m.ok || already ? `Stop moved to ${plan.stop} (+${BE_PROFIT_PIPS} pips)` : m.error });
        await logTrade(admin, { ...base, phase: m.ok || already ? "member_break_even" : "member_break_even_err", reason: m.ok ? "card" : m.error.slice(0, 80), price: plan.stop });
        continue;
      }

      // partial
      const qty = r.qty == null ? null : Number(r.qty);
      const plan = partialPlan(qty, !!r.partial_done);
      if (!plan.ok) { results.push({ account: label(r), ok: false, message: plan.why }); continue; }
      const identity = { environment: r.environment === "live" ? "live" : "demo", account_id: String(r.account_id), position_id: String(r.position_id) };
      const ins = await admin.from("flow_partial_operations").insert({ ...identity, before_qty: qty, requested_qty: plan.close });
      if (ins.error) { results.push({ account: label(r), ok: false, message: ins.error.code === "23505" ? "Partial already taken on this trade" : "Couldn't reserve the partial — try again" }); continue; }
      const c = await closePosition(tok.env, tok.token, r.acc_num, r.position_id, plan.close);
      if (c.ok) await admin.from("flow_managed_positions").update({ partial_done: true, qty: +((qty as number) - plan.close).toFixed(2), updated_at: new Date().toISOString() }).eq("id", r.id);
      results.push({ account: label(r), ok: c.ok, message: c.ok ? `Closed ${plan.close} lots` : c.error });
      await logTrade(admin, { ...base, phase: c.ok ? "member_partial" : "member_partial_err", reason: c.ok ? "card" : c.error.slice(0, 80), qty: plan.close });
    }
  })));
  return { ok: results.some((x) => x.ok), results };
}
