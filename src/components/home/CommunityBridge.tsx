import { Reveal } from "./Reveal";

/**
 * Section 8 — THE COMMUNITY BRIDGE. Where the human side starts — early,
 * not buried at the bottom. Full-bleed authentic imagery; emotional contrast
 * to the clean tech sections above it.
 */
export function CommunityBridge() {
  return (
    <section id="community" className="relative overflow-hidden bg-[#182633]">
      <img src="/images/1m%20experience%20big.png" alt="The One Mission community together"
        className="absolute inset-0 h-full w-full object-cover opacity-40" loading="lazy" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#182633] via-[#182633]/80 to-transparent" aria-hidden="true" />
      <div className="relative mx-auto max-w-content px-6 py-32 lg:py-44">
        <Reveal>
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-label text-[#9DB6CC]">More than software</p>
          <h2 className="max-w-[620px] text-[42px] font-extrabold leading-[1.05] tracking-tight text-white sm:text-[60px]">
            Trade with people behind you.
          </h2>
          <p className="mt-7 max-w-[460px] text-[17px] leading-relaxed text-[#C6D6E4]">
            Technology can help you see the market. Community helps you stay in the game.
            One Mission brings together traders, educators, builders and people chasing the
            same goals.
          </p>
          <div className="mt-10 text-[13px] font-bold uppercase tracking-label text-[#5B9BD5]">
            Technology for the trade. Community for the journey.
          </div>
        </Reveal>
      </div>
    </section>
  );
}
