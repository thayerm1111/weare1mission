import { createClient } from "@/lib/supabase/server";
import { getStrataState } from "@/lib/strata/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/** Read only. Does not place orders or charge for signals. */
export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  try {
    const state = await getStrataState();
    if (!state) return json({ error: "feed_unavailable", detail: "Confirmed gold candles are unavailable. No setup issued." }, 503);
    return json({ ok: true, ...state });
  } catch {
    return json({ error: "feed_unavailable", detail: "Market structure could not be verified. No setup issued." }, 503);
  }
}
