import { ArrowRight, MessageCircle } from "lucide-react";
import { Button } from "../Button";

export function FinalCta() {
  return (
    <section className="relative overflow-hidden bg-gradient-navy">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute left-1/2 top-0 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/30 blur-3xl" />
      </div>
      <div className="container-1m relative py-20 text-center lg:py-28">
        <h2 className="mx-auto max-w-3xl font-serif text-4xl font-semibold uppercase leading-[1.05] tracking-[0.02em] text-white text-balance sm:text-5xl lg:text-[3.5rem]">
          Not everyone is ready.
          <br />
          <span className="text-gold-light">If you are, we&apos;ve been waiting.</span>
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-lg text-light">
          One Mission is invitation-only. Request your place, and someone from the
          community will personally welcome you in.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button href="/signup" size="lg" variant="white">
            Request Your Place <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button href="/contact" size="lg" variant="ghost" className="border border-white/25 text-white hover:bg-white/10">
            <MessageCircle className="h-4 w-4" aria-hidden="true" /> Talk to a Mentor
          </Button>
        </div>
      </div>
    </section>
  );
}
