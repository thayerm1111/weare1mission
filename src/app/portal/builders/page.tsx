import { Building2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { BuildersDashboard } from "@/components/portal/BuildersDashboard";
import { ComingSoon } from "@/components/portal/ComingSoon";

export const metadata = { title: "Builder HQ", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// Only these people see Builder HQ for now (placeholder for the network side).
// Add Joey's email here once his account exists.
const ALLOW = ["thayerm1111@gmail.com"];

export default async function BuildersHQPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile();

  const allowed = profile?.role === "admin" || Boolean(profile?.email && ALLOW.includes(profile.email));
  if (!allowed) {
    return (
      <ComingSoon
        icon={Building2}
        eyebrow="Building"
        title="Builder HQ"
        description="Your network command center — team growth, momentum, and rank progression, all in one place. We're wiring it to live company data and want it flawless before it opens."
        bullets={[
          "Real-time team volume and momentum",
          "Your rank progress and next-rank roadmap",
          "New-partner activity and fast starts",
          "Recognition for your top performers",
        ]}
        progress={45}
        progressLabel="Connecting to company data"
      />
    );
  }

  return <BuildersDashboard name={profile?.full_name} />;
}
