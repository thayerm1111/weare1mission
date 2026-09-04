"use client";

import { Reveal, useSectionProgress } from "./Reveal";

/** Section 7 — automation: the pipeline lights up step by step on scroll. */
const STEPS = ["Market found", "Approaching", "Armed", "Trade executed", "Stop protected", "Partial taken", "Runner"];

export function AutomationFlow() {
  const { ref, progress } = useSectionProgress();
  const on = Math.min(STEPS.length, Math.max(1, Math.ceil(progress * (STEPS.length + 1.5))));
  return (
    <section id="automation" ref={ref} className="bg-white py-28 lg:py-40">
      <div className="mx-auto max-w-content px-6">
        <Reveal>
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">Automated trading</p>
          <h2 className="max-w-[560px] text-[40px] font-extrabold leading-[1.06] tracking-tight text-[#182633] sm:text-[56px]">
            From setup<br />to management.
          </h2>
          <p className="mt-6 max-w-[560px] text-[16px] leading-relaxed text-[#5D7183]">
            Eligible members can connect supported trading accounts and let the system run the
            process — structured entries, defined risk, breakeven, partials, runners. Automation
            manages process, not outcomes; trading involves risk.
          </p>
        </Reveal>
        <div className="mt-14 flex flex-wrap items-center gap-2.5">
          {STEPS.map((s, i) => (
            <span key={s} className="flex items-center gap-2.5">
              <span className="rounded-full px-5 py-2.5 text-[13px] font-semibold transition-all duration-500"
                style={{
                  background: i < on ? "#182633" : "#FBFDFE",
                  color: i < on ? "#fff" : "#8A99A8",
                  border: i < on ? "1px solid #182633" : "1px solid #E8EFF5",
                }}>
                {s}
              </span>
              {i < STEPS.length - 1 && <span className="transition-colors duration-500" style={{ color: i < on - 1 ? "#2F6FA8" : "#D7E2EC" }} aria-hidden="true">→</span>}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
