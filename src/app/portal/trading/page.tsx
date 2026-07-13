import { Suspense } from "react";
import { LineChart, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
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
    <div className="space-y-3">
      {/* Compact header — keep the focus on the workspace */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-navy sm:text-2xl">
          <LineChart className="h-6 w-6 text-primary" aria-hidden="true" /> The Floor
        </h1>
        <p className="inline-flex items-center gap-1.5 text-[11px] leading-tight text-charcoal/50">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" aria-hidden="true" />
          Educational only — not financial advice. You approve every action on your own account.
        </p>
      </div>

      <Suspense fallback={<div className="h-[80vh] rounded-2xl bg-[#17130d]" />}>
        <FloorWorkspace isCaller={isCaller} followerCount={followerCount} />
      </Suspense>
    </div>
  );
}
