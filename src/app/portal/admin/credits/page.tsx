import { redirect } from "next/navigation";
import { Coins } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import CreditsDashboard from "@/components/portal/CreditsDashboard";

export const metadata = { title: "Credits & Conversion", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AdminCreditsPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile();
  if (!profile || profile.role !== "admin") redirect("/portal");

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Admin</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <Coins className="h-7 w-7 text-primary" aria-hidden="true" /> Credits &amp; Conversion
        </h1>
        <p className="mt-2 text-charcoal/70">Who&apos;s using credits, who&apos;s running low, and who&apos;s ready to buy a pack.</p>
      </header>
      <CreditsDashboard />
    </div>
  );
}
