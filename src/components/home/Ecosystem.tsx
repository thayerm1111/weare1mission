import Link from "next/link";
import { Reveal } from "./Reveal";

/** Section 10 — the wider One Mission beyond trading. */
const PILLARS = [
  { t: "Community", c: "People building skills together — traders, entrepreneurs, leaders." },
  { t: "Personal development", c: "Standards, discipline and growth beyond the charts." },
  { t: "Experiences & events", c: "1M Experiences — in the room, together." },
  { t: "The Collection", c: "One Mission, worn. Apparel built for the mission." },
];

export function Ecosystem() {
  return (
    <section className="bg-white py-28 lg:py-36">
      <div className="mx-auto max-w-content px-6">
        <Reveal>
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">One Mission</p>
          <h2 className="text-[38px] font-extrabold leading-[1.08] tracking-tight text-[#182633] sm:text-[52px]">
            More than<br />a trading platform.
          </h2>
          <p className="mt-6 max-w-[480px] text-[16px] leading-relaxed text-[#5D7183]">
            The market may be where you start. The mission is bigger.
          </p>
        </Reveal>
        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {PILLARS.map((p, i) => (
            <Reveal key={p.t} delay={i * 90}>
              <div className="h-full rounded-3xl border border-[#EDF2F7] bg-[#FBFDFE] p-7">
                <div className="mb-2 text-[16px] font-extrabold text-[#182633]">{p.t}</div>
                <p className="text-[13.5px] leading-relaxed text-[#5D7183]">{p.c}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={200}>
          <div className="mt-10 flex gap-6 text-[13.5px] font-semibold text-[#2F6FA8]">
            <Link href="/experiences" className="hover:text-[#182633]">1M Experiences →</Link>
            <Link href="/collection" className="hover:text-[#182633]">The Collection →</Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
