import { notFound } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { isOperator } from "@/lib/fxscalper/owner";
import FxScalperDashboard from "@/components/fx-scalper/FxScalperDashboard";

export const metadata = { title: "FX Scalper" };
export const dynamic = "force-dynamic";

/** ONE MISSION FX SCALPER — the owner's live automation dashboard. Owner only (the API checks too). */
export default async function FxScalperPage() {
  const profile = await getProfile();
  if (!profile || !isOperator({ id: profile.id, email: profile.email })) notFound();
  return <FxScalperDashboard />;
}
