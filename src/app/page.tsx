import { Hero2 } from "@/components/home/Hero2";
import { MarketsStrip } from "@/components/home/MarketsStrip";
import { ProblemNoise } from "@/components/home/ProblemNoise";
import { PlatformCards } from "@/components/home/PlatformCards";
import { ProcessRWE } from "@/components/home/ProcessRWE";
import { MattyPipsShowcase } from "@/components/home/MattyPipsShowcase";
import { AutomationFlow } from "@/components/home/AutomationFlow";
import { CommunityBridge } from "@/components/home/CommunityBridge";
import { TheRoom } from "@/components/home/TheRoom";
import { ProofStats } from "@/components/home/ProofStats";
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
 * PUBLIC HOMEPAGE v2 — trading technology dominates the first 60%, then the
 * community hits hard, then the movement lands earned. Public-only components;
 * the member platform, engines and APIs are untouched. Social-proof section is
 * intentionally absent until real permission-granted testimonials exist.
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
      <CommunityBridge />
      <TheRoom />
      <ProofStats />
      <Ecosystem />
      <CommunityMovement />
      <CtaFinal />
    </>
  );
}
