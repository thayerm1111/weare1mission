import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { MarketCommand } from "@/components/portal/MarketCommand";

export const metadata = { title: "OM AI Market Command" };
export const dynamic = "force-dynamic";

export default async function MarketCommandPage() {
  const profile = await getProfile().catch(() => null);
  // Admin-only during the beta phase — members are sent back to the Floor.
  if (!profile || profile.role !== "admin") redirect("/portal");
  return <MarketCommand />;
}
