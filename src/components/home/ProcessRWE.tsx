"use client";

import { Reveal, useSectionProgress } from "./Reveal";

/** Section 5 — Read. Wait. Execute. Stages light up as the visitor scrolls. */
const STAGES = [
  { n: "01", title: "Read", items: ["Market direction", "Highs / lows", "Support", "Resistance", "Liquidity", "Structure"] },
  { n: "02", title: "Wait", items: ["Reaction", "Rejection", "Breakout", "Fakeout", "Retest"] },
  { n: "03", title: "Execute", items: ["Entry", "Risk", "Stop", "Targets", "Management"] },
];

export function ProcessRWE() {
  const { ref, progress } = useSectionProgress();
  const active = Math.min(2, Math.floor(progress * 3.2));
  return (
    <section id="process" ref={ref} className="bg-[#182633] py-28 lg:py-40">
      <div className="mx-auto max-w-content px-6">
        <Reveal>
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#9DB6CC]">The process</p>
          <h2 className="text-[48px] font-extrabold leading-[1.02] tracking-tight text-white sm:text-[68px]">
            Read. Wait.<br />Execute.
          </h2>
        </Reveal>
        <div className="mt-16 grid gap-10 md:grid-cols-3">
          {STAGES.map((s, i) => {
            const on = i <= active;
            return (
              <div key={s.n} className="border-t pt-7 transition-all duration-700"
                style={{ borderColor: on ? "#5B9BD5" : "rgba(255,255,255,0.12)", opacity: on ? 1 : 0.38 }}>
                <div className="mb-3 text-[13px] font-bold" style={{ color: on ? "#5B9BD5" : "#5D7183" }}>{s.n}</div>
                <div className="mb-4 text-[26px] font-extrabold text-white">{s.title}</div>
                <div className="flex flex-wrap gap-2">
                  {s.items.map((x) => (
                    <span key={x} className="rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors duration-700"
                      style={{ background: on ? "rgba(91,155,213,0.16)" : "rgba(255,255,255,0.06)", color: on ? "#CFE2F2" : "#7E93A6" }}>
                      {x}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
