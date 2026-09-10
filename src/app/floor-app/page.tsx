import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { FloorWorkspace } from "@/components/portal/floor/FloorWorkspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE FLOOR — standalone terminal page (floor.weare1mission.com → "/").
 * Login required; unauthenticated visitors go to the Floor's own sign-in.
 * Renders the exact same FloorWorkspace the portal uses — one codebase, two
 * front doors — so every tool (FLOW, GENX, Matty Pips, OM AI, OM AI Plays,
 * Market Pulse, Live Plays) stays in lockstep with the backoffice version.
 */
export default async function FloorStandalonePage() {
  const supabase = createClient();
  if (!supabase) redirect("/login");
  const { data: { user } } = await supabase!.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getProfile();
  const isCaller = profile?.role === "admin";

  return (
    <Suspense fallback={<div className="min-h-screen bg-[#050505]" />}>
      <FloorWorkspace isCaller={isCaller} followerCount={128} />
    </Suspense>
  );
}
