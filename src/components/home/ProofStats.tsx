import { homeStats, statsDisclosure } from "@/data/homeStats";
import { Reveal } from "./Reveal";

/** Section 8 — proof. Renders ONLY owner-approved numbers from homeStats.ts. */
export function ProofStats() {
  return (
    <section id="proof" className="bg-white py-28 lg:py-36">
      <div className="mx-auto max-w-content px-6">
        <Reveal>
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">The proof</p>
          <h2 className="text-[38px] font-extrabold leading-[1.08] tracking-tight text-[#182633] sm:text-[52px]">
            Built around
            real execution.
          </h2>
        </Reveal>
        {homeStats.length > 0 ? (
          <div className="mt-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {homeStats.map((s, i) => (
              <Reveal key={s.label} delay={i * 100}>
                <div className="border-t border-[#E8EFF5] pt-6">
                  <div className="text-[44px] font-extrabold tracking-tight text-[#182633]">{s.value}</div>
                  <div className="mt-1 text-[13px] font-semibold uppercase tracking-label text-[#8A99A8]">{s.label}</div>
                </div>
              </Reveal>
            ))}
          </div>
        ) : (
          <Reveal delay={100}>
            <div className="mt-12 grid gap-6 md:grid-cols-3">
              {[
                { t: "Live, out loud", c: "Gold traded live with the room — the read, the level, the reaction and the management, narrated in real time." },
                { t: "Every decision on record", c: "The desk's calls, entries and management are logged as they happen — the work is visible, not implied." },
                { t: "Process over promises", c: "No hype numbers here. Structure, levels and discipline — and the results conversation happens inside, with full context." },
              ].map((x) => (
                <div key={x.t} className="rounded-3xl border border-[#EDF2F7] bg-[#FBFDFE] p-8">
                  <div className="mb-2 text-[17px] font-extrabold text-[#182633]">{x.t}</div>
                  <p className="text-[14px] leading-relaxed text-[#5D7183]">{x.c}</p>
                </div>
              ))}
            </div>
          </Reveal>
        )}
        <p className="mt-10 max-w-[640px] text-[11.5px] leading-relaxed text-[#8A99A8]">{statsDisclosure}</p>
      </div>
    </section>
  );
}
