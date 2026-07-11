import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { AdminMembers, type MemberRow } from "@/components/portal/AdminMembers";

export const metadata = { title: "Approvals", robots: { index: false, follow: false } };

export default async function AdminPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile();
  if (!profile || profile.role !== "admin") redirect("/portal");

  // Admins can read all profiles (row-level security allows it).
  const { data } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, tier, status, created_at")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Admin</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <ShieldCheck className="h-7 w-7 text-primary" aria-hidden="true" /> Member Approvals
        </h1>
        <p className="mt-2 text-charcoal/70">Approve new sign-ups and manage member tiers and access.</p>
      </header>
      <AdminMembers members={(data ?? []) as MemberRow[]} />
    </div>
  );
}
