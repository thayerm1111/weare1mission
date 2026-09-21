import { createClient } from "@/lib/supabase/server";
import { createClient as adminClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CHART CANDLES FOR THE COMMAND CENTER SCREEN — READ-ONLY, DISPLAY ONLY.
 *
 * Served from cc_chart_bars, which the worker overwrites each pass with the bars it already fetched for
 * THE BRAIN. So opening a chart costs the market-data feed nothing: there is no second upstream call that
 * could eat into the rate limit the engine itself depends on. Nothing here is read by any trading path.
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const TFS = new Set(["5m", "15m", "1h", "4h", "1d"]);

export async function GET(req: Request) {
  const tf = new URL(req.url).searchParams.get("tf") ?? "15m";
  if (!TFS.has(tf)) return json({ ok: false, error: "tf_not_in_feed", tf, bars: [] });

  const supabase = createClient();
  if (!supabase) return json({ ok: false, error: "not_configured", tf, bars: [] }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return json({ ok: false, error: "not_configured", tf, bars: [] }, 503);
  const c = adminClient(url, key, { auth: { persistSession: false } });
  const { data } = await c.from("cc_chart_bars").select("bars, updated_at").eq("tf", tf).maybeSingle();
  const row = data as { bars: unknown[]; updated_at: string } | null;
  return json({ ok: !!row, tf, bars: row?.bars ?? [], at: row ? Date.parse(row.updated_at) : null });
}
