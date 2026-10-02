import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { GenFxDesk } from "@/components/portal/floor/GenFxDesk";

export const metadata = { title: "GEN FX" };
export const dynamic = "force-dynamic";

export default function GenFxPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[11px] leading-tight text-charcoal/50">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" aria-hidden="true" />
          Educational only — not financial advice. You approve every action on your own account.
        </p>
      </div>
      <GenFxDesk />
    </div>
  );
}
