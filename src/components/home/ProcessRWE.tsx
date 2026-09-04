import { Reveal } from "./Reveal";

/** Section 4 — how One Mission thinks: Read. Wait. Execute. */
const STAGES = [
  { n: "01", title: "Read", copy: "Understand direction, structure, the meaningful highs and lows, support, resistance and where the liquidity sits." },
  { n: "02", title: "Wait", copy: "Let price come to the level. Watch the reaction — rejection, breakout, fakeout, retest. The level picks the direction." },
  { n: "03", title: "Execute", copy: "When the trade is there: entry, risk, stop, targets — and a management plan before the position ever exists." },
];

export function ProcessRWE() {
  return (
    <section id="process" className="bg-[#182633] py-28 lg:py-36">
      <div className="mx-auto max-w-content px-6">
        <Reveal>
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#9DB6CC]">The process</p>
          <h2 className="text-[44px] font-extrabold leading-[1.05] tracking-tight text-white sm:text-[60px]">
            Read. Wait.<br />Execute.
          </h2>
        </Reveal>
        <div className="mt-16 grid gap-10 md:grid-cols-3">
          {STAGES.map((s, i) => (
            <Reveal key={s.n} delay={i * 120}>
              <div className="border-t border-white/15 pt-7">
                <div className="mb-3 text-[13px] font-bold text-[#5B9BD5]">{s.n}</div>
                <div className="mb-3 text-[24px] font-extrabold text-white">{s.title}</div>
                <p className="text-[14.5px] leading-relaxed text-[#AEC3D6]">{s.copy}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
