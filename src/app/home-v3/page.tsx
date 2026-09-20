import Hero from "@/components/home3/Hero";
import HowItWorks from "@/components/home3/HowItWorks";
import { Ecosystem, CommandCenterMoment, TheFloorSection, Credibility, Close } from "@/components/home3/Sections";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "One Mission — Gold intelligence, running continuously",
  description:
    "Five systems watching XAUUSD as one: finding the opportunity, judging it, explaining it in plain words, taking it and managing it.",
  path: "/home-v3",
});

// A proposal should not compete with the real homepage in search results while it is being judged.
metadata.robots = { index: false, follow: false };

/**
 * HOMEPAGE v3 — a proposal, deliberately not yet the front door.
 *
 * It lives at its own address so it can be judged next to the page it would replace rather than
 * instead of it. Swapping the live homepage of a running business on an opinion is not a decision to
 * make on somebody's behalf; seeing both and choosing is.
 *
 * THE PALETTE IS SCOPED TO THIS PAGE. The site's brand system is stark monochrome — pure white, full
 * black, one bone accent. This proposal moves to soft white, cool grey and a restrained blue, with
 * gold kept for the two places gold is literally the subject. That is a brand change, not a layout
 * change, so it is declared here as local variables and touches nothing else. Adopting it means
 * promoting these six values into the design tokens; rejecting it means deleting one folder.
 *
 * WHAT IS NOT HERE, ON PURPOSE. No performance figures, no win rates, no testimonials. None exist in
 * a form anybody has permission to publish — the previous homepage carried a note saying exactly that
 * and it was correct. Credibility is carried instead by describing how the system behaves, which is
 * checkable by using it and which a competitor copying this page could not honestly repeat.
 */
const TOKENS = `
.h3 {
  --h3-page: #FBFCFE;        /* soft white, barely cool — warmer than grey, calmer than white */
  --h3-surface: #FFFFFF;
  --h3-ink: #0B0D12;         /* near-black with a blue cast, so it sits with the accent */
  --h3-muted: rgba(11,13,18,0.62);
  --h3-faint: rgba(11,13,18,0.40);
  --h3-line: rgba(11,13,18,0.09);
}

/* The entrance. Runs from CSS on load rather than waiting for hydration, so the first paint is
   already the finished frame — the hero never flashes in after the JavaScript arrives. */
@keyframes h3-in { from { opacity: 0; transform: translate3d(0, 16px, 0); } to { opacity: 1; transform: none; } }
.h3 .h3-in { opacity: 0; animation: h3-in 1000ms cubic-bezier(0.16,1,0.3,1) forwards; }

/* The one hover in the page's vocabulary: a lift and a shadow, no colour change. Colour-change hovers
   read as a link; a lift reads as a physical control. */
.h3 .h3-cta { transition: transform 420ms cubic-bezier(0.16,1,0.3,1), box-shadow 420ms cubic-bezier(0.16,1,0.3,1); box-shadow: 0 1px 2px rgba(11,13,18,0.18); }
.h3 .h3-cta:hover { transform: translateY(-1.5px); box-shadow: 0 14px 30px -12px rgba(11,13,18,0.45); }

@media (prefers-reduced-motion: reduce) {
  .h3 .h3-in { opacity: 1; animation: none; }
  .h3 .h3-cta { transition: none; }
  .h3 * { scroll-behavior: auto !important; }
}
`;

export default function HomeV3() {
  return (
    <div className="h3" style={{ background: "var(--h3-page)" }}>
      <style dangerouslySetInnerHTML={{ __html: TOKENS }} />
      <Hero />
      <Ecosystem />
      <HowItWorks />
      <CommandCenterMoment />
      <TheFloorSection />
      <Credibility />
      <Close />
    </div>
  );
}
