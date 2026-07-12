import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { MissionUpdatesClient, type Update } from "@/components/portal/MissionUpdatesClient";

export const metadata = { title: "Mission Update", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function UpdatesPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;

  const profile = await getProfile();
  const isAdmin = profile?.role === "admin";

  const { data: updates } = await supabase
    .from("team_updates").select("*").eq("published", true)
    .order("pinned", { ascending: false }).order("created_at", { ascending: false });

  return <MissionUpdatesClient updates={(updates ?? []) as Update[]} isAdmin={isAdmin} />;
}
