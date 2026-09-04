"use client";

import Link from "next/link";
import { Reveal, useSectionProgress } from "./Reveal";

/**
 * Section 6 — OM flagship experience (publicly branded OM; Matty Pips stays
 * internal). A product reveal: the market story chain plays out and the
 * status ladder climbs WAIT → APPROACHING → ARMED → TAKE NOW as the visitor
 * scrolls through the section.
 */
const STORY = ["Bullish move", "Resistance broke", "Pullback", "Testing old resistance"];
const STATUSES = ["Wait", "Approaching", "Armed", "Take now"];

export function MattyPipsShowcase() {
  const { ref, progress } = useSectionProgress();
  const storyOn = Math.min(STORY.length, Math.max(1, Math.ceil(progress * 4.6)));
  const statusIdx = Math.min(3, Math.floor(progress * 4.4));

  return (
    <section id="om" ref={ref} className="bg-[#F7FAFC] py-28 lg:py-40">
      <div className="mx-auto max-w-content px-6">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <Reveal>
            <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">OM</p>
            <h2 className="text-[40px] font-extrabold leading-[1.06] tracking-tight text-[#182633] sm:text-[56px]">
              See the story behind the trade.
            </h2>
            <p className="mt-6 max-w-[440px] text-[16px] leading-relaxed text-[#5D7183]">
              Levels first. Location first. Reaction first. OM maps the levels that matter,
              watches how price behaves when it gets there, and answers the only question that
              counts — buy, sell, or wait.
            </p>
            <Link href="/matty-pips"
              className="mt-9 inline-block rounded-full bg-[#2F6FA8] px-8 py-4 text-[14px] font-semibold text-white transition hover:bg-[#182633]">
              See OM
            </Link>
          </Reveal>

          <div className="rounded-[28px] bg-white p-8 shadow-[0_18px_50px_rgba(47,111,168,0.12)]">
            {/* the story chain animates in */}
            <div className="mb-5 flex flex-wrap items-center gap-2 text-[12.5px] font-bold">
              {STORY.map((s, i) => (
                <span key={s} className="flex items-center gap-2 transition-all duration-700"
                  style={{ opacity: i < storyOn ? 1 : 0.22, transform: i < storyOn ? "none" : "translateX(-4px)" }}>
                  <span className={`rounded-lg px-2.5 py-1 ${i === STORY.length - 1 ? "bg-[#DCEAF7] text-[#2F6FA8]" : "bg-[#F2F7FC] text-[#68798A]"}`}>{s}</span>
                  {i < STORY.length - 1 && <span className="text-[#5B9BD5]">→</span>}
                </span>
              ))}
            </div>

            {/* chart with levels */}
            <svg viewBox="0 0 400 150" className="mb-4 w-full" aria-hidden="true">
              <rect x="0" y="96" width="400" height="26" rx="5" fill="#199868" opacity="0.12" />
              <rect x="0" y="18" width="400" height="20" rx="5" fill="#D25757" opacity="0.07" />
              <text x="6" y="112" fontSize="9" fontWeight="700" fill="#199868">Old resistance → potential support</text>
              <text x="6" y="32" fontSize="9" fontWeight="700" fill="#D25757" opacity="0.8">Recent high</text>
              <path d="M0 130 L45 118 L75 126 L115 84 L150 96 L190 56 L225 74 L265 44 L300 66 L335 92 L370 102 L400 106"
                fill="none" stroke="#5B9BD5" strokeWidth="2" strokeLinecap="round" />
              <circle cx="400" cy="106" r="3.5" fill="#2F6FA8" />
            </svg>

            {/* status ladder driven by scroll */}
            <div className="mb-5 flex gap-2">
              {STATUSES.map((s, i) => (
                <span key={s} className="rounded-full px-3.5 py-1.5 text-[11px] font-bold transition-all duration-500"
                  style={{
                    background: i === statusIdx ? (i === 3 ? "#199868" : i === 2 ? "#C99019" : "#2F6FA8") : "#EDF4FB",
                    color: i === statusIdx ? "#fff" : "#8A99A8",
                  }}>
                  {s}
                </span>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3 text-[13px]">
              <div className="rounded-2xl bg-[#F0FAF5] px-4 py-3">
                <div className="font-bold text-[#199868]">Bull case</div>
                <div className="text-[#5D7183]">Support rejects → BUY</div>
              </div>
              <div className="rounded-2xl bg-[#FDF4F4] px-4 py-3">
                <div className="font-bold text-[#D25757]">Bear case</div>
                <div className="text-[#5D7183]">Break + failed reclaim → SELL</div>
              </div>
            </div>
            <div className="mt-4 text-[10px] text-[#8A99A8]">Illustrative read. Conditional plans, not predictions. Educational, not financial advice.</div>
          </div>
        </div>
      </div>
    </section>
  );
}
