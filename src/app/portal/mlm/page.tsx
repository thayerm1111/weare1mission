import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { MlmAdmin } from "@/components/portal/MlmAdmin";

export const metadata = { title: "Network HQ", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// For now, only the owner sees the network-marketing back office.
const OWNER_EMAIL = "thayerm1111@gmail.com";

export default async function NetworkHqPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user || (user.email ?? "").toLowerCase() !== OWNER_EMAIL) {
    redirect("/portal");
  }

  return <MlmAdmin />;
}
