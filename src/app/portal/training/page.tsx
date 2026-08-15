import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { AffiliateAcademy } from "@/components/portal/academy/AffiliateAcademy";

export const metadata = { title: "Affiliate Academy", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * One Mission Affiliate Academy — the affiliate training experience. A guided
 * Beginner → Producer → Builder → Leader roadmap with lessons, scripts, an AI
 * coach + role-play, interactive tools, and a verified free-resource library.
 * Progress persists per member (academy_state / academy_activity, RLS-protected).
 */
export default async function PortalTrainingPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile().catch(() => null);
  const firstName = ((profile?.full_name || "").trim().split(/\s+/)[0]) || "there";

  return (
    <div className="space-y-4">
      <DisclaimerBanner tone="warning">
        Educational content only — not individualized financial advice, and no income or results are
        guaranteed. Your results depend on your effort, skill, and factors outside anyone&apos;s control.
      </DisclaimerBanner>
      <AffiliateAcademy firstName={firstName} />
    </div>
  );
}
