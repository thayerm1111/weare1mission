import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import MattyPips from "@/components/matty-pips/MattyPips";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "MATTY PIPS | 1 Mission",
  description: "READ THE MARKET. FIND THE LEVEL. WAIT FOR THE TRADE.",
};

/**
 * MATTY PIPS — standalone, isolated tool page. Same member login as the rest
 * of the platform; no links into or out of FLOW/GENX. Reachable directly at
 * /matty-pips.
 */
export default async function MattyPipsPage() {
  const profile = await getProfile();
  if (!profile) redirect("/login?redirect=%2Fmatty-pips");
  return <MattyPips />;
}
