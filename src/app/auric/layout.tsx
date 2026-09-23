import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getProfile } from "@/lib/auth";

export const metadata = { title: "AURIC — Gold automation", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** AURIC gets its own light, chrome-free shell (off-white, restrained gold). Auth-guarded like the portal. */
const CSS = `
html.om-auric, html.om-auric body { background:#F7F5F0 !important; color:#0F1A2B; }
html.om-auric body > header, html.om-auric body > footer { display:none !important; }
html.om-auric [data-om-splash], html.om-auric [data-no-i18n], html.om-auric [data-om-chrome] { display:none !important; }
html.om-auric #main { flex:1 1 auto; }
html.om-auric { color-scheme: light; }
`;

export default async function AuricLayout({ children }: { children: React.ReactNode }) {
  if (isSupabaseConfigured) {
    const profile = await getProfile();
    if (!profile) redirect("/login?redirect=/auric");
  }
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <script dangerouslySetInnerHTML={{ __html: "(function(){try{document.documentElement.classList.add('om-auric');}catch(e){}})();" }} />
      <div style={{ background: "#F7F5F0", minHeight: "100vh" }}>{children}</div>
    </>
  );
}
