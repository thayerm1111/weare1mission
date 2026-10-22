import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { settingsFrom } from "@/lib/cashtrap/store";
import { CashtrapDashboard } from "@/components/cashtrap/CashtrapDashboard";

export const metadata = { title: "Cashtrap", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Cashtrap — admins always; active members only once the owner opens it (Cashtrap settings → visibility). */
export default async function CashtrapPage() {
  const profile = await getProfile().catch(() => null);
  if (!profile) redirect("/login");
  const isAdmin = profile.role === "admin";
  if (!isAdmin) {
    const db = createAdminClient();
    const r = db ? await db.from("cashtrap_settings").select("*").eq("id", 1).maybeSingle() : null;
    const { settings } = settingsFrom((r?.data as Record<string, unknown> | null) ?? null);
    if (!(settings.visibility === "members" && profile.status === "active")) redirect("/portal");
  }
  return <CashtrapDashboard isAdmin={isAdmin} />;
}
