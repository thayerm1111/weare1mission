import Link from "next/link";
import { Reveal } from "./Reveal";

/** Section 9 — the live community experience: software + human connection. */
const EXPERIENCES = ["Live trading", "Get Paid Session", "Market breakdowns", "Training", "Community calls", "Events"];

export function TheRoom() {
  return (
    <section id="live" className="bg-[#F7FAFC] py-28 lg:py-40">
      <div className="mx-auto max-w-content px-6">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <Reveal delay={120}>
            <div className="grid grid-cols-2 gap-4">
              <img src="/images/IMG_3047.JPG" alt="One Mission live session" className="h-60 w-full rounded-3xl object-cover shadow-card" loading="lazy" />
              <img src="/images/IMG_3154.JPG" alt="One Mission community trading together" className="mt-10 h-60 w-full rounded-3xl object-cover shadow-card" loading="lazy" />
            </div>
          </Reveal>
          <Reveal>
            <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">The room</p>
            <h2 className="text-[40px] font-extrabold leading-[1.06] tracking-tight text-[#182633] sm:text-[56px]">
              The market is better when you&rsquo;re not alone.
            </h2>
            <div className="mt-8 flex flex-wrap gap-2.5">
              {EXPERIENCES.map((x) => (
                <span key={x} className="rounded-full bg-white px-4.5 py-2.5 text-[13px] font-semibold text-[#3C4E5F] shadow-card" style={{ paddingLeft: 18, paddingRight: 18 }}>
                  {x}
                </span>
              ))}
            </div>
            <Link href="/schedule" className="mt-9 inline-block rounded-full bg-[#182633] px-8 py-4 text-[14px] font-semibold text-white transition hover:bg-[#2F6FA8]">
              See the schedule
            </Link>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
