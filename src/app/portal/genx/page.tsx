import { AlertTriangle } from "lucide-react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { GenxDesk } from "@/components/portal/floor/GenxDesk";
import { SHELL_COOKIE, wantsNextShell } from "@/lib/floor/nav";

export const metadata = { title: "GENX" };
export const dynamic = "force-dynamic";

export default async function GenxPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  // The redesign preview (admin only): the tool is the page, and says its own educational line at its foot.
  const profile = await getProfile();
  if (wantsNextShell(cookies().get(SHELL_COOKIE)?.value, profile?.role === "admin")) return <GenxDesk />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[11px] leading-tight text-charcoal/50">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" aria-hidden="true" />
          Educational only — not financial advice. You approve every action on your own account.
        </p>
      </div>
      <GenxDesk />
    </div>
  );
}
