import { createClient } from "@/lib/supabase/server";
import { liveMemory } from "../../../../../command-center/engines/live";
import { saveLesson } from "../../../../../command-center/adapters/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TEACH ATLAS.
 *
 * The trader says what they see, in their own words, and it is stored against the exact market state at
 * that moment — price, regime, pressure, the timeframe read and the levels in play. A lesson without the
 * market it was taught in is just a sentence; with it, it is an example.
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { lesson?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const lesson = (body.lesson ?? "").toString().trim().slice(0, 1200);
  if (!lesson) return json({ error: "empty" }, 400);

  const m = await liveMemory();
  const s = m.now;

  const interpretation = s
    ? `Captured with XAUUSD at ${s.price.toFixed(2)}, ${s.session.replace("_", " ")} session, ${s.regime.replace(/_/g, " ")}, pressure ${Math.round(s.pressure.net)}${s.timeframes["5m"] ? `, 5m ${s.timeframes["5m"]!.state.replace(/_/g, " ")}` : ""}.`
    : "Captured without a live market read.";

  await saveLesson({
    userId: user.id,
    body: lesson,
    interpretation,
    snapshotId: null,
    context: s ? {
      at: s.at, price: s.price, session: s.session, regime: s.regime,
      pressure: s.pressure, levels: s.levels.slice(0, 6),
      timeframes: Object.fromEntries(Object.entries(s.timeframes).map(([tf, v]) => [tf, v!.state])),
    } : null,
  });

  return json({
    ok: true,
    acknowledgement: s
      ? `I see it. ${interpretation} I'll keep that as a teaching example.`
      : "Saved — though without a live read I can't attach the market it happened in.",
  });
}
