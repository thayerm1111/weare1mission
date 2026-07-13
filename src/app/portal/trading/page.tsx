import { LineChart } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { FloorWorkspace } from "@/components/portal/floor/FloorWorkspace";

export default async function FloorPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile();

  // "Callers" (traders who can post alerts / be copied) are admins for now.
  // Phase 2 adds a dedicated caller permission.
  const isCaller = profile?.role === "admin";
  const followerCount = 128; // sample — wired to real subscribers in Phase 2

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Members Only</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <LineChart className="h-7 w-7 text-primary" aria-hidden="true" /> The Floor
        </h1>
        <p className="mt-2 text-charcoal/70">
          Everything in one place — live sessions, trade alerts, charts, and copy trading.
        </p>
      </header>

      <DisclaimerBanner tone="warning">
        Educational content only — not individualized financial advice. Trading involves risk,
        including loss of capital. Trade alerts and copy trading are opt-in; you approve every
        action on your own account. Past performance does not guarantee future results.
      </DisclaimerBanner>

      <FloorWorkspace isCaller={isCaller} followerCount={followerCount} />
    </div>
  );
}
