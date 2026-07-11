import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { MemberCard } from "./MemberCard";
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
          <span className="inline-flex items-center gap-2.5 rounded-full border border-[#E4DCCB] bg-cream/70 px-4 py-2 text-[11px] font-semibold uppercase tracking-label text-medium">
            <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
            {heroPill} · Est. {established}
          </span>

          <h1 className="mt-7 font-serif text-[clamp(2.75rem,8.4vw,6.25rem)] font-black leading-[0.95] tracking-tight text-navy">
            One Mission.
            <br />
            One Community.
            <br />
            <span className="gold-grad">One Movement.</span>
          </h1>

          <p className="mt-5 font-serif text-2xl italic text-charcoal/70">
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
              className="group inline-flex items-center gap-2.5 rounded-full bg-gradient-primary px-8 py-4 text-sm font-semibold text-cream shadow-glow transition-transform hover:-translate-y-0.5"
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

        {/* Right — member card on rotating orbit rings */}
        <div className="relative flex min-h-[380px] items-center justify-center lg:min-h-[520px]">
          {/* Orbit rings */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
            <div className="slow-spin absolute aspect-square w-[135%] max-w-[720px] rounded-full border border-dashed border-gold/25" />
            <div className="slow-spin-rev absolute aspect-square w-[98%] max-w-[540px] rounded-full border border-dashed border-gold/20" />
            <div className="absolute aspect-square w-[62%] max-w-[340px] rounded-full border border-[#E7DFCE]" />
            {/* Floating accent dots */}
            <span className="absolute left-[12%] top-[26%] h-2 w-2 rounded-full bg-gold/60" />
            <span className="absolute right-[14%] top-[40%] h-1.5 w-1.5 rounded-full bg-gold/50" />
            <span className="absolute bottom-[22%] left-[24%] h-1.5 w-1.5 rounded-full bg-gold/40" />
          </div>

          <div className="relative z-10 hero-float">
            <MemberCard />
          </div>
        </div>
      </div>

      {/* Bottom feature strip */}
      <div className="border-t border-[#E4DCCB] bg-offwhite/60">
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
