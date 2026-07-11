import { Hero } from "@/components/Hero";
import { TrainingClient } from "./TrainingClient";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "Affiliate Training",
  description:
    "The 1 Mission affiliate training platform: foundation, mindset, list building, inviting, presenting, follow-up, enrolling, duplication, leadership, and daily method of operation — with progress tracking.",
  path: "/training",
});

export default function TrainingPage() {
  return (
    <>
      <Hero
        eyebrow="Affiliate Training"
        title="Learn the skills. Build the right way."
        description="A structured, self-paced training path. Work through the modules, take action, and track your completion. Skills over shortcuts — always."
      />
      <div className="container-1m pt-8">
        <DisclaimerBanner tone="warning">
          Educational content only. Nothing here is individualized financial advice, and no income
          or results are guaranteed. Your results depend on your effort, skill, and many factors
          outside anyone&apos;s control.
        </DisclaimerBanner>
      </div>
      <TrainingClient />
    </>
  );
}
