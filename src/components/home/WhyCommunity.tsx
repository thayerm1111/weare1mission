import { MapPin, Users2, ShieldCheck, Repeat, Award, Sprout, Target } from "lucide-react";
import { SectionHeading } from "../SectionHeading";
import { PlaceholderImage } from "../PlaceholderImage";

const reasons = [
  { icon: MapPin, title: "Environment", text: "Your surroundings shape your standards. We build a culture that pulls you up." },
  { icon: Users2, title: "Mentorship", text: "Learn faster from people a few steps ahead who genuinely care." },
  { icon: ShieldCheck, title: "Accountability", text: "Consistency is easier when others expect the best from you." },
  { icon: Repeat, title: "Repetition", text: "Skills are built through reps. We give you room to practice." },
  { icon: Award, title: "Leadership", text: "Growth accelerates when you start leading and serving others." },
  { icon: Sprout, title: "Personal Development", text: "We invest in the whole person, not just the outcome." },
  { icon: Target, title: "Shared Goals", text: "Being around people chasing similar goals makes yours feel possible." },
];

export function WhyCommunity() {
  return (
    <section className="section bg-white">
      <div className="container-1m grid items-center gap-12 lg:grid-cols-[1fr_1.1fr]">
        <div className="order-2 lg:order-1">
          <PlaceholderImage label="Community lifestyle photo" aspect="portrait" className="shadow-card" />
        </div>
        <div className="order-1 lg:order-2">
          <SectionHeading
            align="left"
            eyebrow="Why Community Matters"
            title="You become who you're around"
            description="Talent and information are everywhere. What's rare is the right environment. 1 Mission surrounds you with the conditions that make growth almost inevitable."
          />
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {reasons.map((r) => (
              <div key={r.title} className="flex gap-3">
                <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg bg-ice text-primary" aria-hidden="true">
                  <r.icon className="h-4.5 w-4.5" />
                </span>
                <div>
                  <h3 className="text-sm font-bold text-navy">{r.title}</h3>
                  <p className="mt-0.5 text-sm leading-snug text-charcoal/70">{r.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
