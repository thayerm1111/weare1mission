import { SectionHeading } from "../SectionHeading";

const pillars = [
  "Building people", "Creating leaders", "Developing valuable skills",
  "Becoming more disciplined", "Growing together", "A worldwide community",
];

export function MissionStatement() {
  return (
    <section className="section bg-white">
      <div className="container-1m grid items-center gap-12 lg:grid-cols-2">
        <SectionHeading
          align="left"
          eyebrow="Our Purpose"
          title="We Are 1 Mission"
          description="1 Mission exists to build people first. We believe when you develop the person — their skills, their discipline, their character — meaningful results in health, wealth, relationships, and purpose follow. We're not just teaching tactics; we're growing a worldwide community that gets stronger together."
        />
        <div className="grid grid-cols-2 gap-3 sm:gap-4">
          {pillars.map((p, i) => (
            <div
              key={p}
              className="rounded-xl border border-ice bg-offwhite p-4 sm:p-5"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-primary text-sm font-bold text-white" aria-hidden="true">
                {i + 1}
              </span>
              <p className="mt-3 text-sm font-semibold text-navy">{p}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
