import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public GENX wins feed — the real ENTER-NOW calls that hit their target, for the
 * social-proof wins wall. No auth: it exposes only trade outcomes (side, zone,
 * target, pips, time) from graded genx_alerts — nothing sensitive, nothing
 * fabricated. Only rows the grader flipped to outcome='win' appear here.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const admin = createAdminClient();
  if (!admin) return json({ wins: [], stats: { count: 0, total_pips: 0, best: 0 } });

  const { data } = await admin.from("genx_alerts")
    .select("mode, side, entry_low, entry_high, stop, tp1, result_pips, enter_price, resolved_at")
    .eq("outcome", "win").order("resolved_at", { ascending: false }).limit(60);
  const wins = (data ?? []).filter((w) => Number(w.result_pips) > 0);

  const total_pips = wins.reduce((s, w) => s + (Number(w.result_pips) || 0), 0);
  const best = wins.reduce((m, w) => Math.max(m, Number(w.result_pips) || 0), 0);
  const { count } = await admin.from("genx_alerts").select("*", { count: "exact", head: true }).eq("outcome", "win");

  return json({ wins, stats: { count: count ?? wins.length, total_pips: Math.round(total_pips), best: Math.round(best) } });
}
