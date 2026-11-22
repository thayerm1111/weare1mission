import type { Metadata, Viewport } from "next";
import { cache } from "react";
import Link from "next/link";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/om/AppShell";
import { APP_SHELL_RECOVERY_SCRIPT, CLASSIC_SHELL, SHELL_COOKIE, SHELL_CSS, SHELL_SCRIPT, wantsNextShell } from "@/lib/floor/nav";
import { APP_INSTALL_SCRIPT, APP_MANIFEST, APP_NAME, APP_THEME } from "@/lib/floor/app";
import { PortalNav } from "@/components/portal/PortalNav";
import { SignOutButton } from "@/components/portal/SignOutButton";
import { NotificationsBell } from "@/components/portal/NotificationsBell";
import { ThemeToggle } from "@/components/portal/ThemeToggle";
import { PendingNotice } from "@/components/portal/PendingNotice";
import { LowBalanceFlyer } from "@/components/portal/LowBalanceFlyer";
import { AtlasAnnouncement } from "@/components/portal/AtlasAnnouncement";
import { PassNewsBanner } from "@/components/portal/PassNewsBanner";
import RiskConsentGate from "@/components/command-center/RiskConsentGate";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getProfile as readProfile } from "@/lib/auth";
import { TIER_LABELS } from "@/lib/access";

const PORTAL_METADATA: Metadata = { title: "Member Portal", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** The member's profile, read once per request for the layout, its metadata and its viewport. */
const getProfile = cache(readProfile);

/*
 * THE ONE MISSION APP (owner 11-21, lib/floor/app.ts). A page in the new shell says it can be installed: the
 * manifest, the home-screen icon and name, a status bar in the page's own colour, and a viewport that reaches the
 * screen's edges (the shell pads itself by the safe areas, om.css). The same answer as the layout's own: every active
 * member, unless an admin chose the classic portal.
 */
const inNewShell = cache(async (): Promise<boolean> => {
  if (!isSupabaseConfigured) return false;
  const profile = await getProfile();
  if (!profile) return false;
  const isAdmin = profile.role === "admin";
  if (!isAdmin && profile.status !== "active") return false;
  return wantsNextShell(cookies().get(SHELL_COOKIE)?.value, isAdmin, headers());
});

export async function generateMetadata(): Promise<Metadata> {
  if (!(await inNewShell())) return PORTAL_METADATA;
  return {
    ...PORTAL_METADATA,
    manifest: APP_MANIFEST,
    // A light status bar with dark text: the default look is Stone (lib/floor/look.ts).
    appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
    icons: {
      icon: [{ url: "/om-app/icon-192.png", sizes: "192x192", type: "image/png" }],
      apple: [{ url: "/om-app/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    // A trading screen is full of long numbers; none of them is a phone number to dial.
    formatDetection: { telephone: false },
  };
}

export async function generateViewport(): Promise<Viewport> {
  return (await inNewShell()) ? { themeColor: APP_THEME, viewportFit: "cover" } : {};
}

// Embed CSS: when the mobile app loads a tool page with ?embed=1, the inline
// script below adds `om-embed` (+ dark) to <html>, and these rules strip the
// portal's own top bar and side nav so ONLY the tool renders — full parity with
// the website, framed natively inside the app. Normal web usage is untouched.
const EMBED_CSS =
  ".om-embed .portal-topbar{display:none!important}" +
  ".om-embed .portal-nav{display:none!important}" +
  ".om-embed .portal-news{display:none!important}" +
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
  const recoverApp = isAdmin && cookies().get(SHELL_COOKIE)?.value === CLASSIC_SHELL;

  /*
   * THE NEW DESIGN (owner 11-20 brief; for everyone since 11-21, "push live to everyone"). Every active member
   * gets the new shell around every portal page: one floating bar — The Floor, OM AI Plays, GENX, Market Pulse,
   * FLOW, Atlas — and a short account menu, with no sidebar and no community destinations. A member who is
   * pending or suspended keeps the classic portal's notice below; an admin can choose the classic portal from
   * the account menu (nav.wantsNextShell), for support. The risk disclosure and the low-balance prompt still
   * apply inside it.
   */
  if (profile && !needsApproval && wantsNextShell(cookies().get(SHELL_COOKIE)?.value, isAdmin, headers())) {
    return (
      <>
        {recoverApp && <script dangerouslySetInnerHTML={{ __html: APP_SHELL_RECOVERY_SCRIPT }} />}
        <style dangerouslySetInnerHTML={{ __html: SHELL_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: SHELL_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: APP_INSTALL_SCRIPT }} />
        <AppShell member={{ name: profile.full_name, email: profile.email, admin: isAdmin }} preview={isAdmin}>{children}</AppShell>
        <LowBalanceFlyer />
        <RiskConsentGate />
      </>
    );
  }

  return (
    <div className="bg-cream">
      {recoverApp && <script dangerouslySetInnerHTML={{ __html: APP_SHELL_RECOVERY_SCRIPT }} />}
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
          <>
          {profile && <div className="portal-news"><PassNewsBanner /></div>}
          <div className="portal-shell mt-8 grid gap-5 lg:grid-cols-[188px_1fr] xl:gap-7">
            <div className="portal-nav">{configured && profile && <PortalNav isAdmin={isAdmin} isOwner={isOwner} />}</div>
            <div className="min-w-0">{children}</div>
          </div>
          </>
        )}
      </div>
      {profile && !needsApproval && <LowBalanceFlyer />}
      {profile && !needsApproval && <AtlasAnnouncement />}
      {/*
        * The risk disclosure, shown on the way in rather than at the moment somebody wants to trade.
        * It renders nothing for a member who has already signed, and it does not lock the portal —
        * trading is gated on the server, which is where a gate is worth anything.
        */}
      {profile && !needsApproval && <RiskConsentGate />}
      {/* SuiteFlyer retired (owner 09-08): the $39/mo Trading Suite is no longer offered —
          members buy credits or auto-refill instead. Existing subscribers keep their plan
          and manage it from the account page. */}
    </div>
  );
}
