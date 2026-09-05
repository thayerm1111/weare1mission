import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Monogram1M } from "@/components/Logo";
import { JoinForm } from "./JoinForm";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "Start Your 14-Day Free Trial",
  description: "Register in seconds and get instant access to the 1 Mission platform — 14 days free with 200 credits. No approval wait, no card required.",
  path: "/join",
});

const PERKS = [
  "Instant access — no approval wait",
  "200 credits to use across the AI trading desk",
  "The Floor: GENX, Matty Pips, OM AI, and every desk tool",
  "Full member portal, community, and training",
];

/**
 * /join — the shareable trial link (owner directive 09-05). Send someone
 * weare1mission.com/join and they register with name + email + password,
 * get auto-approved, and land in the portal with a live 14-day trial and
 * 200 credits. Referral links work too: /join?ref=<username>.
 */
export default function JoinPage({ searchParams }: { searchParams: { ref?: string } }) {
  return (
    <section className="section bg-gradient-hero">
      <div className="container-1m flex justify-center">
        <div className="w-full max-w-md">
          <div className="text-center">
            <Link href="/" aria-label="1 Mission home" className="inline-flex text-primary"><Monogram1M className="mx-auto h-10 w-10" /></Link>
            <p className="mt-5 inline-flex rounded-full border border-primary/25 bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-primary">
              14 days free · 200 credits
            </p>
            <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-navy">Try the 1 Mission platform</h1>
            <p className="mt-2 text-sm text-charcoal/70">
              Create your account and you&apos;re on the desk in under a minute.
            </p>
          </div>

          <ul className="mt-6 space-y-2">
            {PERKS.map((p) => (
              <li key={p} className="flex items-start gap-2.5 text-sm text-charcoal/80">
                <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-primary" aria-hidden="true" />
                <span>{p}</span>
              </li>
            ))}
          </ul>

          <div className="mt-6 rounded-2xl border border-[#E4DCCB] bg-offwhite/70 p-6 shadow-card sm:p-8">
            <JoinForm refUsername={searchParams.ref} />
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-charcoal/55">
            Educational platform — not financial advice. Your trial pauses automatically after 14 days;
            nothing is charged and no card is collected.
          </p>
        </div>
      </div>
    </section>
  );
}
