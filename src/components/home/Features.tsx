import { LineChart, Briefcase, Users, ShieldCheck, ArrowRight } from "lucide-react";
import Link from "next/link";
import { SectionHeading } from "../SectionHeading";

const features = [
  {
    icon: LineChart,
    title: "Trading Education",
    description: "Structured education on the fundamentals — always education, never guarantees. Learn at your pace with live sessions and resources.",
    href: "/start-here",
  },
  {
    icon: Briefcase,
    title: "Business Development",
    description: "Practical skills for building the right way: communication, consistency, and duplicable systems you can actually follow.",
    href: "/start-here",
  },
  {
    icon: Users,
    title: "Leadership & Mentorship",
    description: "Real mentorship from people invested in your growth. Learn to lead by serving, and develop the next generation of leaders.",
    href: "/start-here",
  },
  {
    icon: ShieldCheck,
    title: "Community & Accountability",
    description: "The right environment changes everything. Surround yourself with people chasing similar goals who hold you to your best.",
    href: "/start-here",
  },
];

export function Features() {
  return (
    <section id="what-we-provide" className="section bg-gradient-ice scroll-mt-20">
      <div className="container-1m">
        <SectionHeading
          eyebrow="What 1 Mission Provides"
          title="Everything you need to grow, in one place"
          description="Four pillars that work together to develop you as a person and a professional."
        />
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f) => (
            <div key={f.title} className="group flex flex-col rounded-2xl border border-white bg-white p-6 shadow-card transition-all hover:-translate-y-1 hover:shadow-cardhover">
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-gradient-primary text-white shadow-[0_8px_20px_rgba(26,22,16,0.20)]" aria-hidden="true">
                <f.icon className="h-6 w-6" />
              </span>
              <h3 className="mt-5 text-lg font-bold text-navy">{f.title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-charcoal/70">{f.description}</p>
              <Link href={f.href} className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-medium">
                Learn more <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
