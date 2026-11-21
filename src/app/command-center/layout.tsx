import type { Metadata, Viewport } from "next";
import { cache } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getProfile } from "@/lib/auth";
import { SHELL_COOKIE, wantsNextShell } from "@/lib/floor/nav";
import { CC_NEXT_CSS } from "@/components/command-center/hud/nextTheme";
import { APP_MANIFEST, APP_NAME, APP_THEME } from "@/lib/floor/app";

const CC_METADATA: Metadata = { title: "Command Center XAUUSD", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/*
 * Atlas is a tab of the One Mission app (lib/floor/app.ts): in the preview its page names the same app as the
 * Floor's pages do, so installing from here installs the same thing. The cookie is read first, so nobody else's
 * page costs an extra lookup. Its viewport is left as it was: this screen keeps its own frame inside the safe area.
 */
const inNewShell = cache(async (): Promise<boolean> => {
  if (!isSupabaseConfigured || cookies().get(SHELL_COOKIE)?.value !== "next") return false;
  const profile = await getProfile();
  return wantsNextShell("next", profile?.role === "admin");
});

export async function generateMetadata(): Promise<Metadata> {
  if (!(await inNewShell())) return CC_METADATA;
  return {
    ...CC_METADATA,
    manifest: APP_MANIFEST,
    appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "black" },
    icons: {
      icon: [{ url: "/om-app/icon-192.png", sizes: "192x192", type: "image/png" }],
      apple: [{ url: "/om-app/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    formatDetection: { telephone: false },
  };
}

export async function generateViewport(): Promise<Viewport> {
  return (await inNewShell()) ? { themeColor: APP_THEME } : {};
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
html.om-fullscreen [data-om-splash], html.om-fullscreen [data-no-i18n] { display:none !important; }
html.om-fullscreen [data-om-chrome] { display:none !important; }
html.om-fullscreen #main { flex:1 1 auto; }
html.om-fullscreen { color-scheme: dark; }
`;

export default async function CommandCenterLayout({ children }: { children: React.ReactNode }) {
  let admin = false;
  if (isSupabaseConfigured) {
    const profile = await getProfile();
    if (!profile) redirect("/login");
    admin = profile.role === "admin";
  }
  /*
   * THE REDESIGN PREVIEW (owner 11-20 brief §11), for an admin who has switched it on: the same Command Center in
   * the platform's materials. Every colour here is a CSS variable that falls back to its classic value
   * (hud/theme.ts); this block defines them, on <html> so the panels drawn into <body> (the broker sheet) follow.
   * Everyone else gets no block and sees exactly the classic colours. The entrance keeps its own.
   */
  const next = wantsNextShell(cookies().get(SHELL_COOKIE)?.value, admin);
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: FULLSCREEN_CSS + (next ? CC_NEXT_CSS : "") }} />
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){try{document.documentElement.classList.add('om-fullscreen');${next ? "document.documentElement.classList.add('om-cc-next');" : ""}}catch(e){}})();`,
        }}
      />
      <div className="om-cc-shell" style={{ background: next ? "#08090E" : "#06090E", minHeight: "100vh" }}>{children}</div>
    </>
  );
}
