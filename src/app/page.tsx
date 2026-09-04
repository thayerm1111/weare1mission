import { Hero2 } from "@/components/home/Hero2";
import { MarketsStrip } from "@/components/home/MarketsStrip";
import { ProblemNoise } from "@/components/home/ProblemNoise";
import { PlatformCards } from "@/components/home/PlatformCards";
import { ProcessRWE } from "@/components/home/ProcessRWE";
import { MattyPipsShowcase } from "@/components/home/MattyPipsShowcase";
import { AutomationFlow } from "@/components/home/AutomationFlow";
import { LiveTradingRoom } from "@/components/home/LiveTradingRoom";
import { ProofStats } from "@/components/home/ProofStats";
import { BeforeAfter } from "@/components/home/BeforeAfter";
import { Ecosystem } from "@/components/home/Ecosystem";
import { CommunityMovement } from "@/components/home/CommunityMovement";
import { CtaFinal } from "@/components/home/CtaFinal";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "One Mission | AI-Powered Trading Tools, Market Intelligence & Community",
  description:
    "The One Mission trading ecosystem — AI market intelligence, Gold analysis, automated trading tools, live trading education and a community built around structure.",
  path: "/",
});

/**
 * PUBLIC HOMEPAGE — trading-first redesign (premium fintech presentation).
 * Public-only components; the member platform, engines and APIs are untouched.
 */
export default function HomePage() {
  return (
    <>
      <Hero2 />
      <MarketsStrip />
      <ProblemNoise />
      <PlatformCards />
      <ProcessRWE />
      <MattyPipsShowcase />
      <AutomationFlow />
      <LiveTradingRoom />
      <ProofStats />
      <BeforeAfter />
      <Ecosystem />
      <CommunityMovement />
      <CtaFinal />
    </>
  );
}
