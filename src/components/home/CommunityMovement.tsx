import { Reveal } from "./Reveal";

/** Section 11 — the movement, with real One Mission imagery. */
export function CommunityMovement() {
  return (
    <section id="community" className="relative overflow-hidden bg-[#182633] py-28 lg:py-36">
      <div className="mx-auto max-w-content px-6">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <Reveal>
            <h2 className="text-[40px] font-extrabold leading-[1.1] tracking-tight text-white sm:text-[54px]">
              One platform.<br />One community.<br /><span className="text-[#5B9BD5]">One Mission.</span>
            </h2>
            <p className="mt-6 max-w-[440px] text-[16px] leading-relaxed text-[#AEC3D6]">
              Traders, builders and entrepreneurs developing skills together — in the markets, in
              business, and in life. The room is the difference.
            </p>
          </Reveal>
          <Reveal delay={150}>
            <img src="/images/1m%20experience%20big.png" alt="The One Mission community together at a 1M Experience"
              className="w-full rounded-3xl object-cover shadow-[0_24px_60px_rgba(0,0,0,0.35)]" loading="lazy" />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
