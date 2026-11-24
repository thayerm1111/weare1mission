import { Suspense } from "react";
import { cookies, headers } from "next/headers";
import { LineChart, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { FloorWorkspace } from "@/components/portal/floor/FloorWorkspace";
import { Floor } from "@/components/om/floor/Floor";
import { SHELL_COOKIE, wantsNextShell } from "@/lib/floor/nav";

export default async function FloorPage({ searchParams }: { searchParams?: { view?: string | string[] } }) {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile();

  // THE NEW DESIGN (owner 11-20; for everyone since 11-21) — the new Floor here, and the tools open without the
  // classic workspace's own row of tabs (the new shell is the navigation). An admin who chose the classic portal
  // gets this page exactly as it was.
  if (wantsNextShell(cookies().get(SHELL_COOKIE)?.value, profile?.role === "admin", headers())) {
    const view = typeof searchParams?.view === "string" ? searchParams.view : "";
    if (!view || view === "home") return <Floor />;
    return (
      <Suspense fallback={<div className="h-[80vh] rounded-2xl bg-[#17130d]" />}>
        <FloorWorkspace isCaller={profile?.role === "admin"} followerCount={128} bare />
      </Suspense>
    );
  }

  // "Callers" (traders who can post alerts / be copied) are admins for now.
  // Phase 2 adds a dedicated caller permission.
  const isCaller = profile?.role === "admin";
  const followerCount = 128; // sample — wired to real subscribers in Phase 2

  return (
    <div className="space-y-3">
      {/* Compact header — keep the focus on the workspace */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-navy sm:text-2xl">
          <LineChart className="h-6 w-6 text-primary" aria-hidden="true" /> OM OS
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
