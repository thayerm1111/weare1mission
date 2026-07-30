import { BarChart3 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import CommunityResults from "@/components/portal/CommunityResults";

export const metadata = { title: "Community Results", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function CommunityResultsPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Community</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <BarChart3 className="h-7 w-7 text-primary" aria-hidden="true" /> Community Results
        </h1>
        <p className="mt-2 text-charcoal/70">How the OM AI tools are performing across the whole community — shown honestly, with sample sizes and confidence intervals.</p>
      </header>
      <CommunityResults />
    </div>
  );
}
