import Link from "next/link";
import { Reveal } from "./Reveal";

/** Section 7 — live trading with the room. Real One Mission imagery only. */
export function LiveTradingRoom() {
  return (
    <section id="live" className="bg-[#F7FAFC] py-28 lg:py-36">
      <div className="mx-auto max-w-content px-6">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <Reveal>
            <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">Trade with us</p>
            <h2 className="text-[38px] font-extrabold leading-[1.08] tracking-tight text-[#182633] sm:text-[52px]">
              Don&rsquo;t just watch.<br />Trade with the room.
            </h2>
            <p className="mt-6 max-w-[480px] text-[16px] leading-relaxed text-[#5D7183]">
              Live Gold sessions, Matty Pips reads out loud, Get Paid Sessions and real-time market
              breakdowns — see how setups develop while they&rsquo;re developing, with the
              community in the room.
            </p>
            <Link href="/schedule" className="mt-9 inline-block rounded-full bg-[#182633] px-8 py-4 text-[14px] font-semibold text-white transition hover:bg-[#2F6FA8]">
              See the schedule
            </Link>
          </Reveal>
          <Reveal delay={150}>
            <div className="grid grid-cols-2 gap-4">
              <img src="/images/IMG_3047.JPG" alt="One Mission live session" className="h-56 w-full rounded-3xl object-cover shadow-card" loading="lazy" />
              <img src="/images/IMG_3154.JPG" alt="One Mission community trading together" className="mt-8 h-56 w-full rounded-3xl object-cover shadow-card" loading="lazy" />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
