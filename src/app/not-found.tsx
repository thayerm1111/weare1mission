import Link from "next/link";
import { Home, ArrowRight } from "lucide-react";
import { Button } from "@/components/Button";

export default function NotFound() {
  return (
    <section className="relative overflow-hidden bg-gradient-hero">
      <div className="container-1m flex min-h-[70vh] flex-col items-center justify-center py-24 text-center">
        <p className="text-[6rem] font-black leading-none text-white/90 sm:text-[8rem]">404</p>
        <h1 className="mt-2 text-2xl font-bold text-white sm:text-3xl">This page went off-mission.</h1>
        <p className="mt-3 max-w-md text-light">
          The page you&apos;re looking for doesn&apos;t exist or may have moved. Let&apos;s get you back on track.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button href="/" variant="white" size="lg"><Home className="h-4 w-4" aria-hidden="true" /> Back Home</Button>
          <Link href="/start-here" className="inline-flex items-center gap-1.5 rounded-full border border-white/30 px-6 py-4 text-sm font-semibold text-white hover:bg-white/10 focus-ring">
            Start Here <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
