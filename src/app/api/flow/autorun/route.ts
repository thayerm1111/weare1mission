import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConnection } from "@/lib/flow/connection";
import { readBalance } from "@/lib/credits";
import { CREDIT_COST } from "@/lib/creditConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * FLOW auto-run control (member self-serve). Auto-run places trades for the
 * member automatically on the shared FLOW engine — it costs 1 credit per 30-min
 * window while it's ON and the market is open (billed by the executor cron).
 *
 *  GET  → { enabled, paused, connected, riskPct, credits, costPer30m }
 *  POST { action: "enable" | "disable" }
 *
 * Enabling requires a connected broker. Disarming is always allowed.
 */
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const DEFAULT_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "NAS100"];

async function authUser() {
  const supabase = createClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user ?? null;
}

async function status(userId: string) {
  const admin = createAdminClient();
  const { data: row } = admin
    ? await admin.from("flow_auto_settings").select("enabled, credit_paused, last_credit_at").eq("user_id", userId).maybeSingle()
    : { data: null };
  const conn = await getConnection(userId);
  const { data: pref } = admin
    ? await admin.from("flow_trade_prefs").select("risk_pct").eq("user_id", userId).maybeSingle()
    : { data: null };
  const bal = await readBalance();
  const r = (row as { enabled?: boolean; credit_paused?: boolean; last_credit_at?: string | null } | null) ?? null;
  return {
    enabled: !!r?.enabled,
    paused: !!r?.credit_paused,
    lastCreditAt: r?.last_credit_at ?? null,
    connected: !!conn && conn.status === "connected",
    riskPct: (pref as { risk_pct?: number } | null)?.risk_pct ?? null,
    credits: bal ? bal.dailyLeft + bal.purchased : null,
    costPer30m: CREDIT_COST.flow_autorun ?? 1,
  };
}

export async function GET() {
  const user = await authUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  return json(await status(user.id));
}

export async function POST(req: NextRequest) {
  const user = await authUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ error: "server", detail: "Storage unavailable." }, 200);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* */ }
  const action = String(body.action || "");

  if (action === "disable") {
    await admin.from("flow_auto_settings").update({ enabled: false, credit_paused: false, updated_at: new Date().toISOString() }).eq("user_id", user.id);
    return json({ ok: true, ...(await status(user.id)) });
  }

  if (action === "enable") {
    const conn = await getConnection(user.id);
    if (!conn || conn.status !== "connected") {
      return json({ error: "not_connected", detail: "Connect your TradeLocker account before turning on auto-run." }, 200);
    }
    // Out of credits? Let them enable anyway (it will simply pause until they top
    // up), but tell them — clearer than a silent no-op.
    const bal = await readBalance();
    const credits = bal ? bal.dailyLeft + bal.purchased : 0;

    const nowIso = new Date().toISOString();
    // Upsert a fully-formed armed row. last_credit_at=null → the first market-open
    // tick charges immediately; risk-based sizing (flow_trade_prefs) overrides lots.
    const { data: existing } = await admin.from("flow_auto_settings").select("user_id").eq("user_id", user.id).maybeSingle();
    if (existing) {
      await admin.from("flow_auto_settings").update({ enabled: true, credit_paused: false, last_credit_at: null, updated_at: nowIso }).eq("user_id", user.id);
    } else {
      await admin.from("flow_auto_settings").insert({
        user_id: user.id, enabled: true, mode: "auto", symbols: DEFAULT_SYMBOLS,
        max_lot: 1.0, max_open: 1, max_orders_per_hour: 6, daily_loss_limit: 0,
        credit_paused: false, last_credit_at: null, updated_at: nowIso,
      });
    }
    return json({ ok: true, lowCredits: credits < (CREDIT_COST.flow_autorun ?? 1), ...(await status(user.id)) });
  }

  return json({ error: "bad_action" }, 200);
}
