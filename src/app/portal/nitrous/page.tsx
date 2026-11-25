import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { NitrousWorkspace } from "@/components/om/nitrous/NitrousWorkspace";

export const metadata = { title: "Nitrous · Slow Drip | One Mission" };
export const dynamic = "force-dynamic";

export default async function NitrousPage() {
  if (!createClient()) return <PortalNotConfigured />;
  const profile = await getProfile();
  return <NitrousWorkspace isAdmin={profile?.role === "admin"} />;
}
