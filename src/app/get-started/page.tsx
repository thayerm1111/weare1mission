import type { Metadata } from "next";
import { GetStartedWizard } from "@/components/getstarted/GetStartedWizard";

export const metadata: Metadata = {
  title: "Get Started",
  description: "Your guided 1 Mission setup — get connected, set up to trade, and learn how everything works, one step at a time.",
  robots: { index: false, follow: false },
};

export default function GetStartedPage() {
  return <GetStartedWizard />;
}
