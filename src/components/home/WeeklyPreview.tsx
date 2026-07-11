import { CalendarDays, ArrowRight } from "lucide-react";
import { SectionHeading } from "../SectionHeading";
import { Button } from "../Button";

const preview = [
  { day: "Mon", title: "Leadership Call", cat: "Leadership" },
  { day: "Tue", title: "Get Paid Session", cat: "Business" },
  { day: "Wed", title: "Team Training", cat: "Training" },
  { day: "Thu", title: "Business Overview", cat: "Public" },
  { day: "Sat", title: "Community Session", cat: "Community" },
];

export function WeeklyPreview() {
  return (
    <section className="section bg-offwhite">
      <div className="container-1m">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-end">
          <SectionHeading
            align="left"
            eyebrow="Weekly Community"
            title="There's something every week"
            description="Live calls to learn, connect, and stay consistent. Times shown on the schedule page automatically adjust to your local timezone."
          />
          <Button href="/start-here" variant="secondary" className="flex-shrink-0">
            Join to Access <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {preview.map((e) => (
            <div key={e.day} className="rounded-2xl border border-ice bg-white p-5 shadow-card">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-primary">
                <CalendarDays className="h-4 w-4" aria-hidden="true" /> {e.day}
              </div>
              <h3 className="mt-3 text-base font-bold text-navy">{e.title}</h3>
              <span className="mt-2 inline-block rounded-full bg-ice px-2.5 py-0.5 text-xs font-medium text-navy">{e.cat}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-charcoal/50">
          * Sample, editable placeholder events. Update them in <code className="rounded bg-white px-1">src/data/schedule.ts</code>.
        </p>
      </div>
    </section>
  );
}
