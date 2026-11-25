import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { AdminMembers, type MemberRow } from "@/components/portal/AdminMembers";
import { loadMemberBilling } from "@/lib/adminBilling";
import { createAdminClient } from "@/lib/supabase/admin";
import { getNitrousAddonAccessMap } from "@/lib/nitrous/addon";

export const metadata = { title: "Approvals", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile();
  if (!profile || profile.role !== "admin") redirect("/portal");

  // Admins can read all profiles (row-level security allows it).
  // Profiles (RLS lets admins read them all) and, in parallel, who bought what — packs, auto-refill
  // top-ups and subscriptions — so every card can show it (owner 09-29).
  const [{ data }, billing] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, email, full_name, role, tier, status, is_creator, created_at, conectiv_username, conectiv_id, access_expires_at")
      .order("created_at", { ascending: false }),
    loadMemberBilling(),
  ]);

  const admin = createAdminClient();
  const nitrousAccess = admin ? await getNitrousAddonAccessMap(admin, (data ?? []).map(member => String(member.id))).catch(() => null) : null;

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Admin</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <ShieldCheck className="h-7 w-7 text-primary" aria-hidden="true" /> Member Approvals
        </h1>
        <p className="mt-2 text-charcoal/70">Approve new sign-ups, manage member tiers and access, grant complimentary Nitrous, and review purchases and subscriptions.</p>
      </header>
      <AdminMembers members={(data ?? []) as MemberRow[]} billing={billing} nitrousAccess={nitrousAccess} />
    </div>
  );
}
