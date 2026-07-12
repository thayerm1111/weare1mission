import { getProfile } from "@/lib/auth";
import { WhatsOnClient } from "@/components/portal/WhatsOnClient";

export const metadata = { title: "What's On", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function WhatsOnPage() {
  const profile = await getProfile();
  return <WhatsOnClient isAdmin={profile?.role === "admin"} />;
}
