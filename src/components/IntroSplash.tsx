"use client";

import { useEffect, useState } from "react";
import { Monogram1M } from "./Logo";

/**
 * A brief animated "1M" intro shown the first time someone lands on the site
 * in a session. Skips automatically for repeat views and for users who prefer
 * reduced motion. To disable entirely, remove <IntroSplash /> from layout.tsx.
 */
export function IntroSplash() {
  const [show, setShow] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let seen = false;
    try { seen = sessionStorage.getItem("1m_intro") === "1"; } catch {}
    if (reduce || seen) return;

    setShow(true);
    try { sessionStorage.setItem("1m_intro", "1"); } catch {}
    document.body.style.overflow = "hidden";

    const t1 = setTimeout(() => setLeaving(true), 1650);
    const t2 = setTimeout(() => { setShow(false); document.body.style.overflow = ""; }, 2250);
    return () => { clearTimeout(t1); clearTimeout(t2); document.body.style.overflow = ""; };
  }, []);

  if (!show) return null;
  return (
    <div
      className={`fixed inset-0 z-[200] flex items-center justify-center bg-cream transition-opacity duration-500 ${
        leaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      aria-hidden="true"
    >
      <div className="flex flex-col items-center">
        <div className="intro-mark text-primary">
          <Monogram1M className="h-28 w-28 sm:h-36 sm:w-36" />
        </div>
        <div className="intro-line mt-6 h-px bg-primary/30" />
        <p className="intro-tag mt-5 text-[11px] font-semibold uppercase tracking-label text-medium">
          One Mission. One Community. One Movement.
        </p>
      </div>
    </div>
  );
}
