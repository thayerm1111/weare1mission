import { Reveal } from "./Reveal";

/** Section 9 — transformation: confusion → structure (never "guaranteed profit"). */
const BEFORE = ["Random signals", "Too many indicators", "Chasing candles", "No defined levels", "Emotional entries", "No management plan", "Trading alone"];
const AFTER = ["Market structure", "Clear support / resistance", "Defined setups", "AI-powered analysis", "Trade management tools", "Live education", "A trading community"];

export function BeforeAfter() {
  return (
    <section className="bg-[#F7FAFC] py-28 lg:py-36">
      <div className="mx-auto max-w-content px-6">
        <Reveal>
          <h2 className="text-[38px] font-extrabold leading-[1.08] tracking-tight text-[#182633] sm:text-[52px]">
            From guessing<br />to a process.
          </h2>
        </Reveal>
        <div className="mt-14 grid gap-6 md:grid-cols-2">
          <Reveal delay={100}>
            <div className="h-full rounded-3xl border border-[#E8EFF5] bg-white p-9">
              <div className="mb-6 text-[11px] font-semibold uppercase tracking-label text-[#8A99A8]">Before One Mission</div>
              <ul className="space-y-3.5">
                {BEFORE.map((b) => (
                  <li key={b} className="flex items-center gap-3 text-[15px] text-[#8A99A8]">
                    <span className="text-[#D25757]" aria-hidden="true">✕</span>{b}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
          <Reveal delay={220}>
            <div className="h-full rounded-3xl bg-[#182633] p-9 shadow-[0_18px_50px_rgba(24,38,51,0.18)]">
              <div className="mb-6 text-[11px] font-semibold uppercase tracking-label text-[#9DB6CC]">With One Mission</div>
              <ul className="space-y-3.5">
                {AFTER.map((a) => (
                  <li key={a} className="flex items-center gap-3 text-[15px] font-medium text-white">
                    <span className="text-[#5B9BD5]" aria-hidden="true">✓</span>{a}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
