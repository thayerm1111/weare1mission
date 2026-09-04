import Link from "next/link";
import { Reveal } from "./Reveal";

/** Section 5 — flagship trading-brain moment (publicly branded OM). */
export function MattyPipsShowcase() {
  return (
    <section id="om" className="bg-[#F7FAFC] py-28 lg:py-36">
      <div className="mx-auto max-w-content px-6">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <Reveal>
            <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">OM</p>
            <h2 className="text-[38px] font-extrabold leading-[1.08] tracking-tight text-[#182633] sm:text-[52px]">
              Know what Gold is telling you.
            </h2>
            <p className="mt-6 max-w-[460px] text-[16px] leading-relaxed text-[#5D7183]">
              Levels first. Location first. Reaction first. OM maps the levels that matter,
              watches how price behaves when it gets there, and answers the only question that
              counts — buy, sell, or wait.
            </p>
            <Link href="/matty-pips"
              className="mt-9 inline-block rounded-full bg-[#2F6FA8] px-8 py-4 text-[14px] font-semibold text-white transition hover:bg-[#182633]">
              Explore OM
            </Link>
          </Reveal>

          <Reveal delay={150}>
            <div className="rounded-3xl bg-white p-8 shadow-[0_18px_50px_rgba(47,111,168,0.12)]">
              <div className="mb-5 flex items-baseline justify-between">
                <div className="text-[17px] font-bold text-[#182633]">Gold · XAU/USD</div>
                <span className="rounded-full bg-[#C99019] px-3.5 py-1.5 text-[11px] font-bold text-white">Armed</span>
              </div>
              <div className="mb-5 grid grid-cols-2 gap-4 text-[13px]">
                <div>
                  <div className="text-[10.5px] font-semibold uppercase tracking-label text-[#8A99A8]">Current read</div>
                  <div className="font-bold text-[#182633]">Testing support</div>
                </div>
                <div>
                  <div className="text-[10.5px] font-semibold uppercase tracking-label text-[#8A99A8]">Watching for</div>
                  <div className="font-bold text-[#182633]">15M bullish rejection</div>
                </div>
              </div>
              <svg viewBox="0 0 380 120" className="mb-5 w-full" aria-hidden="true">
                <rect x="0" y="78" width="380" height="24" rx="5" fill="#199868" opacity="0.10" />
                <path d="M0 30 L40 44 L70 38 L105 62 L140 56 L175 84 L205 90 L235 82 L265 92 L295 80 L330 70 L380 58"
                  fill="none" stroke="#5B9BD5" strokeWidth="2" strokeLinecap="round" />
                <circle cx="380" cy="58" r="3.5" fill="#2F6FA8" />
                <text x="8" y="94" fontSize="9.5" fontWeight="700" fill="#199868">Level in play</text>
              </svg>
              <div className="grid grid-cols-2 gap-3 text-[13px]">
                <div className="rounded-2xl bg-[#F0FAF5] px-4 py-3">
                  <div className="font-bold text-[#199868]">Bull case</div>
                  <div className="text-[#5D7183]">Support holds → buy</div>
                </div>
                <div className="rounded-2xl bg-[#FDF4F4] px-4 py-3">
                  <div className="font-bold text-[#D25757]">Bear case</div>
                  <div className="text-[#5D7183]">Break + retest fails → sell</div>
                </div>
              </div>
              <div className="mt-4 text-[10px] text-[#8A99A8]">Illustrative read. Educational, not financial advice.</div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
