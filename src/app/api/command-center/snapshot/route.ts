import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { marketOpen } from "../../../../../command-center/core/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * COMMAND CENTER XAUUSD — the live market read for the app and the desktop.
 *
 * Serves the newest row the Command Center worker wrote. It computes nothing: if this route had its own
 * market logic, the screen could disagree with the engine that trades, and a member would have no way to
 * know which one was lying.
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

type TfRow = { state: string; features: Record<string, number>; structure: Record<string, unknown> };

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 503);

  const open = marketOpen(Date.now());

  const { data } = await admin.from("cc_snapshots").select("*").order("at", { ascending: false }).limit(1).maybeSingle();
  if (!data) {
    return json({
      live: false,
      open,
      reason: open
        ? "The Command Center has not written a market read yet."
        : "Gold is closed for the weekend. The Command Center resumes when the market reopens.",
    });
  }

  const r = data as Record<string, unknown>;
  const at = Date.parse(String(r.at));
  const ageMs = Date.now() - at;
  const tfs = (r.timeframes ?? {}) as Record<string, TfRow>;
  const warnings = (r.warnings as string[] | null) ?? [];

  // A read older than five minutes is history, not the market. Say so rather than showing it as live.
  // Over the weekend that is expected, not a fault, and the member is told which it is.
  const stale = ageMs > 5 * 60_000;

  return json({
    live: !stale,
    open,
    reason: stale
      ? (open
          ? `The last market read was ${Math.round(ageMs / 60_000)} minutes ago.`
          : "Gold is closed. This is the last read before the close.")
      : undefined,
    ageSeconds: Math.round(ageMs / 1000),
    at: r.at,
    version: r.snapshot_version,
    price: r.price, bid: r.bid, ask: r.ask, spread: r.spread,
    session: r.session,
    regime: r.regime,
    pressure: r.pressure_net,
    timeframes: Object.fromEntries(Object.entries(tfs).map(([tf, v]) => [tf, {
      state: v.state,
      slope: v.features?.slope ?? null,
      efficiency: v.features?.efficiency ?? null,
      atr: v.features?.atr ?? null,
      rsi: v.features?.rsi ?? null,
      sequence: (v.structure as { sequence?: string } | null)?.sequence ?? null,
      positionInRange: (v.structure as { positionInRange?: number } | null)?.positionInRange ?? null,
    }])),
    levels: r.levels ?? [],
    feeds: r.feeds ?? [],
    warnings: stale && open ? [`Last market read was ${Math.round(ageMs / 60_000)} minutes ago`, ...warnings] : warnings,
  });
}
