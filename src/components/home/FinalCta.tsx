import { ArrowRight, MessageCircle } from "lucide-react";
import { Button } from "../Button";

export function FinalCta() {
  return (
    <section className="relative overflow-hidden bg-gradient-navy">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute left-1/2 top-0 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/30 blur-3xl" />
      </div>
      <div className="container-1m relative py-20 text-center lg:py-28">
        <h2 className="mx-auto max-w-3xl text-3xl font-bold leading-tight text-white text-balance sm:text-4xl lg:text-5xl">
          Your Next Chapter Starts With One Decision.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lg text-light">
          Get connected, complete your onboarding, and begin your journey with the 1 Mission community.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button href="/start-here" size="lg" variant="white">
            Start Your Journey <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button href="/contact" size="lg" variant="ghost" className="border border-white/25 text-white hover:bg-white/10">
            <MessageCircle className="h-4 w-4" aria-hidden="true" /> Contact Your Mentor
          </Button>
        </div>
      </div>
    </section>
  );
}
