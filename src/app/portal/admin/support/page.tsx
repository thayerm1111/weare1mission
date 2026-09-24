import { redirect } from "next/navigation";
import { LifeBuoy } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isPriorityEmail } from "@/lib/marketData";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { AdminSupport } from "@/components/portal/AdminSupport";

export const metadata = { title: "Support desk", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * The support desk (owner 09-24). Gated on isPriorityEmail rather than the `admin` role: sending a
 * reply speaks as One Mission to a member, so it stays with the owner, not with everyone carrying an
 * admin badge. The API enforces the same check — this redirect is only so nobody lands on a dead page.
 */
export default async function AdminSupportPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isPriorityEmail(user.email)) redirect("/portal");

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Admin</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <LifeBuoy className="h-7 w-7 text-primary" aria-hidden="true" /> Support desk
        </h1>
        <p className="mt-2 text-charcoal/70">
          Every member message lands here. Claude reads them against the member&rsquo;s own account and
          leaves a suggested reply — nothing goes out until you press send.
        </p>
      </header>
      <AdminSupport />
    </div>
  );
}
