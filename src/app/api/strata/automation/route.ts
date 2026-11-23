import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * STRATA account settings and paper-trade ledger.
 * No action in this route calls TradeLocker or changes a FLOW auto-trade flag.
 * Even for a live connected account, mode "paper" simulates trades only.
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function identity() {
  const client = createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  return user?.id ?? null;
}
export async function GET() {
  const id = await identity();
  if (!id) return json({ error: "unauthorized" }, 401);
  const db = createAdminClient();
  if (!db) return json({ error: "not_configured" }, 503);
  const [accounts, connects, settings, paper] = await Promise.all([
    db.from("flow_broker_accounts")
      .select("account_id,connection_id,name,acc_num,environment,is_selected")
      .eq("user_id", id).order("is_selected", { ascending: false }).limit(60),
    db.from("flow_broker_connections").select("id,status,environment")
      .eq("user_id", id).limit(60),
    db.from("strata_automation_settings")
      .select("connection_id,account_id,environment,mode,risk_pct,max_entries_per_day,updated_at")
      .eq("user_id", id).limit(60),
    db.from("strata_paper_positions")
      .select("id,connection_id,account_id,side,setup_type,entry,stop,target,risk_pct,status,opened_at,closed_at,exit_price,signal_key")
      .eq("user_id", id).order("opened_at", { ascending: false }).limit(30),
  ]);
  if (accounts.error || connects.error || settings.error || paper.error)
    return json({ error: "read_failed", detail: "Account or paper automation data is unavailable." }, 503);
  const active = new Set((connects.data ?? []).filter((c) => c.status === "connected").map((c) => String(c.id)));
  const own = (accounts.data ?? []).map((account) => ({
    accountId: String(account.account_id),
    connectionId: String(account.connection_id),
    name: String(account.name || "TradeLocker account"),
    masked: account.acc_num ? "••" + String(account.acc_num).slice(-4) : "",
    environment: account.environment === "live" ? "live" : "demo",
    connected: active.has(String(account.connection_id)),
    selected: account.is_selected === true,
  }));
  return json({
    ok: true, accounts: own,
    settings: settings.data ?? [],
    paper: paper.data ?? [],
    execution: { mode: "paper_only", liveOrdersEnabled: false, demoBrokerOrdersEnabled: false },
  });
}
export async function POST(req: NextRequest) {
  const id = await identity();
  if (!id) return json({ error: "unauthorized" }, 401);
  const db = createAdminClient();
  if (!db) return json({ error: "not_configured" }, 503);
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.action !== "settings") return json({ error: "bad_action" }, 400);
  const accountId = typeof body.accountId === "string" ? body.accountId.trim().slice(0, 120) : "";
  const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
  const mode = body.mode === "paper" ? "paper" : body.mode === "off" ? "off" : "";
  const riskPct = Number(body.riskPct ?? 0.25);
  const maxEntriesPerDay = Number(body.maxEntriesPerDay ?? 2);
  if (!accountId || !UUID.test(connectionId) || !mode ||
      !Number.isFinite(riskPct) || riskPct < 0.1 || riskPct > 0.5 ||
      !Number.isInteger(maxEntriesPerDay) || maxEntriesPerDay < 1 || maxEntriesPerDay > 4)
    return json({ error: "invalid_settings", detail: "Paper risk 0.1–0.5%, 1–4 entries per day." }, 400);
  // Owner-verified at every write, no client-provided user ID or environment accepted.
  const [{ data: account }, { data: connection }] = await Promise.all([
    db.from("flow_broker_accounts").select("account_id,environment,connection_id").eq("user_id", id)
      .eq("connection_id", connectionId).eq("account_id", accountId).maybeSingle(),
    db.from("flow_broker_connections").select("id,status").eq("user_id", id)
      .eq("id", connectionId).maybeSingle(),
  ]);
  if (!account || !connection) return json({ error: "account_not_found" }, 404);
  if (mode === "paper" && connection.status !== "connected")
    return json({ error: "connection_inactive", detail: "Reconnect the account through FLOW first." }, 409);
  const environment = account.environment === "live" ? "live" : "demo";
  const { error } = await db.from("strata_automation_settings").upsert({
    user_id: id, connection_id: connectionId, account_id: accountId, environment,
    mode, risk_pct: riskPct, max_entries_per_day: maxEntriesPerDay, updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,connection_id,account_id" });
  if (error) return json({ error: "save_failed", detail: "Unable to save STRATA paper automation." }, 503);
  return json({ ok: true, accountId, connectionId, mode, riskPct, maxEntriesPerDay,
    execution: { mode: "paper_only", liveOrdersEnabled: false, demoBrokerOrdersEnabled: false } });
}
