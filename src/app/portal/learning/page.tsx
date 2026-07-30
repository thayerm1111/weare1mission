import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { LearningDesk } from "@/components/portal/LearningDesk";

export const metadata = { title: "Learning Desk", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function LearningPage() {
  const profile = await getProfile().catch(() => null);
  // Admin-only: this is the AI's self-audit / continuous-learning cockpit.
  if (!profile || profile.role !== "admin") redirect("/portal");
  return <LearningDesk />;
}
