import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { listPositions } from "@/lib/flow/tradelocker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * READ-ONLY diagnostic for the trade manager. Owner-gated. Places/modifies/closes
 * NOTHING — it only reads the flow_managed_positions ledger and (with ?live=1) asks
 * each account's broker which positions are actually open, so we can see WHY a
 * managed position isn't being break-even'd / partialed:
 *   • is the DB row still status='open', or did the manager mark it 'closed'?
 *   • last_error on the row (token / account_read / no_quote / no_R / be_err …)
 *   • does the broker actually still hold that position id under that acc_num?
 */
const MASTER = "3b5e06e5-258c-4880-b1f2-d1623cbca100";
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o, null, 2), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function posId(p: unknown): string {
  if (Array.isArray(p)) return p.length ? String(p[0]) : "";
  if (p && typeof p === "object") { const o = p as Record<string, unknown>; const v = o.id ?? o.positionId ?? o.positionID; return v == null ? "" : String(v); }
  return "";
}

export async function GET(req: NextRequest) {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || user.id !== MASTER) return json({ error: "forbidden" }, 403);
  }
  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 200);

  const sp = req.nextUrl.searchParams;
  const idsParam = (sp.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const live = sp.get("live") === "1";
  const includeDemo = sp.get("all") === "1";   // demo accounts are hidden by default; ?all=1 shows them

  // Recent managed positions (any status) — target specific ids if given, else the
  // last 24h of gold, so we can see the Crucial vs Genesis rows side by side.
  let q = admin.from("flow_managed_positions")
    .select("position_id, user_id, account_id, acc_num, connection_id, symbol, side, qty, status, be_done, partial_done, entry, init_stop, cur_stop, tp1, last_error, environment, created_at, updated_at")
    .order("created_at", { ascending: false }).limit(60);
  if (idsParam.length) q = q.in("position_id", idsParam);
  else q = q.eq("symbol", "XAUUSD").gte("created_at", new Date(Date.now() - 24 * 3600e3).toISOString());
  if (!includeDemo) q = q.neq("environment", "demo");   // LIVE-ONLY by default
  const { data: rows } = await q;
  const tracked = (rows ?? []) as Record<string, unknown>[];

  const out: Record<string, unknown> = { count: tracked.length, tracked };

  if (live) {
    // For each distinct account in the set, ask the broker what's actually open.
    const byAcct = new Map<string, { connection_id: string; account_id: string; acc_num: string }>();
    for (const r of tracked) byAcct.set(String(r.account_id), { connection_id: String(r.connection_id), account_id: String(r.account_id), acc_num: String(r.acc_num) });
    const broker: Record<string, unknown>[] = [];
    for (const a of byAcct.values()) {
      try {
        const t = await connectionToken(a.connection_id);
        if (!t.ok) { broker.push({ account_id: a.account_id, acc_num: a.acc_num, error: `token: ${t.error}` }); continue; }
        const pp = await listPositions(t.env, t.token, a.acc_num, a.account_id);
        if (!pp.ok) { broker.push({ account_id: a.account_id, acc_num: a.acc_num, error: `listPositions: ${pp.error}` }); continue; }
        broker.push({ account_id: a.account_id, acc_num: a.acc_num, openCount: pp.data.length, openIds: pp.data.map(posId).filter(Boolean) });
      } catch (e) {
        broker.push({ account_id: a.account_id, acc_num: a.acc_num, error: e instanceof Error ? e.message.slice(0, 120) : "error" });
      }
    }
    out.broker = broker;
    // Cross-check: for each tracked row, is its position_id present at its own account?
    out.check = tracked.map((r) => {
      const b = broker.find((x) => x.account_id === String(r.account_id)) as { openIds?: string[] } | undefined;
      const present = !!b?.openIds?.includes(String(r.position_id));
      return { position_id: r.position_id, acc_num: r.acc_num, status: r.status, be_done: r.be_done, partial_done: r.partial_done, last_error: r.last_error, brokerHasIt: present };
    });
  }

  return json(out);
}
