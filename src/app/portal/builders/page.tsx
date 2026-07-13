import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { BuildersDashboard } from "@/components/portal/BuildersDashboard";

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
      <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-8 text-center shadow-card">
        <p className="text-lg font-bold text-navy">Builder HQ is coming soon</p>
        <p className="mt-2 text-sm text-charcoal/60">The network dashboard is being built. Check back shortly.</p>
      </div>
    );
  }

  return <BuildersDashboard name={profile?.full_name} />;
}
