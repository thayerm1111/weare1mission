import { Reveal } from "./Reveal";

/** Section 3 — the problem: noise → the one question → One Mission. */
const NOISE = ["TradingView", "Telegram", "YouTube", "Discord", "News", "Signals", "Indicators", "AI tools", "Brokers"];
const PILLARS = ["Market intelligence", "AI analysis", "Automation", "Live trading", "Education", "Community"];

export function ProblemNoise() {
  return (
    <section className="bg-[#F7FAFC] py-28 lg:py-40">
      <div className="mx-auto max-w-content px-6">
        <Reveal>
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">The problem</p>
          <h2 className="max-w-[640px] text-[40px] font-extrabold leading-[1.06] tracking-tight text-[#182633] sm:text-[56px]">
            Too much noise.<br />Not enough structure.
          </h2>
        </Reveal>

        <Reveal delay={120}>
          <div className="mt-14 flex flex-wrap gap-2.5">
            {NOISE.map((n) => (
              <span key={n} className="rounded-full border border-[#E8EFF5] bg-white px-4 py-2 text-[12.5px] font-medium text-[#8A99A8]">{n}</span>
            ))}
          </div>
        </Reveal>

        <Reveal delay={220}>
          <div className="my-14 text-center">
            <div className="text-[24px] font-extrabold tracking-tight text-[#182633] sm:text-[32px]">
              …and still one question: <span className="text-[#2F6FA8]">what matters right now?</span>
            </div>
          </div>
        </Reveal>

        <Reveal delay={300}>
          <div className="mx-auto max-w-[760px] rounded-[28px] bg-[#182633] p-10 shadow-[0_24px_60px_rgba(24,38,51,0.22)]">
            <div className="mb-6 text-center text-[11px] font-semibold uppercase tracking-label text-[#9DB6CC]">One Mission · one trading ecosystem</div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-3.5 sm:grid-cols-3">
              {PILLARS.map((p) => (
                <div key={p} className="flex items-center gap-2.5 text-[14px] font-semibold text-white">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#5B9BD5]" aria-hidden="true" />{p}
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
