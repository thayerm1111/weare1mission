import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One Mission has ONE current trading experience for all approved members.
 * The standalone floor.weare1mission.com entrance uses /floor-app (rewritten
 * by middleware). After authentication it takes members to the SAME modern
 * Floor they see at weare1mission.com/portal/trading, with Atlas Live, STRATA,
 * GENX, OM AI Plays, Market Pulse and FLOW together.
 *
 * Preserves the branded floor./login and all existing role/risk/account gates
 * in the portal layout. No public/anonymous access is added.
 */
export default async function FloorStandalonePage() {
  const supabase = createClient();
  if (!supabase) redirect("/login");
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  redirect("/portal/trading");
}
