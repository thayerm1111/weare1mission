import { Link2, Settings, GraduationCap, TrendingUp } from "lucide-react";
import { SectionHeading } from "../SectionHeading";

const steps = [
  { icon: Link2, n: "01", title: "Get Connected", text: "Join the community, meet your mentor, and access the team communication channels." },
  { icon: Settings, n: "02", title: "Get Set Up", text: "Complete your accounts, applications, tools, and initial onboarding." },
  { icon: GraduationCap, n: "03", title: "Learn the System", text: "Follow the training, attend live sessions, and build your foundational skills." },
  { icon: TrendingUp, n: "04", title: "Grow and Lead", text: "Stay consistent, help others, develop leadership, and become an example in the community." },
];

export function Journey() {
  return (
    <section className="section bg-navy">
      <div className="container-1m">
        <SectionHeading
          light
          eyebrow="The 1 Mission Journey"
          title="Four simple steps to get started"
          description="A clear path from day one to leadership. You're never doing it alone."
        />
        <ol className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <li key={s.n} className="relative rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <div className="flex items-center justify-between">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-primary text-white" aria-hidden="true">
                  <s.icon className="h-5 w-5" />
                </span>
                <span className="text-3xl font-black text-white/15">{s.n}</span>
              </div>
              <h3 className="mt-4 text-lg font-bold text-white">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-light/80">{s.text}</p>
              {i < steps.length - 1 && (
                <span className="absolute -right-3 top-1/2 hidden -translate-y-1/2 text-white/20 lg:block" aria-hidden="true">→</span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
