import { Reveal } from "./Reveal";

/** Section 2 — the problem: fragmentation → one ecosystem. */
const NOISE = ["Charts", "Telegram groups", "Signals", "Indicators", "News", "YouTube", "Discords", "Opinions", "Brokers", "More AI tools"];
const PILLARS = ["Market intelligence", "AI analysis", "Automation", "Live trading", "Education", "Community"];

export function ProblemNoise() {
  return (
    <section className="bg-[#F7FAFC] py-28 lg:py-36">
      <div className="mx-auto max-w-content px-6">
        <Reveal>
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">The problem</p>
          <h2 className="max-w-[560px] text-[38px] font-extrabold leading-[1.08] tracking-tight text-[#182633] sm:text-[52px]">
            Trading doesn&rsquo;t need more noise.
          </h2>
          <p className="mt-6 max-w-[540px] text-[16px] leading-relaxed text-[#5D7183]">
            Most traders are surrounded by charts, signals, groups, indicators, news and opinions —
            and still don&rsquo;t know what they should actually be watching. One Mission is built
            around structure.
          </p>
        </Reveal>

        <div className="mt-16 grid gap-10 lg:grid-cols-[1fr_auto_1fr] lg:items-center">
          <Reveal delay={100}>
            <div className="flex flex-wrap gap-2.5">
              {NOISE.map((n) => (
                <span key={n} className="rounded-full border border-[#E8EFF5] bg-white px-4 py-2 text-[12.5px] font-medium text-[#8A99A8]">
                  {n}
                </span>
              ))}
            </div>
          </Reveal>
          <Reveal delay={200} className="hidden lg:block">
            <div className="text-[28px] text-[#5B9BD5]" aria-hidden="true">→</div>
          </Reveal>
          <Reveal delay={300}>
            <div className="rounded-3xl bg-[#182633] p-8 shadow-[0_18px_50px_rgba(24,38,51,0.18)]">
              <div className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#9DB6CC]">One Mission</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                {PILLARS.map((p) => (
                  <div key={p} className="flex items-center gap-2.5 text-[13.5px] font-semibold text-white">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#5B9BD5]" aria-hidden="true" />{p}
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
