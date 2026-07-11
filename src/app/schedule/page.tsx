import { Hero } from "@/components/Hero";
import { ScheduleClient } from "./ScheduleClient";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { scheduleNotice } from "@/data/schedule";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "Weekly Schedule",
  description:
    "The 1 Mission weekly community schedule — leadership calls, training, business overviews, and community sessions. Times automatically shown in your local timezone.",
  path: "/schedule",
});

export default function SchedulePage() {
  return (
    <>
      <Hero
        eyebrow="Weekly Community"
        title="Weekly Schedule"
        description="Live calls to learn, connect, and stay consistent. Every time below is automatically converted to your local timezone."
      />
      <div className="container-1m pt-8">
        <DisclaimerBanner>{scheduleNotice}</DisclaimerBanner>
      </div>
      <ScheduleClient />
    </>
  );
}
