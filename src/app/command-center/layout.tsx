import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getProfile } from "@/lib/auth";

export const metadata = { title: "Command Center XAUUSD", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

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
html.om-fullscreen #main { flex:1 1 auto; }
html.om-fullscreen { color-scheme: dark; }
`;

export default async function CommandCenterLayout({ children }: { children: React.ReactNode }) {
  if (isSupabaseConfigured) {
    const profile = await getProfile();
    if (!profile) redirect("/login");
  }
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: FULLSCREEN_CSS }} />
      <script
        dangerouslySetInnerHTML={{
          __html: "(function(){try{document.documentElement.classList.add('om-fullscreen');}catch(e){}})();",
        }}
      />
      <div className="om-cc-shell" style={{ background: "#06090E", minHeight: "100vh" }}>{children}</div>
    </>
  );
}
