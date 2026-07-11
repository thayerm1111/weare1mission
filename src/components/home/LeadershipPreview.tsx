import { ArrowRight } from "lucide-react";
import { SectionHeading } from "../SectionHeading";
import { Button } from "../Button";
import { LeadershipCard } from "../LeadershipCard";
import { leaders } from "@/data/leadership";

export function LeadershipPreview() {
  const featured = leaders.filter((l) => l.featured).slice(0, 3);
  const shown = featured.length ? featured : leaders.slice(0, 3);
  return (
    <section className="section bg-white">
      <div className="container-1m">
        <SectionHeading
          eyebrow="Leadership Preview"
          title="Led by people who serve"
          description="Meet a few of the leaders helping members grow. Profiles are placeholders until real details are added."
        />
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((l) => <LeadershipCard key={l.id} leader={l} />)}
        </div>
        <div className="mt-10 text-center">
          <Button href="/start-here" variant="secondary">
            Join the Community <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </section>
  );
}
