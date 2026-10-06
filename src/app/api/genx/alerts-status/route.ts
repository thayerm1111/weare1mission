import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GENX alerts status — the auto-scanner's live state for the GENX Lab "Alerts" tile. Returns the
 * last scan time (heartbeat), the setups currently being tracked (forming), and recently
 * triggered/invalidated calls. genx_alerts is service-role only, so this reads via the admin client.
 *
 * ADMIN ONLY (owner 10-05). It used to answer any signed-in member, on the reasoning that it showed
 * nothing the Telegram channel had not already posted. The channel no longer posts the play — no
 * side, no zone, no stop, no targets (publicSignal.ts) — so that reasoning is gone, and this would
 * have been the free way round it: every live call's side and levels, for the asking. Its only
 * reader is the GENX Lab, which is itself admin-only (portal/genx-lab), so no member page changes.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  // The same test the GENX Lab page applies before it renders.
  const profile = await getProfile().catch(() => null);
  if (!profile || profile.role !== "admin") return json({ error: "forbidden" }, 403);
  const admin = createAdminClient();
  const telegram = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);
  if (!admin) return json({ configured: false, telegram, lastScanAt: null, tracking: [], recent: [] });

  const cols = "mode,side,action,entry_low,entry_high,stop,tp1,tp2,confidence,state,created_at,heads_up_sent_at,enter_sent_at,updated_at";
  const [hb, tracking, recent] = await Promise.all([
    admin.from("genx_alerts").select("last_checked_at").eq("dedupe_key", "__scan_heartbeat__").maybeSingle(),
    admin.from("genx_alerts").select(cols).eq("state", "forming").order("created_at", { ascending: false }).limit(12),
    admin.from("genx_alerts").select(cols).in("state", ["entered", "invalidated"]).order("updated_at", { ascending: false }).limit(12),
  ]);

  return json({
    configured: true,
    telegram,
    lastScanAt: (hb.data as { last_checked_at?: string } | null)?.last_checked_at ?? null,
    tracking: tracking.data ?? [],
    recent: recent.data ?? [],
  });
}
