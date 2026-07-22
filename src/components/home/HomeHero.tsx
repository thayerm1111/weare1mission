import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { MemberCard } from "./MemberCard";
import { OneMissionArc } from "../Logo";
import { siteSettings } from "@/data/siteSettings";

/**
 * Homepage hero — editorial serif headline (left) + member card on rotating
 * orbit rings (right). The "Get Started" button launches the guided setup
 * wizard at /get-started. Edit the pill/tagline/stats in src/data/siteSettings.ts.
 */
export function HomeHero() {
  const { established, heroPill, heroTagline, domain } = siteSettings;
  return (
    <section className="relative overflow-hidden bg-gradient-hero">
      <div className="container-1m relative grid items-center gap-14 py-16 sm:py-20 lg:grid-cols-2 lg:gap-8 lg:py-28">
        {/* Left — editorial copy */}
        <div className="relative z-10 animate-fade-up">
          <span className="inline-flex items-center gap-2.5 rounded-full border border-[#E7E4DD] bg-white/70 px-4 py-2 text-[11px] font-semibold uppercase tracking-label text-medium">
            <span className="h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
            {heroPill} · Est. {established}
          </span>

          <h1 className="mt-7 font-serif text-[clamp(2.5rem,7.6vw,5.5rem)] font-semibold uppercase leading-[0.92] tracking-[0.01em] text-navy">
            One Mission.
            <br />
            One Community.
            <br />
            <span className="gold-grad">One Movement.</span>
          </h1>

          <p className="mt-6 max-w-md text-xl leading-snug text-charcoal/75">
            {heroTagline}
          </p>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-charcoal/75">
            A community built on faith, financial freedom, health, meaningful
            experiences, and a shared vision for more. We believe abundance is
            available to everyone—and that no one reaches their highest potential
            alone. Together, we grow, lead, and create a life of purpose.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Link
              href="/get-started"
              className="group inline-flex items-center gap-2.5 rounded-none bg-primary px-8 py-4 text-[13px] font-medium uppercase tracking-[0.14em] text-white transition-colors hover:bg-black"
            >
              Get Started
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
            <Link
              href="#what-we-provide"
              className="inline-flex items-center gap-1.5 border-b border-primary/30 pb-1 text-sm font-semibold uppercase tracking-wider text-primary transition-colors hover:border-primary"
            >
              Explore 1 Mission
            </Link>
          </div>

          <p className="mt-8 text-sm font-medium tracking-wide text-medium">{domain}</p>
        </div>

        {/* Right — member card over a large faded 1M watermark */}
        <div className="relative flex min-h-[380px] items-center justify-center lg:min-h-[520px]">
          {/* Large branded 1M mark behind the card */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-visible" aria-hidden="true">
            <OneMissionArc className="w-[125%] max-w-[640px] text-primary/[0.07]" />
          </div>

          <div className="relative z-10 hero-float">
            <MemberCard />
          </div>
        </div>
      </div>

      {/* Bottom feature strip */}
      <div className="border-t border-[#E7E4DD] bg-offwhite/60">
        <div className="container-1m grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { k: "One Community", v: "A worldwide network united by purpose and standards." },
            { k: "One Mission", v: "Build the person, and meaningful results follow." },
            { k: "One Future", v: "Developing the next generation of leaders." },
            { k: "One Movement", v: "Be part of something bigger than yourself." },
          ].map((f) => (
            <div key={f.k} className="border-l border-primary/15 pl-4">
              <h2 className="text-xs font-bold uppercase tracking-label text-primary">{f.k}</h2>
              <p className="mt-2 text-sm leading-relaxed text-charcoal/65">{f.v}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
