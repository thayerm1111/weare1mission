import { Users2 } from "lucide-react";
import { LeadershipCard } from "@/components/LeadershipCard";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { leaders, leadershipValues } from "@/data/leadership";

export const metadata = { title: "Leadership", robots: { index: false, follow: false } };

export default function PortalLeadershipPage() {
  const featured = leaders.filter((l) => l.featured);
  const others = leaders.filter((l) => !l.featured);
  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Members Only</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <Users2 className="h-7 w-7 text-primary" aria-hidden="true" /> Leadership
        </h1>
        <p className="mt-2 text-charcoal/70">
          Leadership is built on service, consistency, responsibility, development, example, and mentorship.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {leadershipValues.map((v) => (
          <div key={v.title} className="rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-5">
            <h2 className="text-base font-bold text-navy">{v.title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-charcoal/70">{v.description}</p>
          </div>
        ))}
      </div>

      <DisclaimerBanner>
        Profiles use placeholder names, photos, and bios. Replace them with real, permission-granted
        details in <code className="rounded bg-cream px-1">src/data/leadership.ts</code>.
      </DisclaimerBanner>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {[...featured, ...others].map((l) => <LeadershipCard key={l.id} leader={l} />)}
      </div>
    </div>
  );
}
