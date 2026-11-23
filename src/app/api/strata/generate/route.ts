import { createClient } from "@/lib/supabase/server";
import { getStrataState } from "@/lib/strata/feed";
import { generatePossibleEntry } from "@/lib/strata/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/**
 * One member-initiated read-only scenario generation.
 * No credit charge, LLM-trade invention, persistence, account arming, or broker
 * execution. The PAPER worker still uses ONLY normal /api/strata readiness.
 */
export async function POST() {
  const client = createClient();
  if (!client) return json({ error: "not_configured" }, 503);
  const { data: { user } } = await client.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  try {
    const state = await getStrataState();
    if (!state) return json({ error: "feed_unavailable",
      detail: "Not enough verified gold candles to generate a responsible scenario." }, 503);
    const idea = generatePossibleEntry({
      analysis: state.analysis,
      bars: state.candles,
      price: state.price,
      generatedAt: Date.now(),
      marketOpen: !state.marketClosed,
      dataStale: state.dataStale,
    });
    return json({ ok: true, idea, state });
  } catch {
    return json({ error: "generation_unavailable",
      detail: "STRATA could not verify a current price-action scenario." }, 503);
  }
}
