import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAutoSettings, DEFAULT_SETTINGS } from "@/lib/flow/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FLOW auto-execution settings + status (per member).
 *   GET  → current arm settings, recent auto events, and whether a first order
 *          is awaiting the one-time confirmation.
 *   POST → { action: "save" | "disarm", ...settings }. Saving with enabled=true
 *          arms it; "disarm" is the kill switch. All values are clamped server-side.
 * Nothing here ever PLACES an order — that is /api/flow/execute (user tap) and
 * /api/cron/flow-autoscan (unattended), both of which re-check these settings.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function authUser() {
  const supabase = createClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user ?? null;
}

const clampNum = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

export async function GET() {
  const user = await authUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const settings = await getAutoSettings(user.id);
  const admin = createAdminClient();
  let events: unknown[] = [];
  let pendingConfirm: unknown = null;
  if (admin) {
    const { data } = await admin.from("flow_auto_events").select("symbol, side, qty, entry, stop, tp, status, reason, order_id, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20);
    events = data ?? [];
    // A pending first-confirm that hasn't been superseded by a placed order.
    const p = (data ?? []).find((e) => e.status === "pending_confirm");
    if (p && !settings.first_confirmed) pendingConfirm = { symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, stop: p.stop, tp: p.tp, at: p.created_at };
  }
  return json({ settings, events, pendingConfirm });
}

export async function POST(req: NextRequest) {
  const user = await authUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ error: "server", detail: "Storage unavailable." }, 200);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* */ }
  const action = String(body.action || "save");
  const nowIso = new Date().toISOString();

  if (action === "disarm") {
    await admin.from("flow_auto_settings").upsert({ user_id: user.id, enabled: false, updated_at: nowIso }, { onConflict: "user_id" });
    return json({ ok: true, settings: await getAutoSettings(user.id) });
  }

  // action === "save"
  const cur = await getAutoSettings(user.id);
  const symbols = Array.isArray(body.symbols) ? (body.symbols as unknown[]).map((s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean).slice(0, 12) : cur.symbols;
  const patch = {
    user_id: user.id,
    enabled: body.enabled != null ? !!body.enabled : cur.enabled,
    mode: body.mode === "dry" || body.mode === "auto" ? body.mode : cur.mode,
    symbols,
    max_lot: clampNum(body.max_lot ?? cur.max_lot, 0.01, 5, DEFAULT_SETTINGS.max_lot),
    max_open: Math.round(clampNum(body.max_open ?? cur.max_open, 1, 10, DEFAULT_SETTINGS.max_open)),
    max_orders_per_hour: Math.round(clampNum(body.max_orders_per_hour ?? cur.max_orders_per_hour, 1, 30, DEFAULT_SETTINGS.max_orders_per_hour)),
    daily_loss_limit: clampNum(body.daily_loss_limit ?? cur.daily_loss_limit, 0, 1_000_000, 0),
    updated_at: nowIso,
  };
  const { error } = await admin.from("flow_auto_settings").upsert(patch, { onConflict: "user_id" });
  if (error) return json({ error: "server", detail: error.message }, 200);
  return json({ ok: true, settings: await getAutoSettings(user.id) });
}
