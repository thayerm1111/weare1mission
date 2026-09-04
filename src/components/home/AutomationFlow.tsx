import { Reveal } from "./Reveal";

/** Section 6 — automation. Accurate claims only; no profit promises. */
const STEPS = ["Setup found", "Approaching", "Armed", "Trade executed", "Risk managed", "Partial taken", "Runner"];

export function AutomationFlow() {
  return (
    <section id="automation" className="bg-white py-28 lg:py-36">
      <div className="mx-auto max-w-content px-6">
        <Reveal>
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">Automated trading</p>
          <h2 className="max-w-[620px] text-[38px] font-extrabold leading-[1.08] tracking-tight text-[#182633] sm:text-[52px]">
            Find the setup.<br />Let the system work.
          </h2>
          <p className="mt-6 max-w-[560px] text-[16px] leading-relaxed text-[#5D7183]">
            Eligible members can connect supported trading accounts and use One Mission&rsquo;s
            automation tools — structured entries, defined risk, breakeven logic, partials and
            runners, managed by rules instead of emotion. Trading involves risk; automation
            manages process, not outcomes.
          </p>
        </Reveal>
        <Reveal delay={150}>
          <div className="mt-14 flex flex-wrap items-center gap-2.5">
            {STEPS.map((s, i) => (
              <span key={s} className="flex items-center gap-2.5">
                <span className={`rounded-full px-5 py-2.5 text-[13px] font-semibold ${i === 3 ? "bg-[#2F6FA8] text-white" : "border border-[#E8EFF5] bg-[#FBFDFE] text-[#3C4E5F]"}`}>
                  {s}
                </span>
                {i < STEPS.length - 1 && <span className="text-[#5B9BD5]" aria-hidden="true">→</span>}
              </span>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
