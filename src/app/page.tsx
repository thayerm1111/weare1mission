import { HomeHero } from "@/components/home/HomeHero";
import { Origin } from "@/components/home/Origin";
import { Vision } from "@/components/home/Vision";
import { TwoPaths } from "@/components/home/TwoPaths";
import { WhyCommunity } from "@/components/home/WhyCommunity";
import { WeeklyPreview } from "@/components/home/WeeklyPreview";
import { LeadershipPreview } from "@/components/home/LeadershipPreview";
import { Testimonials } from "@/components/home/Testimonials";
import { FinalCta } from "@/components/home/FinalCta";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "1 Mission | One Mission. One Community. One Movement.",
  description:
    "A private community for the ones who want more — learning to master the markets, build real businesses, and become the best version of themselves. Request your place.",
  path: "/",
});

export default function HomePage() {
  return (
    <>
      <HomeHero />
      <Origin />
      <Vision />
      <TwoPaths />
      <WhyCommunity />
      <WeeklyPreview />
      <LeadershipPreview />
      <Testimonials />
      <FinalCta />
    </>
  );
}
