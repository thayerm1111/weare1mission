"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RefreshCw, ArrowRight, AlertTriangle } from "lucide-react";

/**
 * Global error boundary. Catches unexpected runtime errors in any route so a
 * member never sees a raw crash — they get a calm, branded recovery screen with
 * a one-tap retry. (Matches the 404 styling.)
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surface to the console for debugging; wire to real monitoring later.
    // eslint-disable-next-line no-console
    console.error("App error boundary:", error);
  }, [error]);

  return (
    <section className="relative overflow-hidden bg-gradient-hero">
      <div className="container-1m flex min-h-[70vh] flex-col items-center justify-center py-24 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white/10 text-white ring-1 ring-white/20" aria-hidden="true">
          <AlertTriangle className="h-7 w-7" />
        </span>
        <h1 className="mt-6 text-2xl font-bold text-white sm:text-3xl">Something went sideways.</h1>
        <p className="mt-3 max-w-md text-light">
          That&apos;s on us, not you — a temporary hiccup. Give it another try, and if it keeps
          happening we&apos;re already on it.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={() => reset()}
            className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-4 text-sm font-semibold text-navy transition-colors hover:bg-ice focus-ring"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
          </button>
          <Link
            href="/portal"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/30 px-6 py-4 text-sm font-semibold text-white hover:bg-white/10 focus-ring"
          >
            Back to Portal <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
        {error?.digest && <p className="mt-6 text-xs text-white/40">Reference: {error.digest}</p>}
      </div>
    </section>
  );
}
