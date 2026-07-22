import Link from "next/link";
import { ArrowRight, LineChart, Rocket } from "lucide-react";

/**
 * TwoPaths — lets a visitor self-identify. Mirrors the member back office:
 *   The One    → customers (trading, mindset, MFX, featured traders)
 *   The Builder → affiliates (sales, mindset, daily goals, dev audios)
 * A black card + a white card — the OMC split, applied to the offer.
 */
const one = {
  label: "For The One",
  title: "Master the markets & your mind",
  points: [
    "Learn to trade from real 1 Mission traders",
    "Rewire your mindset and your identity",
    "MFX — the Multi-Market Experience, a collective of educators",
    "Live trade setups shared with the community",
    "Featured traders you can actually learn from",
  ],
  cta: "Enter as The One",
  href: "/signup",
};

const builder = {
  label: "For The Builder",
  title: "Build the business & the leader",
  points: [
    "Master real, transferable sales skills",
    "Daily goals and genuine accountability",
    "Personal-development audios to train your mind",
    "Mindset and discipline, every single day",
    "Learn to build, lead, and serve a team",
  ],
  cta: "Enter as The Builder",
  href: "/signup",
};

export function TwoPaths() {
  return (
    <section id="paths" className="section bg-offwhite">
      <div className="container-1m">
        <div className="mx-auto max-w-2xl text-center">
          <span className="eyebrow justify-center">Two Ways In</span>
          <h2 className="mt-5 font-serif text-[2rem] font-semibold uppercase leading-[1.06] tracking-[0.03em] text-navy sm:text-[2.5rem]">
            Two paths. One mission.
          </h2>
          <p className="mt-4 text-lg text-charcoal/70">
            Everyone arrives for a different reason. Find yours.
          </p>
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-2">
          {/* The One — dark */}
          <div className="flex flex-col rounded-2xl bg-navy p-8 sm:p-10">
            <LineChart className="h-7 w-7 text-gold-light" aria-hidden="true" />
            <p className="mt-6 text-[11px] font-semibold uppercase tracking-label text-gold-light">
              {one.label}
            </p>
            <h3 className="mt-3 font-serif text-2xl font-semibold uppercase tracking-[0.02em] text-white sm:text-3xl">
              {one.title}
            </h3>
            <ul className="mt-6 flex-1 space-y-3">
              {one.points.map((p) => (
                <li key={p} className="flex gap-3 text-sm leading-relaxed text-light/85">
                  <span className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-gold-light" aria-hidden="true" />
                  {p}
                </li>
              ))}
            </ul>
            <Link
              href={one.href}
              className="group mt-8 inline-flex items-center gap-2.5 self-start rounded-none bg-white px-7 py-3.5 text-[13px] font-medium uppercase tracking-[0.14em] text-navy transition-colors hover:bg-ice"
            >
              {one.cta}
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          </div>

          {/* The Builder — light */}
          <div className="flex flex-col rounded-2xl border border-ice bg-white p-8 sm:p-10">
            <Rocket className="h-7 w-7 text-primary" aria-hidden="true" />
            <p className="mt-6 text-[11px] font-semibold uppercase tracking-label text-gold">
              {builder.label}
            </p>
            <h3 className="mt-3 font-serif text-2xl font-semibold uppercase tracking-[0.02em] text-navy sm:text-3xl">
              {builder.title}
            </h3>
            <ul className="mt-6 flex-1 space-y-3">
              {builder.points.map((p) => (
                <li key={p} className="flex gap-3 text-sm leading-relaxed text-charcoal/75">
                  <span className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-primary" aria-hidden="true" />
                  {p}
                </li>
              ))}
            </ul>
            <Link
              href={builder.href}
              className="group mt-8 inline-flex items-center gap-2.5 self-start rounded-none bg-primary px-7 py-3.5 text-[13px] font-medium uppercase tracking-[0.14em] text-white transition-colors hover:bg-black"
            >
              {builder.cta}
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
