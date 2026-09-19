import { createClient } from "@/lib/supabase/server";
import { liveState } from "../../../../../command-center/engines/live";
import { marketOpen } from "../../../../../command-center/core/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * COMMAND CENTER XAUUSD — THE LIVE READ.
 *
 * One request, the whole living state: price, market read, THE BRAIN's presence and thesis, what it has
 * noticed, and the candles it read it from. The screen renders this and computes no market opinion of
 * its own, so what you see is always what the engine actually measured.
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The BRAIN JOURNAL covers the current trading day, measured from the 17:00 New York close. */
function dayStart(now = new Date()): Date {
  const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const start = new Date(ny);
  start.setHours(17, 0, 0, 0);
  if (ny.getHours() < 17) start.setDate(start.getDate() - 1);
  const offset = now.getTime() - ny.getTime();
  return new Date(start.getTime() + offset);
}

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ ok: false, error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  try {
    const state = await liveState(marketOpen(Date.now()), dayStart(), user.id);
    return json(state);
  } catch (e) {
    return json({ ok: false, error: "read_failed", detail: e instanceof Error ? e.message.slice(0, 200) : "unknown" }, 500);
  }
}
