import { Hero } from "@/components/Hero";
import { SectionHeading } from "@/components/SectionHeading";
import { LeadershipCard } from "@/components/LeadershipCard";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { Button } from "@/components/Button";
import { leaders, leadershipValues } from "@/data/leadership";
import { buildMetadata } from "@/lib/metadata";
import { Heart, Repeat, ShieldCheck, Sprout, Star, Users } from "lucide-react";

export const metadata = buildMetadata({
  title: "Leadership",
  description:
    "Meet the 1 Mission leadership team. Our leadership is built on service, consistency, responsibility, development, example, and mentorship.",
  path: "/leadership",
});

const valueIcons = [Heart, Repeat, ShieldCheck, Sprout, Star, Users];

export default function LeadershipPage() {
  const featured = leaders.filter((l) => l.featured);
  const others = leaders.filter((l) => !l.featured);

  return (
    <>
      <Hero
        eyebrow="Leadership"
        title="Leadership is service, not status"
        description="At 1 Mission, leaders are made through consistency, responsibility, and a commitment to developing others. We lead from the front and grow people first."
      >
        <Button href="/contact" variant="white">Connect With a Leader</Button>
      </Hero>

      {/* Values */}
      <section className="section bg-gradient-ice">
        <div className="container-1m">
          <SectionHeading eyebrow="What We Stand For" title="The foundation of our leadership" />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {leadershipValues.map((v, i) => {
              const Icon = valueIcons[i % valueIcons.length];
              return (
                <div key={v.title} className="rounded-2xl border border-white bg-white p-6 shadow-card">
                  <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-primary text-white" aria-hidden="true">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 text-lg font-bold text-navy">{v.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-charcoal/70">{v.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Leaders */}
      <section className="section bg-white">
        <div className="container-1m">
          <SectionHeading eyebrow="Meet the Team" title="Our Leadership" description="Placeholder profiles until real details are provided. We never invent ranks or accomplishments." />
          <div className="mt-6">
            <DisclaimerBanner>
              The profiles below use placeholder names, photos, and biographies. Replace them with
              real, permission-granted information in <code className="rounded bg-white px-1">src/data/leadership.ts</code> before launch.
            </DisclaimerBanner>
          </div>

          {featured.length > 0 && (
            <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {featured.map((l) => <LeadershipCard key={l.id} leader={l} />)}
            </div>
          )}
          {others.length > 0 && (
            <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {others.map((l) => <LeadershipCard key={l.id} leader={l} />)}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
