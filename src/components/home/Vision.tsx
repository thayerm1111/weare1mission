import { SectionHeading } from "../SectionHeading";
import { OneMissionArc } from "../Logo";

/**
 * Vision — the life being built. Type-forward manifesto with a bold statement
 * panel (swap the panel for a real hero-quality lifestyle photo when ready).
 */
const pillars = [
  { k: "Master the markets", d: "Trade with a system, and a room that has your back." },
  { k: "Build your business", d: "Turn skill into income that's actually yours." },
  { k: "Own your time", d: "Design days that answer to you — no one else." },
  { k: "See the world", d: "Real experiences and travel with people who get it." },
  { k: "Sharpen your mind", d: "Daily reps on mindset, discipline, and identity." },
  { k: "Find your people", d: "A brotherhood and sisterhood chasing the same summit." },
];

export function Vision() {
  return (
    <section className="section bg-white">
      <div className="container-1m">
        <div className="grid items-stretch gap-12 lg:grid-cols-[1.05fr_1fr]">
          <div className="flex flex-col justify-center">
            <SectionHeading
              align="left"
              eyebrow="The Vision"
              title="Build a life worth waking up for"
              description="One Mission is where ambition meets purpose — where becoming the best version of yourself, and the life you've pictured, stop being a someday. This is the standard we hold each other to."
            />
          </div>

          {/* Statement panel — replace with a real lifestyle photo when ready. */}
          <div className="relative flex min-h-[320px] items-end overflow-hidden rounded-xl bg-navy p-9 sm:p-10">
            <OneMissionArc
              className="pointer-events-none absolute -right-10 -top-10 w-64 text-white/[0.06]"
              founders={false}
            />
            <p className="relative font-serif text-2xl font-semibold uppercase leading-[1.15] tracking-[0.01em] text-white sm:text-[1.75rem]">
              You were made for more
              <br />
              than the life you settled for.
              <span className="mt-5 block text-xs font-medium normal-case tracking-[0.28em] text-gold-light">
                The 1 Mission standard
              </span>
            </p>
          </div>
        </div>

        <div className="mt-14 grid gap-px overflow-hidden rounded-xl border border-ice bg-ice sm:grid-cols-2 lg:grid-cols-3">
          {pillars.map((p) => (
            <div key={p.k} className="bg-white p-6 sm:p-7">
              <h3 className="font-serif text-sm font-semibold uppercase tracking-[0.14em] text-navy">
                {p.k}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-charcoal/70">{p.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
