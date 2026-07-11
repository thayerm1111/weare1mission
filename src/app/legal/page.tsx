import { Hero } from "@/components/Hero";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { siteSettings } from "@/data/siteSettings";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "Legal & Disclosures",
  description:
    "1 Mission legal information and disclosures: trading risk disclosure, earnings disclaimer, affiliate disclosure, testimonial disclaimer, privacy policy, terms of use, cookie notice, and educational purpose disclaimer.",
  path: "/legal",
});

/**
 * ⚠️  IMPORTANT — LEGAL REVIEW REQUIRED ⚠️
 * The text below is PLACEHOLDER language provided as a starting template only.
 * It is NOT legal advice and must be reviewed and finalized by a qualified
 * attorney licensed in your jurisdiction before this site goes live.
 * Edit each section's content to match your actual business practices.
 */
const lastUpdated = "Update this date when you finalize your policies";

interface Section {
  id: string;
  title: string;
  body: string[];
}

const sections: Section[] = [
  {
    id: "trading-risk-disclosure",
    title: "Trading Risk Disclosure",
    body: [
      "Trading and investing involve substantial risk, including the potential loss of all capital invested. You should never trade with money you cannot afford to lose.",
      "Past performance is not indicative of, and does not guarantee, future results. Markets are volatile and outcomes vary widely from person to person.",
      "All trading-related content provided by 1 Mission is for educational purposes only and does not constitute individualized financial, investment, tax, or legal advice.",
      "You are solely responsible for your own trading and financial decisions. Consult a qualified, licensed professional before making any financial decision.",
    ],
  },
  {
    id: "earnings-disclaimer",
    title: "Earnings Disclaimer",
    body: [
      "1 Mission makes no guarantee of income, earnings, or business results of any kind. Any examples are illustrative and should not be interpreted as typical or expected results.",
      "Individual results depend on many factors including effort, skill, consistency, market conditions, and circumstances outside of anyone's control. Many people who engage in these activities earn little or no money.",
      "Nothing on this website should be understood as a promise or guarantee of earnings. You accept full responsibility for your results.",
    ],
  },
  {
    id: "affiliate-disclosure",
    title: "Affiliate Disclosure",
    body: [
      "Members of the 1 Mission community may be independent affiliates who can earn compensation in connection with products, services, or memberships they refer, subject to applicable company terms.",
      "This means some links or referrals on this site or shared by members may result in compensation to the referring member. This does not affect the price you pay.",
      "Being an affiliate is optional and involves effort and risk. There is no guarantee of compensation.",
    ],
  },
  {
    id: "testimonial-disclaimer",
    title: "Testimonial Disclaimer",
    body: [
      "Testimonials reflect the individual experiences and opinions of the people providing them. They are not claims about typical results and should not be interpreted as such.",
      "Testimonials are not intended to represent or guarantee that anyone will achieve the same or similar outcomes. Placeholder testimonials on this site must be replaced with real, permission-granted statements before launch.",
    ],
  },
  {
    id: "privacy-policy",
    title: "Privacy Policy",
    body: [
      "This placeholder describes, in general terms, how 1 Mission may collect and use information. Replace it with a finalized policy reviewed by counsel.",
      "We may collect information you voluntarily provide (such as your name and email through forms) to respond to inquiries and provide community services. Progress tracking on this site is stored locally in your browser and is not transmitted to us in Version 1.",
      "We do not sell your personal information. We may use reputable third-party services (for example, hosting or email tools) that process data on our behalf.",
      "You may request access to or deletion of information you have provided by contacting us. Provide your real contact and data-handling details here before launch.",
    ],
  },
  {
    id: "terms-of-use",
    title: "Terms of Use",
    body: [
      "By accessing this website you agree to use it lawfully and respectfully. Content is provided for general informational and educational purposes and may change without notice.",
      "You may not misuse the site, attempt to disrupt it, or use its content in a misleading way. Community materials are provided for members' personal use and may be subject to additional community guidelines.",
      "This website is provided 'as is' without warranties of any kind. Replace this placeholder with finalized terms reviewed by an attorney, including governing law and liability provisions appropriate to your business.",
    ],
  },
  {
    id: "cookie-notice",
    title: "Cookie Notice",
    body: [
      "This site uses your browser's local storage to remember your onboarding and training progress on your device. This data stays in your browser and is not used to track you across other sites.",
      "If you later add analytics or third-party tools that use cookies, update this notice to disclose them and provide any required consent mechanism.",
    ],
  },
  {
    id: "educational-purpose-disclaimer",
    title: "Educational Purpose Disclaimer",
    body: [
      "All content on this website and within the 1 Mission community is provided strictly for educational and informational purposes.",
      "Nothing here constitutes financial, investment, legal, tax, medical, or other professional advice, and nothing should be relied upon as such. Always consult appropriately qualified professionals for your specific situation.",
    ],
  },
];

export default function LegalPage() {
  return (
    <>
      <Hero eyebrow="Legal & Disclosures" title="Important information" description="Please read these disclosures carefully. They explain the risks, our educational purpose, and how we handle information." />

      <div className="container-1m py-12 lg:py-16">
        <DisclaimerBanner tone="warning">
          The language on this page is a placeholder template and is <strong>not legal advice</strong>.
          It must be reviewed and finalized by a qualified attorney before this website is published.
        </DisclaimerBanner>

        <div className="mt-10 grid gap-10 lg:grid-cols-[240px_1fr]">
          {/* Table of contents */}
          <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
            <p className="mb-3 text-xs font-bold uppercase tracking-wider text-charcoal/50">On this page</p>
            <ul className="space-y-1.5">
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className="block rounded-lg px-3 py-1.5 text-sm text-charcoal/75 hover:bg-offwhite hover:text-primary">
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          {/* Sections */}
          <div className="max-w-2xl">
            <p className="text-sm text-charcoal/50">Last updated: {lastUpdated}</p>
            <div className="mt-6 space-y-12">
              {sections.map((s) => (
                <section key={s.id} id={s.id} className="scroll-mt-24">
                  <h2 className="text-2xl font-bold text-navy">{s.title}</h2>
                  <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-charcoal/80">
                    {s.body.map((p, i) => <p key={i}>{p}</p>)}
                  </div>
                </section>
              ))}
            </div>

            <p className="mt-12 border-t border-ice pt-6 text-sm text-charcoal/60">
              Questions about these disclosures? Contact us at{" "}
              <a href={`mailto:${siteSettings.supportEmail}`} className="font-semibold text-primary hover:text-medium">
                {siteSettings.supportEmail}
              </a>.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
