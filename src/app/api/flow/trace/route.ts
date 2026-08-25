import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * PER-TRADE FLIGHT RECORDER (admin-only, READ-ONLY).
 *
 * Returns the full timestamped lifecycle timeline for a trade from flow_trade_log:
 *   /api/flow/trace?position_id=<id>    one trade's timeline
 *   /api/flow/trace?account_id=<id>     recent events for an account (default 200)
 *   /api/flow/trace                     the 200 most recent events across the desk
 * Each row: at, phase, reason, price, qty, detail. Changes nothing.
 */
const MASTER = "3b5e06e5-258c-4880-b1f2-d1623cbca100";
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o, null, 2), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
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
  const positionId = (sp.get("position_id") || "").trim();
  const accountId = (sp.get("account_id") || "").trim();
  const limit = Math.min(Math.max(parseInt(sp.get("limit") || "200") || 200, 1), 1000);

  let q = admin.from("flow_trade_log")
    .select("at, position_id, account_id, symbol, phase, reason, price, qty, detail")
    .order("at", { ascending: true }).limit(limit);
  if (positionId) q = q.eq("position_id", positionId);
  else if (accountId) q = admin.from("flow_trade_log")
    .select("at, position_id, account_id, symbol, phase, reason, price, qty, detail")
    .eq("account_id", accountId).order("at", { ascending: false }).limit(limit);
  else q = admin.from("flow_trade_log")
    .select("at, position_id, account_id, symbol, phase, reason, price, qty, detail")
    .order("at", { ascending: false }).limit(limit);

  const { data, error } = await q;
  if (error) return json({ error: "read_failed", detail: error.message.slice(0, 160), hint: "flow_trade_log table may not exist yet" }, 200);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const timeline = rows.map((r) => ({
    at: r.at,
    t: typeof r.at === "string" ? r.at.slice(11, 19) : null, // HH:MM:SS for quick reading
    phase: r.phase, reason: r.reason, symbol: r.symbol,
    position_id: r.position_id, account_id: r.account_id,
    price: r.price, qty: r.qty, detail: r.detail,
  }));
  return json({ count: timeline.length, scope: positionId ? `position ${positionId}` : accountId ? `account ${accountId}` : "recent (desk-wide)", timeline });
}
