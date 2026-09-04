import Link from "next/link";
import { Reveal } from "./Reveal";

/** Section 12 — final conversion. Maximum whitespace, one answer. */
export function CtaFinal() {
  return (
    <section className="bg-[#F7FAFC] py-32 lg:py-44">
      <div className="mx-auto max-w-content px-6 text-center">
        <Reveal>
          <p className="mb-6 text-[11px] font-semibold uppercase tracking-label text-[#2F6FA8]">Your next move</p>
          <h2 className="mx-auto max-w-[640px] text-[42px] font-extrabold leading-[1.06] tracking-tight text-[#182633] sm:text-[58px]">
            Stop watching.<br />Start building your edge.
          </h2>
          <p className="mx-auto mt-7 max-w-[420px] text-[16px] leading-relaxed text-[#5D7183]">
            Step inside the One Mission trading ecosystem.
          </p>
          <div className="mt-11 flex flex-wrap items-center justify-center gap-4">
            <Link href="/signup" className="rounded-full bg-[#182633] px-10 py-4.5 text-[14px] font-semibold text-white transition hover:bg-[#2F6FA8]" style={{ paddingTop: 18, paddingBottom: 18 }}>
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
