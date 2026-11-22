import type { Metadata, Viewport } from "next";
import { cache } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getProfile as readProfile } from "@/lib/auth";
import { SHELL_COOKIE, SHELL_CSS, SHELL_SCRIPT, wantsNextShell } from "@/lib/floor/nav";
import { AppShell } from "@/components/om/AppShell";
import { CC_NEXT_CSS } from "@/components/command-center/hud/nextTheme";
import { APP_INSTALL_SCRIPT, APP_MANIFEST, APP_NAME, ATLAS_THEME } from "@/lib/floor/app";

const CC_METADATA: Metadata = { title: "Command Center XAUUSD", robots: { index: false, follow: false } };
/** The member's profile, read once per request for the layout and its metadata. */
const getProfile = cache(readProfile);
export const dynamic = "force-dynamic";

/*
 * Atlas is a tab of the One Mission app (lib/floor/app.ts): its page names the same app as the Floor's pages do, so
 * installing from here installs the same thing. The profile is read once per request, shared with the layout. Its
 * viewport is left as it was: this screen keeps its own frame inside the safe area.
 */
const inNewShell = cache(async (): Promise<boolean> => {
  if (!isSupabaseConfigured) return false;
  const profile = await getProfile();
  if (!profile) return false;
  return wantsNextShell(cookies().get(SHELL_COOKIE)?.value, profile.role === "admin");
});

export async function generateMetadata(): Promise<Metadata> {
  if (!(await inNewShell())) return CC_METADATA;
  return {
    ...CC_METADATA,
    manifest: APP_MANIFEST,
    appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
    icons: {
      icon: [{ url: "/om-app/icon-192.png", sizes: "192x192", type: "image/png" }],
      apple: [{ url: "/om-app/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    formatDetection: { telephone: false },
  };
}

export async function generateViewport(): Promise<Viewport> {
  return (await inNewShell()) ? { themeColor: ATLAS_THEME } : {};
}

/**
 * COMMAND CENTER XAUUSD gets its own full-bleed, chrome-free shell.
 *
 * The site's sticky white header and marketing footer belong to the public site and the portal frames
 * tools inside a page. The Command Center IS the page — dropping a living screen into a cream container
 * with a nav bar would make it look like one more widget, which is exactly what it is not.
 *
 * Next has a single root layout, so the chrome is removed the same way the portal's embed mode does it:
 * a class on <html> and two CSS rules. No client component, no hydration risk.
 */
const FULLSCREEN_CSS = `
html.om-fullscreen, html.om-fullscreen body { background:#06090E !important; }
html.om-fullscreen body > header, html.om-fullscreen body > footer { display:none !important; }
html.om-fullscreen [data-om-splash], html.om-fullscreen body > div[data-no-i18n].fixed { display:none !important; }
html.om-fullscreen [data-om-chrome] { display:none !important; }
html.om-fullscreen #main { flex:1 1 auto; }
html.om-fullscreen { color-scheme: dark; }
`;

export default async function CommandCenterLayout({ children }: { children: React.ReactNode }) {
  const profile = isSupabaseConfigured ? await getProfile() : null;
  if (isSupabaseConfigured && !profile) redirect("/login");
  const admin = profile?.role === "admin";
  /*
   * THE NEW DESIGN (owner 11-20 brief §11; for everyone since 11-21): the same Command Center in the platform's
   * materials. Every colour here is a CSS variable that falls back to its classic value (hud/theme.ts); this block
   * defines them, on <html> so the panels drawn into <body> (the broker sheet) follow. An admin who chose the classic
   * portal gets no block and sees exactly the classic colours. The entrance keeps its own.
   */
  const next = wantsNextShell(cookies().get(SHELL_COOKIE)?.value, admin);
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: FULLSCREEN_CSS + (next ? SHELL_CSS + CC_NEXT_CSS : "") }} />
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){try{document.documentElement.classList.add('om-fullscreen');${next ? "document.documentElement.classList.add('om-cc-next');" : ""}}catch(e){}})();`,
        }}
      />
      {next ? <>
        <script dangerouslySetInnerHTML={{ __html: SHELL_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: APP_INSTALL_SCRIPT }} />
        <AppShell atlas configured={isSupabaseConfigured} member={{ name: profile?.full_name ?? null, email: profile?.email ?? null, admin }} preview={admin}>
          <div className="om-cc-shell">{children}</div>
        </AppShell>
      </> : <div className="om-cc-shell" style={{ background: "#06090E", minHeight: "100vh" }}>{children}</div>}
    </>
  );
}
