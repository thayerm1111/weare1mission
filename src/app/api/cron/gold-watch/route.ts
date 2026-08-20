import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GOLD-FILL WATCH (read-only status endpoint).
 *
 * Returns the recent XAUUSD auto-executor events for one account so an UNATTENDED
 * scheduled task can confirm gold is filling cleanly WITHOUT needing a database
 * tool of its own — it just WebFetches this URL. Runs server-side with the
 * service-role key (already in the Vercel env). Key-gated like the other crons.
 *
 *   GET /api/cron/gold-watch?key=<FLOW_CRON_KEY|GENX_CRON_KEY|CRON_SECRET>
 *       &user=<uuid>            (optional; defaults to the desk owner)
 *       &mins=<minutes>         (optional; default 70)
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const OWNER = "3b5e06e5-258c-4880-b1f2-d1623cbca100"; // default: desk owner's account

function keyAuthorized(req: NextRequest): boolean {
  const qp = new URL(req.url).searchParams.get("key") || "";
  const hdr = req.headers.get("authorization") || "";
  for (const k of [process.env.FLOW_CRON_KEY, process.env.GENX_CRON_KEY, process.env.CRON_SECRET]) {
    if (k && (qp === k || hdr === `Bearer ${k}`)) return true;
  }
  return false;
}

type Row = { created_at: string; symbol: string; side: string | null; qty: number | null; status: string | null; reason: string | null; order_id: string | null; account_id: string | null };

export async function GET(req: NextRequest) {
  if (!keyAuthorized(req)) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);

  const url = new URL(req.url);
  const user = url.searchParams.get("user") || OWNER;
  const mins = Math.min(1440, Math.max(5, Number(url.searchParams.get("mins")) || 70));
  const sinceIso = new Date(Date.now() - mins * 60_000).toISOString();

  const { data, error } = await admin
    .from("flow_auto_events")
    .select("created_at, symbol, side, qty, status, reason, order_id, account_id")
    .eq("user_id", user)
    .ilike("symbol", "%XAU%")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return json({ error: "query_failed", detail: error.message.slice(0, 160) }, 500);

  const rows = ((data ?? []) as Row[]).map((r) => ({
    at: r.created_at, side: r.side, qty: r.qty == null ? null : Number(r.qty),
    status: r.status, reason: (r.reason || "").slice(0, 120), orderId: r.order_id, accountId: r.account_id,
  }));

  const placed = rows.filter((r) => r.status === "placed");
  const errors = rows.filter((r) => r.status === "error");
  const deferred = rows.filter((r) => r.status === "deferred");
  const oversized = placed.filter((r) => (r.qty ?? 0) >= 1.0);

  let summary: string;
  if (rows.length === 0) {
    summary = `No GOLD (XAUUSD) auto-exec events in the last ${mins} min — normal (gold simply hasn't signalled an entry).`;
  } else {
    const parts: string[] = [];
    if (placed.length) parts.push(`${placed.length} clean fill${placed.length === 1 ? "" : "s"} (` + placed.map((r) => `${r.side} ${r.qty} lot`).join(", ") + `)`);
    if (oversized.length) parts.push(`⚠ ${oversized.length} fill(s) ≥1.0 lot — check sizing`);
    if (errors.length) parts.push(`${errors.length} error(s): ` + errors.slice(0, 3).map((r) => r.reason).join(" | "));
    if (deferred.length) parts.push(`${deferred.length} deferred (market/session closed — will retry)`);
    summary = `GOLD last ${mins} min — ` + parts.join("; ") + ".";
  }

  return json({ ok: true, asOf: new Date().toISOString(), windowMins: mins, count: rows.length, placed: placed.length, errors: errors.length, deferred: deferred.length, oversized: oversized.length, summary, rows });
}
