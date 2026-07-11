import { Hero } from "@/components/Hero";
import { Button } from "@/components/Button";
import { StartHereClient } from "./StartHereClient";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "Start Here — Member Onboarding",
  description:
    "Your guided 1 Mission onboarding. Get connected, set up your accounts and tools, learn the basics, and begin your first 30 days — with progress tracking.",
  path: "/start-here",
});

export default function StartHerePage() {
  return (
    <>
      <Hero
        eyebrow="New Member Onboarding"
        title="Start Here"
        description="Welcome to 1 Mission. Follow these steps at your own pace to get fully connected and set up for success. Your progress saves automatically on this device."
      >
        <Button href="/contact" variant="white">Contact Your Mentor</Button>
        <Button href="/schedule" variant="ghost" className="border border-white/25 text-white hover:bg-white/10">View Schedule</Button>
      </Hero>
      <StartHereClient />
    </>
  );
}
