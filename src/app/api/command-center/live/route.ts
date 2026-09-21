import { createClient } from "@/lib/supabase/server";
import { hasPass } from "@/lib/ccPass";
import { liveState } from "../../../../../command-center/engines/live";
import { marketOpen } from "../../../../../command-center/core/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * COMMAND CENTER XAUUSD — THE LIVE READ.
 *
 * One request, the whole living state: price, market read, ATLAS's presence and thesis, what it has
 * noticed, and the candles it read it from. The screen renders this and computes no market opinion of
 * its own, so what you see is always what the engine actually measured.
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** Atlas JOURNAL covers the current trading day, measured from the 17:00 New York close. */
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
  // 5 credits per 30 minutes (owner 09-21). No open window, no data.
  if (!(await hasPass(user.id))) return json({ ok: false, error: "pass_required" }, 402);

  try {
    /*
     * WHEN GOLD IS SHUT, "TODAY" IS THE WRONG WINDOW.
     *
     * The journal behind Today's Brain started at the current trading day, which on a Saturday is a
     * day in which nothing happened — so the panel read "No reads recorded today yet" all weekend,
     * as though ATLAS had never said anything. The last thing it said about gold is exactly what
     * somebody wants while the market is closed, so the window widens to the last week and the panel
     * shows the most recent reads instead of an empty box.
     */
    const isOpen = marketOpen(Date.now());
    const since = isOpen ? dayStart() : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const state = await liveState(isOpen, since, user.id);
    return json(state);
  } catch (e) {
    return json({ ok: false, error: "read_failed", detail: e instanceof Error ? e.message.slice(0, 200) : "unknown" }, 500);
  }
}
