import { HomeHero } from "@/components/home/HomeHero";
import { MissionStatement } from "@/components/home/MissionStatement";
import { Features } from "@/components/home/Features";
import { Journey } from "@/components/home/Journey";
import { WhyCommunity } from "@/components/home/WhyCommunity";
import { WeeklyPreview } from "@/components/home/WeeklyPreview";
import { LeadershipPreview } from "@/components/home/LeadershipPreview";
import { Testimonials } from "@/components/home/Testimonials";
import { FinalCta } from "@/components/home/FinalCta";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "1 Mission | One Mission. One Community. One Movement.",
  description:
    "Join the 1 Mission community and access onboarding, affiliate training, leadership development, trading education resources, events, and weekly team sessions.",
  path: "/",
});

export default function HomePage() {
  return (
    <>
      <HomeHero />
      <MissionStatement />
      <Features />
      <Journey />
      <WhyCommunity />
      <WeeklyPreview />
      <LeadershipPreview />
      <Testimonials />
      <FinalCta />
    </>
  );
}
