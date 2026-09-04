import Link from "next/link";
import { Reveal } from "./Reveal";

/** Section 3 — the platform: four flagship product cards. */
const PRODUCTS = [
  {
    name: "OM",
    tag: "The trading brain",
    copy: "Reads Gold through market structure, support, resistance, liquidity, breakouts, fakeouts and price reaction — then helps identify the trade forming.",
    href: "/matty-pips",
    preview: (
      <div className="rounded-2xl bg-[#F2F7FC] p-4 text-[12px]">
        <div className="mb-2 flex items-center justify-between font-bold text-[#182633]">
          <span>GOLD</span><span className="text-[#2F6FA8]">Support in play</span>
        </div>
        <div className="flex gap-1.5">
          {["Wait", "Approaching", "Armed", "Take now"].map((s, i) => (
            <span key={s} className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${i === 2 ? "bg-[#C99019] text-white" : "bg-white text-[#8A99A8]"}`}>{s}</span>
          ))}
        </div>
        <div className="mt-2 text-[11px] text-[#68798A]">15M confirmation · closed candles only</div>
      </div>
    ),
  },
  {
    name: "Flow",
    tag: "Automated execution",
    copy: "Designed to identify qualified setups, execute through connected accounts and manage trades with structured risk, breakeven and partial-profit logic.",
    href: "/login",
    preview: (
      <div className="rounded-2xl bg-[#F2F7FC] p-4 text-[12px] text-[#3C4E5F]">
        <div className="flex flex-wrap items-center gap-1.5 font-semibold">
          {["Setup", "Execute", "Risk", "Breakeven", "Partial", "Runner"].map((s, i) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="rounded-lg bg-white px-2.5 py-1">{s}</span>
              {i < 5 && <span className="text-[#5B9BD5]">→</span>}
            </span>
          ))}
        </div>
      </div>
    ),
  },
  {
    name: "GENX",
    tag: "Gold intelligence",
    copy: "A specialized Gold engine built to analyze XAU/USD and surface opportunities in one of the world's most active markets.",
    href: "/login",
    preview: (
      <div className="rounded-2xl bg-[#F2F7FC] p-4 text-[12px]">
        <div className="font-bold text-[#182633]">XAU/USD scanner</div>
        <div className="mt-1 text-[#68798A]">Heads-up → Enter → Managed — alerts to the room in real time.</div>
      </div>
    ),
  },
  {
    name: "Live trading",
    tag: "The Get Paid session",
    copy: "Step into the market with experienced traders, see the thought process live and learn how setups develop in real time.",
    href: "/schedule",
    preview: (
      <div className="rounded-2xl bg-[#F2F7FC] p-4 text-[12px]">
        <div className="flex items-center gap-2 font-bold text-[#182633]">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#D25757]" aria-hidden="true" /> Live with the room
        </div>
        <div className="mt-1 text-[#68798A]">Market breakdowns · levels · trade management, out loud.</div>
      </div>
    ),
  },
];

export function PlatformCards() {
  return (
    <section id="platform" className="bg-white py-28 lg:py-36">
      <div className="mx-auto max-w-content px-6">
        <Reveal>
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">The platform</p>
          <h2 className="text-[38px] font-extrabold leading-[1.08] tracking-tight text-[#182633] sm:text-[52px]">Built for the trade.</h2>
        </Reveal>
        <div className="mt-14 grid gap-6 md:grid-cols-2">
          {PRODUCTS.map((p, i) => (
            <Reveal key={p.name} delay={i * 90}>
              <Link href={p.href} className="group block h-full rounded-3xl border border-[#EDF2F7] bg-[#FBFDFE] p-8 transition hover:border-[#D7E9F8] hover:shadow-[0_16px_44px_rgba(47,111,168,0.10)]">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">{p.tag}</div>
                <div className="mb-3 text-[26px] font-extrabold text-[#182633]">{p.name}</div>
                <p className="mb-6 text-[14.5px] leading-relaxed text-[#5D7183]">{p.copy}</p>
                {p.preview}
                <div className="mt-5 text-[13px] font-semibold text-[#2F6FA8] opacity-0 transition group-hover:opacity-100">Explore →</div>
              </Link>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
