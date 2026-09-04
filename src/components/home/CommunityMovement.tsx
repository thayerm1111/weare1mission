import { Reveal } from "./Reveal";

/** Section 13 — THE MOVEMENT. Earned: by now the visitor knows the platform
 *  and the community — the original One Mission identity lands here. */
export function CommunityMovement() {
  return (
    <section className="relative overflow-hidden bg-[#182633] py-32 lg:py-44">
      <div className="mx-auto max-w-content px-6">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <Reveal>
            <h2 className="text-[44px] font-extrabold leading-[1.08] tracking-tight text-white sm:text-[58px]">
              One Mission.<br />One community.<br /><span className="text-[#5B9BD5]">One movement.</span>
            </h2>
            <p className="mt-7 max-w-[440px] text-[16px] leading-relaxed text-[#AEC3D6]">
              Traders, builders and entrepreneurs developing skills together — in the markets,
              in business, and in life. The room is the difference.
            </p>
          </Reveal>
          <Reveal delay={150}>
            <img src="/images/1M%20experience%20miami.png" alt="The One Mission community at a 1M Experience"
              className="w-full rounded-3xl object-cover shadow-[0_24px_60px_rgba(0,0,0,0.35)]" loading="lazy" />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
