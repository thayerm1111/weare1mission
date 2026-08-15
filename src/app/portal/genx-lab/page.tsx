import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { GenxLab } from "@/components/portal/GenxLab";

export const metadata = { title: "GENX Lab", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function GenxLabPage() {
  const profile = await getProfile().catch(() => null);
  // Admin-only: GENX's recorded-signal ledger and outcome analytics (spec §33–§35).
  if (!profile || profile.role !== "admin") redirect("/portal");
  return <GenxLab />;
}
