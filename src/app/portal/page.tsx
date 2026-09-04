import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { DashboardTradingIntro } from "@/components/portal/DashboardTradingIntro";
import { DeskDashboard } from "@/components/portal/desk/DeskDashboard";

/**
 * PORTAL DASHBOARD (owner redesign 09-04): customers land on a premium trading-
 * technology desk — hero → live desk results → Trading Desk (The Floor / FLOW /
 * GENX) → AI Toolkit → personal development → community → business. The Builders
 * side keeps its existing hub. Desktop/tablet-first; mobile architecture intact.
 */
export default async function PortalDashboard() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile();

  const { data: updates } = await supabase
    .from("team_updates").select("id,title,body,category,pinned,created_at").eq("published", true)
    .order("pinned", { ascending: false }).order("created_at", { ascending: false }).limit(3);

  const { data: sessions } = await supabase
    .from("live_sessions").select("id,title,host,starts_at,join_url").gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true }).limit(3);

  const firstName = (profile?.full_name || profile?.email || "there").split(" ")[0].split("@")[0];

  return (
    <div>
      {/* First-visit walkthrough — unchanged */}
      <DashboardTradingIntro />
      <DeskDashboard
        firstName={firstName.charAt(0).toUpperCase() + firstName.slice(1)}
        sessions={(sessions ?? []) as { id: string; title: string; host: string | null; starts_at: string; join_url: string | null }[]}
        updates={(updates ?? []) as { id: string; title: string; body: string; category: string | null; pinned: boolean | null; created_at: string }[]}
      />
    </div>
  );
}
