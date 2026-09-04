import Link from "next/link";
import { Reveal } from "./Reveal";

/** Section 14 — final conversion. Maximum whitespace, one answer. */
export function CtaFinal() {
  return (
    <section className="bg-[#F7FAFC] py-32 lg:py-48">
      <div className="mx-auto max-w-content px-6 text-center">
        <Reveal>
          <p className="mb-6 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">Your next move</p>
          <h2 className="mx-auto max-w-[680px] text-[44px] font-extrabold leading-[1.04] tracking-tight text-[#182633] sm:text-[62px]">
            Enter the<br />trading ecosystem.
          </h2>
          <p className="mx-auto mt-7 max-w-[440px] text-[16px] leading-relaxed text-[#5D7183]">
            Trading technology. Live education. Real community. One Mission.
          </p>
          <div className="mt-11 flex flex-wrap items-center justify-center gap-4">
            <Link href="/signup" className="rounded-full bg-[#182633] px-10 text-[14px] font-semibold text-white transition hover:bg-[#2F6FA8]" style={{ paddingTop: 18, paddingBottom: 18 }}>
              Get access
            </Link>
            <Link href="/login" className="px-2 py-4 text-[14px] font-semibold text-[#2F6FA8] hover:text-[#182633]">
              Member login →
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
