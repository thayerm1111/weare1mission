import Link from "next/link";
import { Reveal } from "./Reveal";

/**
 * Section 4 — THE PLATFORM. Four immersive alternating product panels
 * (not tiny feature boxes). Publicly branded OM for the trading brain.
 */
function OmPreview() {
  return (
    <div className="rounded-3xl bg-white p-6 shadow-[0_16px_44px_rgba(47,111,168,0.10)]">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-[15px] font-bold text-[#182633]">Gold · XAU/USD</span>
        <span className="rounded-full bg-[#C99019] px-3 py-1 text-[10.5px] font-bold text-white">Armed</span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-[12.5px]">
        <div><div className="text-[9.5px] font-semibold uppercase tracking-label text-[#8A99A8]">Current read</div><div className="font-bold text-[#182633]">Testing support</div></div>
        <div><div className="text-[9.5px] font-semibold uppercase tracking-label text-[#8A99A8]">Watching for</div><div className="font-bold text-[#182633]">15M bullish rejection</div></div>
      </div>
      <div className="mt-4 flex gap-1.5">
        {["Wait", "Approaching", "Armed", "Take now"].map((s, i) => (
          <span key={s} className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${i === 2 ? "bg-[#182633] text-white" : "bg-[#EDF4FB] text-[#8A99A8]"}`}>{s}</span>
        ))}
      </div>
    </div>
  );
}
function FlowPreview() {
  return (
    <div className="rounded-3xl bg-white p-6 shadow-[0_16px_44px_rgba(47,111,168,0.10)]">
      <div className="flex flex-wrap items-center gap-2 text-[12px] font-semibold text-[#3C4E5F]">
        {["Setup found", "Entry", "Management", "Breakeven", "Partials", "Runner"].map((s, i) => (
          <span key={s} className="flex items-center gap-2">
            <span className={`rounded-xl px-3 py-1.5 ${i === 0 ? "bg-[#182633] text-white" : "bg-[#EDF4FB]"}`}>{s}</span>
            {i < 5 && <span className="text-[#5B9BD5]">→</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
function GenxPreview() {
  return (
    <div className="rounded-3xl bg-white p-6 shadow-[0_16px_44px_rgba(47,111,168,0.10)]">
      <svg viewBox="0 0 300 80" className="w-full" aria-hidden="true">
        <rect x="0" y="52" width="300" height="16" rx="4" fill="#199868" opacity="0.10" />
        <path d="M0 28 L35 40 L60 34 L95 54 L130 48 L165 62 L200 56 L235 44 L270 36 L300 24" fill="none" stroke="#C99019" strokeWidth="2" strokeLinecap="round" />
        <circle cx="300" cy="24" r="3" fill="#C99019" />
      </svg>
      <div className="mt-2 flex items-center justify-between text-[12px] font-semibold">
        <span className="text-[#182633]">XAU/USD scanner</span>
        <span className="text-[#8A99A8]">Heads-up → Enter → Managed</span>
      </div>
    </div>
  );
}
function LivePreview() {
  return (
    <div className="rounded-3xl bg-white p-6 shadow-[0_16px_44px_rgba(47,111,168,0.10)]">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-bold text-[#182633]">
        <span className="h-2 w-2 animate-pulse rounded-full bg-[#D25757]" aria-hidden="true" /> Get Paid Session · weekly
      </div>
      <div className="flex flex-wrap gap-1.5">
        {["Gold", "NAS100", "US30"].map((m) => (
          <span key={m} className="rounded-full bg-[#EDF4FB] px-3 py-1 text-[11px] font-bold text-[#2F6FA8]">{m}</span>
        ))}
      </div>
    </div>
  );
}

const PANELS = [
  { name: "OM", tag: "The trading brain", copy: "Reads Gold through support, resistance, market structure, liquidity, breakouts, fakeouts and price reaction — then tells the story behind the trade.", href: "/matty-pips", cta: "Explore OM", preview: <OmPreview /> },
  { name: "Flow", tag: "Automated execution", copy: "Automation built to find qualified setups and manage them with structured risk — breakeven, partials, runners.", href: "/login", cta: "See Flow", preview: <FlowPreview /> },
  { name: "GENX", tag: "Gold intelligence", copy: "A specialized engine focused on finding opportunities in XAU/USD — one of the most active markets in the world.", href: "/login", cta: "See GENX", preview: <GenxPreview /> },
  { name: "Live trading", tag: "Trade with the room", copy: "Watch experienced traders break down the market and trade setups live with the community.", href: "/schedule", cta: "See the schedule", preview: <LivePreview /> },
];

export function PlatformCards() {
  return (
    <section id="platform" className="bg-white py-28 lg:py-40">
      <div className="mx-auto max-w-content px-6">
        <Reveal>
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">The platform</p>
          <h2 className="max-w-[560px] text-[40px] font-extrabold leading-[1.06] tracking-tight text-[#182633] sm:text-[56px]">
            Four ways to read the market better.
          </h2>
        </Reveal>
        <div className="mt-16 space-y-20">
          {PANELS.map((p, i) => (
            <Reveal key={p.name} delay={60}>
              <div className={`grid items-center gap-10 lg:grid-cols-2 ${i % 2 ? "lg:[&>*:first-child]:order-2" : ""}`}>
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">{p.tag}</div>
                  <div className="mb-4 text-[34px] font-extrabold tracking-tight text-[#182633]">{p.name}</div>
                  <p className="mb-6 max-w-[440px] text-[15.5px] leading-relaxed text-[#5D7183]">{p.copy}</p>
                  <Link href={p.href} className="text-[14px] font-bold text-[#2F6FA8] hover:text-[#182633]">{p.cta} →</Link>
                </div>
                <div className="rounded-[28px] bg-[#F2F7FC] p-6 sm:p-9">{p.preview}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
