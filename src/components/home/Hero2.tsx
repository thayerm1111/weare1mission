import Link from "next/link";

/**
 * HERO — the first screen says: this is a trading platform.
 * Editorial type left, glass Matty-Pips-style read card over a subtle gold
 * chart line right. Status chips progress WAIT → APPROACHING → ARMED →
 * TAKE NOW on a slow CSS loop. No new dependencies; pure SVG + CSS.
 */
export function Hero2() {
  return (
    <section className="relative overflow-hidden bg-[#F7FAFC]">
      <style>{`
        @keyframes mpStatus { 0%,20%{opacity:.28} 25%,45%{opacity:1} 50%,100%{opacity:.28} }
        @keyframes mpLine { from { stroke-dashoffset: 1200; } to { stroke-dashoffset: 0; } }
        .mp-chip { animation: mpStatus 9s infinite; }
        .mp-line { stroke-dasharray: 1200; animation: mpLine 7s ease-out forwards; }
        @media (prefers-reduced-motion: reduce) { .mp-chip, .mp-line { animation: none; opacity: 1; stroke-dashoffset: 0; } }
      `}</style>

      <div className="mx-auto grid max-w-content gap-14 px-6 pb-24 pt-24 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:pb-32 lg:pt-32">
        {/* copy */}
        <div>
          <p className="mb-6 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">
            The One Mission Trading Ecosystem
          </p>
          <h1 className="text-[44px] font-extrabold leading-[1.04] tracking-tight text-[#182633] sm:text-[64px] lg:text-[72px]">
            See the market.<br />Trade the move.
          </h1>
          <p className="mt-7 max-w-[480px] text-[17px] leading-relaxed text-[#5D7183]">
            AI-powered market intelligence, automated trading tools, live sessions and a
            community built around one goal — helping traders approach the market with structure.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link href="/#platform"
              className="rounded-full bg-[#182633] px-8 py-4 text-[14px] font-semibold text-white transition hover:bg-[#2F6FA8]">
              Explore the platform
            </Link>
            <Link href="/login" className="px-2 py-4 text-[14px] font-semibold text-[#2F6FA8] hover:text-[#182633]">
              Member login →
            </Link>
          </div>
        </div>

        {/* glass read card over a market line */}
        <div className="relative">
          <svg viewBox="0 0 520 360" className="absolute inset-0 h-full w-full" aria-hidden="true">
            <rect x="0" y="150" width="520" height="34" rx="6" fill="#199868" opacity="0.07" />
            <rect x="0" y="52" width="520" height="30" rx="6" fill="#D25757" opacity="0.06" />
            <path className="mp-line" d="M0 300 L50 288 L85 296 L130 250 L165 262 L210 205 L245 226 L290 168 L330 186 L370 132 L410 168 L450 158 L520 96"
              fill="none" stroke="#5B9BD5" strokeWidth="2.2" strokeLinecap="round" opacity="0.65" />
          </svg>
          <div className="relative ml-auto max-w-[400px] rounded-3xl border border-white/70 bg-white/75 p-7 shadow-[0_18px_50px_rgba(47,111,168,0.14)] backdrop-blur-md">
            <div className="mb-4 flex items-baseline justify-between">
              <div>
                <div className="text-[10.5px] font-semibold uppercase tracking-label text-[#68798A]">Matty Pips</div>
                <div className="text-[19px] font-bold text-[#182633]">Gold · XAU/USD</div>
              </div>
              <div className="text-[11px] font-semibold text-[#2F6FA8]">15M</div>
            </div>
            <div className="mb-4 rounded-2xl bg-[#EDF4FB] px-4 py-3">
              <div className="text-[10.5px] font-semibold uppercase tracking-label text-[#68798A]">Current read</div>
              <div className="text-[15px] font-bold text-[#182633]">Testing support · waiting on the 15M close</div>
            </div>
            <div className="mb-5 flex gap-2">
              {["Wait", "Approaching", "Armed", "Take now"].map((s, i) => (
                <span key={s} className="mp-chip rounded-full bg-[#182633] px-3 py-1.5 text-[10.5px] font-bold text-white"
                  style={{ animationDelay: `${i * 2.2}s`, background: s === "Take now" ? "#199868" : "#182633" }}>
                  {s}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 text-[12.5px]">
              <div className="rounded-xl bg-white px-3 py-2 shadow-card">
                <span className="font-semibold text-[#199868]">Bull case</span>
                <div className="text-[#5D7183]">Support holds → buy</div>
              </div>
              <div className="rounded-xl bg-white px-3 py-2 shadow-card">
                <span className="font-semibold text-[#D25757]">Bear case</span>
                <div className="text-[#5D7183]">Break + retest fails → sell</div>
              </div>
            </div>
            <div className="mt-4 text-[10px] text-[#8A99A8]">Illustrative interface. Educational tools — not financial advice.</div>
          </div>
        </div>
      </div>
    </section>
  );
}
