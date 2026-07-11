import { ArrowRight } from "lucide-react";
import { Button } from "../Button";
import { HeroMark } from "../HeroMark";
import { siteSettings } from "@/data/siteSettings";

export function HomeHero() {
  return (
    <section className="relative overflow-hidden bg-gradient-hero">
      <div className="container-1m relative grid items-center gap-12 py-16 sm:py-20 lg:grid-cols-2 lg:gap-8 lg:py-28">
        {/* Left — editorial copy */}
        <div className="animate-fade-up">
          <p className="eyebrow">We Are</p>
          <h1 className="mt-4 text-[3.25rem] font-extrabold leading-[0.95] tracking-tight text-primary text-balance sm:text-7xl">
            One Mission.
            <br />
            One Community.
            <br />
            One Movement.
          </h1>

          <div className="mt-7 flex items-center gap-4">
            <span className="hairline w-10" aria-hidden="true" />
            <p className="text-sm font-semibold uppercase tracking-label text-medium">
              Health · Wealth · Leadership · Purpose
            </p>
          </div>

          <p className="mt-6 max-w-md text-lg leading-relaxed text-charcoal/75">
            A community built for people who are ready to grow in business, leadership, trading
            education, personal development, and life.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button href="/start-here" size="lg">
              Start Here <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
            <a
              href="#what-we-provide"
              className="inline-flex items-center gap-1.5 border-b border-primary/30 pb-1 text-sm font-semibold uppercase tracking-wider text-primary transition-colors hover:border-primary"
            >
              Explore 1 Mission
            </a>
          </div>

          <p className="mt-8 text-sm font-medium tracking-wide text-medium">{siteSettings.domain}</p>
        </div>

        {/* Right — oversized 1M mark (3D image with monogram fallback) */}
        <div className="relative flex animate-fade-in justify-center lg:justify-end">
          <HeroMark />
        </div>
      </div>

      {/* Bottom feature strip — matches the "ONE COMMUNITY / ONE MISSION / …" row */}
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
