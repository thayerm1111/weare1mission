import Link from "next/link";
import { redirect } from "next/navigation";
import { PortalNav } from "@/components/portal/PortalNav";
import { SignOutButton } from "@/components/portal/SignOutButton";
import { NotificationsBell } from "@/components/portal/NotificationsBell";
import { ThemeToggle } from "@/components/portal/ThemeToggle";
import { PendingNotice } from "@/components/portal/PendingNotice";
import { LowBalanceFlyer } from "@/components/portal/LowBalanceFlyer";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getProfile } from "@/lib/auth";
import { TIER_LABELS } from "@/lib/access";

export const metadata = { title: "Member Portal", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// Embed CSS: when the mobile app loads a tool page with ?embed=1, the inline
// script below adds `om-embed` (+ dark) to <html>, and these rules strip the
// portal's own top bar and side nav so ONLY the tool renders — full parity with
// the website, framed natively inside the app. Normal web usage is untouched.
const EMBED_CSS =
  ".om-embed .portal-topbar{display:none!important}" +
  ".om-embed .portal-nav{display:none!important}" +
  ".om-embed .portal-container{padding:6px 12px 28px!important;max-width:none!important}" +
  ".om-embed .portal-shell{grid-template-columns:1fr!important;margin-top:0!important;gap:0!important}" +
  "html.om-embed{background:#0a0b10}";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const configured = isSupabaseConfigured;
  const profile = configured ? await getProfile() : null;
  if (configured && !profile) redirect("/login");

  const isAdmin = profile?.role === "admin";
  const isOwner = (profile?.email ?? "").toLowerCase() === "thayerm1111@gmail.com";
  const needsApproval = profile != null && !isAdmin && profile.status !== "active";

  return (
    <div className="bg-cream">
      <script
        dangerouslySetInnerHTML={{
          __html:
            "(function(){try{var d=document.documentElement;if(location.search.indexOf('embed=1')>-1){d.classList.add('om-embed');d.classList.add('om-dark');}else if(localStorage.getItem('om-theme')==='dark'){d.classList.add('om-dark');}}catch(e){}})();",
        }}
      />
      <style dangerouslySetInnerHTML={{ __html: EMBED_CSS }} />
      <div className="portal-container mx-auto w-full max-w-[1760px] px-4 py-8 sm:px-6 lg:py-10">
        <div className="portal-topbar flex flex-col gap-4 border-b border-[#E7E4DD] pb-6 sm:flex-row sm:items-center sm:justify-between">
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
              {!needsApproval && <NotificationsBell />}
              <ThemeToggle />
              <SignOutButton />
            </div>
          )}
        </div>

        {needsApproval ? (
          <div className="mt-10">
            <PendingNotice status={profile!.status === "suspended" ? "suspended" : "pending"} name={profile!.full_name} />
          </div>
        ) : (
          <div className="portal-shell mt-8 grid gap-5 lg:grid-cols-[188px_1fr] xl:gap-7">
            <div className="portal-nav">{configured && profile && <PortalNav isAdmin={isAdmin} isOwner={isOwner} />}</div>
            <div className="min-w-0">{children}</div>
          </div>
        )}
      </div>
      {profile && !needsApproval && <LowBalanceFlyer />}
    </div>
  );
}
