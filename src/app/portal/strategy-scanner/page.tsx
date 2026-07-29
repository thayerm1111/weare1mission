import { StrategyScanner } from "@/components/portal/StrategyScanner";
import { getProfile } from "@/lib/auth";

export const metadata = { title: "OM Strategy Scanner" };
export const dynamic = "force-dynamic";

export default async function StrategyScannerPage() {
  const profile = await getProfile().catch(() => null);
  const isAdmin = profile?.role === "admin";
  return <StrategyScanner isAdmin={isAdmin} />;
}
