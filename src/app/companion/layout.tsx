import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getProfile } from "@/lib/auth";

export const metadata = { title: "ATLAS", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * THE COMPANION'S SHELL — the site's chrome removed, and the background taken away entirely.
 *
 * The Command Center suppresses the marketing header and footer and paints itself near-black. The
 * companion goes one step further: in the desktop shell its window has no decorations and no opaque
 * backing, so every surface between the operating system and the companion itself must be transparent
 * or it shows up as a white card floating over the member's work.
 *
 * The same authentication gate as the Command Center. A floating window that reports an account's
 * positions is not a lesser surface for being small.
 */
const BARE_CSS = `
html.om-companion, html.om-companion body { background: transparent !important; overflow: hidden; }
html.om-companion body > header, html.om-companion body > footer { display:none !important; }
html.om-companion [data-om-splash], html.om-companion [data-no-i18n] { display:none !important; }
html.om-companion [data-om-chrome] { display:none !important; }
html.om-companion #main { flex:1 1 auto; }
html.om-companion { color-scheme: dark; }
/* The shell drags the window by its header; text selection would fight that. */
html.om-companion [data-tauri-drag-region] { -webkit-user-select: none; user-select: none; }
`;

export default async function CompanionLayout({ children }: { children: React.ReactNode }) {
  if (isSupabaseConfigured) {
    const profile = await getProfile();
    if (!profile) redirect("/login");
  }
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: BARE_CSS }} />
      <script
        dangerouslySetInnerHTML={{
          __html: "(function(){try{document.documentElement.classList.add('om-companion');}catch(e){}})();",
        }}
      />
      <div style={{ background: "transparent", height: "100vh" }}>{children}</div>
    </>
  );
}
