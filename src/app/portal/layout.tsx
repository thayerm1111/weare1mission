import Link from "next/link";
import { redirect } from "next/navigation";
import { PortalNav } from "@/components/portal/PortalNav";
import { SignOutButton } from "@/components/portal/SignOutButton";
import { PendingNotice } from "@/components/portal/PendingNotice";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getProfile } from "@/lib/auth";
import { TIER_LABELS } from "@/lib/access";

export const metadata = { title: "Member Portal", robots: { index: false, follow: false } };

// Member content is per-user and auth-gated — never cache or prerender it.
export const dynamic = "force-dynamic";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const configured = isSupabaseConfigured;
  const profile = configured ? await getProfile() : null;

  // Middleware already redirects unauthenticated users, but guard again here.
  if (configured && !profile) redirect("/login");

  const isAdmin = profile?.role === "admin";
  // Members must be approved (status "active") — admins always have access.
  const needsApproval = profile != null && !isAdmin && profile.status !== "active";

  return (
    <div className="bg-cream">
      <div className="container-1m py-8 lg:py-12">
        {/* Portal top bar */}
        <div className="flex flex-col gap-4 border-b border-[#E4DCCB] pb-6 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/portal" className="inline-flex items-center gap-2.5 text-primary">
            <span className="text-base font-semibold uppercase tracking-[0.18em]">One Mission Portal</span>
          </Link>
          {profile && (
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-sm font-semibold text-navy">{profile.full_name || profile.email}</p>
                <p className="text-xs text-medium">
                  {needsApproval
                    ? (profile.status === "suspended" ? "Access paused" : "Pending approval")
                    : `${TIER_LABELS[profile.tier] ?? profile.tier} member${isAdmin ? " · Admin" : ""}`}
                </p>
              </div>
              <SignOutButton />
            </div>
          )}
        </div>

        {/* Approval gate: show a notice instead of member content until approved. */}
        {needsApproval ? (
          <div className="mt-10">
            <PendingNotice status={profile!.status === "suspended" ? "suspended" : "pending"} name={profile!.full_name} />
          </div>
        ) : (
          <div className="mt-8 grid gap-8 lg:grid-cols-[220px_1fr]">
            {configured && profile && <PortalNav isAdmin={isAdmin} />}
            <div className="min-w-0">{children}</div>
          </div>
        )}
      </div>
    </div>
  );
}
