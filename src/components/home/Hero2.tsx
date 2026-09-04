import Link from "next/link";

/**
 * HERO v2 — trading technology, immediately. Editorial type left; a layered
 * One Mission platform composition right: gold chart with S/R bands, an OM
 * read card cycling WAIT → APPROACHING → ARMED → TAKE NOW, and a FLOW
 * management card. Subtle CSS-only motion; no dependencies.
 */
export function Hero2() {
  return (
    <section className="relative overflow-hidden bg-[#F7FAFC]">
      <style>{`
        @keyframes omStatus { 0%,17%{opacity:.25} 22%,42%{opacity:1} 47%,100%{opacity:.25} }
        @keyframes omLine { from { stroke-dashoffset: 1400; } to { stroke-dashoffset: 0; } }
        @keyframes omPulse { 0%,100%{opacity:.45} 50%{opacity:1} }
        @keyframes omFloat { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-7px)} }
        .om-chip { animation: omStatus 10s infinite; }
        .om-line { stroke-dasharray: 1400; animation: omLine 6.5s ease-out forwards; }
        .om-dot { animation: omPulse 2.4s infinite; }
        .om-card-b { animation: omFloat 7s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .om-chip,.om-line,.om-dot,.om-card-b { animation: none; opacity: 1; stroke-dashoffset: 0; transform:none; } }
      `}</style>

      <div className="mx-auto grid max-w-content gap-16 px-6 pb-24 pt-24 lg:grid-cols-[1fr_1fr] lg:items-center lg:pb-36 lg:pt-32">
        {/* copy */}
        <div>
          <p className="mb-6 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">
            The One Mission Trading Ecosystem
          </p>
          <h1 className="text-[46px] font-extrabold leading-[1.02] tracking-tight text-[#182633] sm:text-[68px] lg:text-[76px]">
            Read the market.<br />Trade the move.
          </h1>
          <p className="mt-7 max-w-[460px] text-[17px] leading-relaxed text-[#5D7183]">
            AI-powered market intelligence, automation, live trading and a community built
            around helping traders approach the market with structure.
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
          <div className="mt-12 flex flex-wrap gap-x-8 gap-y-2 text-[11px] font-semibold uppercase tracking-label text-[#8A99A8]">
            <span>The tools</span><span>The room</span><span>The mission</span>
          </div>
        </div>

        {/* layered platform composition */}
        <div className="relative min-h-[430px]">
          {/* gold chart backdrop with S/R zones */}
          <svg viewBox="0 0 560 400" className="absolute inset-0 h-full w-full" aria-hidden="true">
            <rect x="0" y="300" width="560" height="34" rx="6" fill="#199868" opacity="0.08" />
            <rect x="0" y="70" width="560" height="30" rx="6" fill="#D25757" opacity="0.06" />
            <text x="8" y="296" fontSize="9" fontWeight="700" fill="#199868" opacity="0.75">SUPPORT</text>
            <text x="8" y="66" fontSize="9" fontWeight="700" fill="#D25757" opacity="0.6">RESISTANCE</text>
            <path className="om-line" d="M0 330 L45 318 L80 326 L120 284 L150 298 L195 240 L230 262 L275 200 L310 222 L350 168 L385 198 L425 182 L465 148 L505 168 L560 120"
              fill="none" stroke="#5B9BD5" strokeWidth="2.2" strokeLinecap="round" opacity="0.6" />
            <circle className="om-dot" cx="560" cy="120" r="4" fill="#2F6FA8" />
          </svg>

          {/* OM read card */}
          <div className="relative z-10 max-w-[360px] rounded-3xl border border-white/70 bg-white/80 p-6 shadow-[0_18px_50px_rgba(47,111,168,0.16)] backdrop-blur-md">
            <div className="mb-3 flex items-baseline justify-between">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-label text-[#68798A]">OM · The trading brain</div>
                <div className="text-[18px] font-bold text-[#182633]">Gold · XAU/USD</div>
              </div>
              <span className="text-[11px] font-semibold text-[#2F6FA8]">15M</span>
            </div>
            <div className="mb-3 rounded-2xl bg-[#EDF4FB] px-4 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-label text-[#68798A]">Current read</div>
              <div className="text-[14px] font-bold text-[#182633]">Testing support · waiting on the 15M close</div>
            </div>
            <div className="flex gap-2">
              {["Wait", "Approaching", "Armed", "Take now"].map((s, i) => (
                <span key={s} className="om-chip rounded-full px-3 py-1.5 text-[10px] font-bold text-white"
                  style={{ animationDelay: `${i * 2.5}s`, background: s === "Take now" ? "#199868" : "#182633" }}>
                  {s}
                </span>
              ))}
            </div>
          </div>

          {/* FLOW management card */}
          <div className="om-card-b relative z-10 ml-auto mt-6 max-w-[300px] rounded-3xl border border-white/70 bg-white/80 p-5 shadow-[0_18px_50px_rgba(47,111,168,0.14)] backdrop-blur-md">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-label text-[#68798A]">Flow · Automated execution</div>
            <div className="space-y-1.5 text-[12.5px] font-semibold text-[#3C4E5F]">
              <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#199868]" />Trade managed</div>
              <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#199868]" />Partial taken</div>
              <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#2F6FA8]" />Stop protected</div>
            </div>
          </div>

          <div className="relative z-10 mt-5 text-[10px] text-[#8A99A8]">Illustrative interface. Educational tools — not financial advice.</div>
        </div>
      </div>
    </section>
  );
}
