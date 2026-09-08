import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { listAccounts } from "@/lib/flow/tradelocker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * COMMUNITY P&L (owner 09-07: "I want to be able to track my community and who's up
 * the most"). Admin-only. For every broker account members have connected:
 *   • pulls LIVE equity + balance from TradeLocker (one token + one listAccounts call
 *    per connection, fanned out with bounded concurrency),
 *   • snapshots today's first-seen equity into flow_equity_snapshots (one row per
 *    account per UTC day — the baseline that makes Today/7d/30d deltas honest),
 *   • sums the desk's own closed gold trades per account from the ledger (est. USD),
 *   • returns everything ranked, with community totals.
 * Equity deltas capture EVERYTHING that happened on the account (desk trades, the
 * member's own manual trades, deposits/withdrawals — a deposit looks like a gain, which
 * is why the desk-trades column is shown alongside). Accounts whose connection is
 * offline fall back to their last snapshot and are flagged.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

type AcctRow = { user_id: string; account_id: string; acc_num: string | null; connection_id: string; autotrade_enabled: boolean | null; genx_follower: boolean | null; send_it: boolean | null };
type Snap = { account_id: string; equity: number | null; day: string };

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_found" }, 404);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "not_found" }, 404);
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return json({ error: "not_found" }, 404);
  const admin = createAdminClient();
  if (!admin) return json({ error: "service_unavailable" }, 500);

  // 1) Every connected account + the owner's name for each.
  const { data: acctsRaw } = await admin
    .from("flow_broker_accounts")
    .select("user_id, account_id, acc_num, connection_id, autotrade_enabled, genx_follower, send_it")
    .limit(500);
  const accts = (acctsRaw ?? []) as AcctRow[];
  if (!accts.length) return json({ ok: true, rows: [], totals: null }, 200);

  const userIds = [...new Set(accts.map((a) => a.user_id))];
  const { data: profs } = await admin.from("profiles").select("id, full_name, email").in("id", userIds);
  const nameOf = new Map((profs ?? []).map((p: { id: string; full_name: string | null; email: string | null }) => [p.id, p.full_name || p.email || "member"]));

  // 2) Live equity per account: one token + one listAccounts per CONNECTION, ≤6 in flight.
  const byConn = new Map<string, AcctRow[]>();
  for (const a of accts) { const arr = byConn.get(a.connection_id) ?? []; arr.push(a); byConn.set(a.connection_id, arr); }
  const live = new Map<string, { equity: number | null; balance: number | null }>();
  const offline = new Set<string>(); // connection_ids we couldn't reach
  const connIds = [...byConn.keys()];
  let idx = 0;
  async function worker() {
    while (idx < connIds.length) {
      const connId = connIds[idx++];
      try {
        const tok = await connectionToken(connId);
        if (!tok.ok) { offline.add(connId); continue; }
        const res = await listAccounts(tok.env, tok.token);
        if (!res.ok) { offline.add(connId); continue; }
        const wanted = new Set((byConn.get(connId) ?? []).map((a) => String(a.account_id)));
        for (const x of res.data) {
          const id = String(x.accountId);
          if (wanted.has(id)) live.set(id, { equity: x.equity ?? x.balance ?? null, balance: x.balance ?? x.equity ?? null });
        }
      } catch { offline.add(connId); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, connIds.length) }, () => worker()));

  // 3) Snapshot today's baseline (first sight of the day wins; conflicts ignored).
  const today = new Date().toISOString().slice(0, 10);
  const snapRows = accts
    .filter((a) => live.get(String(a.account_id))?.equity != null)
    .map((a) => ({ account_id: String(a.account_id), user_id: a.user_id, acc_num: a.acc_num, equity: live.get(String(a.account_id))!.equity, balance: live.get(String(a.account_id))!.balance, day: today }));
  if (snapRows.length) { try { await admin.from("flow_equity_snapshots").upsert(snapRows, { onConflict: "account_id,day", ignoreDuplicates: true }); } catch { /* baselines are best-effort */ } }

  // 4) Historical baselines: oldest snapshot within each window per account.
  const since30 = new Date(Date.now() - 31 * 86400_000).toISOString().slice(0, 10);
  const { data: snapsRaw } = await admin
    .from("flow_equity_snapshots")
    .select("account_id, equity, day")
    .gte("day", since30)
    .order("day", { ascending: true })
    .limit(20000);
  const snaps = (snapsRaw ?? []) as Snap[];
  const d7cut = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const base = new Map<string, { today?: number; d7?: number; d30?: number; last?: number }>();
  for (const s of snaps) {
    if (s.equity == null) continue;
    const b = base.get(s.account_id) ?? {};
    if (b.d30 === undefined) b.d30 = s.equity;                    // oldest in 30d window
    if (b.d7 === undefined && s.day >= d7cut) b.d7 = s.equity;    // oldest in 7d window
    if (s.day === today && b.today === undefined) b.today = s.equity;
    b.last = s.equity;                                            // newest seen (fallback for offline)
    base.set(s.account_id, b);
  }

  // 5) Desk trades per account from the ledger (gold est.: pips × lots × $10).
  const { data: ledger } = await admin
    .from("flow_managed_positions")
    .select("account_id, result_pips, qty, resolved_at")
    .eq("status", "closed").in("symbol", ["XAUUSD", "GOLD"])
    .gte("resolved_at", new Date(Date.now() - 30 * 86400_000).toISOString())
    .limit(20000);
  const deskToday = new Map<string, number>(); const desk30 = new Map<string, number>(); const trades30 = new Map<string, number>();
  const todayStartMs = Date.parse(`${today}T00:00:00Z`);
  for (const r of (ledger ?? []) as Array<{ account_id: string; result_pips: number | null; qty: number | null; resolved_at: string | null }>) {
    const usd = (r.result_pips ?? 0) * (r.qty ?? 0) * 10;
    const k = String(r.account_id);
    desk30.set(k, (desk30.get(k) ?? 0) + usd);
    trades30.set(k, (trades30.get(k) ?? 0) + 1);
    if (r.resolved_at && Date.parse(r.resolved_at) >= todayStartMs) deskToday.set(k, (deskToday.get(k) ?? 0) + usd);
  }

  // 6) Assemble + rank by today's equity gain.
  const rows = accts.map((a) => {
    const id = String(a.account_id);
    const lv = live.get(id);
    const b = base.get(id) ?? {};
    const equity = lv?.equity ?? b.last ?? null;
    const connected = lv?.equity != null;
    const pnlToday = equity != null && b.today != null ? +(equity - b.today).toFixed(2) : null;
    const pnl7 = equity != null && b.d7 != null ? +(equity - b.d7).toFixed(2) : null;
    const pnl30 = equity != null && b.d30 != null ? +(equity - b.d30).toFixed(2) : null;
    return {
      userId: a.user_id, member: nameOf.get(a.user_id) ?? "member", accNum: a.acc_num,
      equity, balance: lv?.balance ?? null, connected,
      pnlToday, pnl7, pnl30,
      deskToday: +(deskToday.get(id) ?? 0).toFixed(2), desk30: +(desk30.get(id) ?? 0).toFixed(2), trades30: trades30.get(id) ?? 0,
      autotrade: a.autotrade_enabled === true, follower: a.genx_follower === true, sendIt: a.send_it === true,
    };
  }).sort((x, y) => (y.pnlToday ?? -Infinity) - (x.pnlToday ?? -Infinity));

  const sum = (f: (r: typeof rows[number]) => number | null) => +rows.reduce((s, r) => s + (f(r) ?? 0), 0).toFixed(2);
  const totals = {
    accounts: rows.length, connected: rows.filter((r) => r.connected).length,
    equity: sum((r) => r.equity), pnlToday: sum((r) => r.pnlToday), pnl7: sum((r) => r.pnl7), pnl30: sum((r) => r.pnl30),
    deskToday: sum((r) => r.deskToday), desk30: sum((r) => r.desk30),
  };
  return json({ ok: true, asOf: new Date().toISOString(), rows, totals }, 200);
}
