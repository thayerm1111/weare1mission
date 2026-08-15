import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  PHASES, MODULES, LEVELS, PRINCIPLES, DAILY_PLANS, LAUNCH_ITEMS, HELP_NOW, ROLEPLAY_SCENARIOS, GREATS,
} from "@/data/academy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Affiliate Academy curriculum, served as JSON so the mobile PWA renders the
 * exact same content as the desktop portal — one source of truth (src/data/academy.ts).
 * Signed-in members only.
 */
export async function GET(_req: NextRequest) {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }
  return new Response(
    JSON.stringify({
      ok: true,
      phases: PHASES,
      modules: MODULES,
      levels: LEVELS,
      principles: PRINCIPLES,
      dailyPlans: DAILY_PLANS,
      launchItems: LAUNCH_ITEMS,
      helpNow: HELP_NOW,
      roleplayScenarios: ROLEPLAY_SCENARIOS,
      greats: GREATS,
    }),
    { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
}
