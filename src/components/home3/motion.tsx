"use client";

import { useEffect, useRef, useState } from "react";

/**
 * THE MOTION PRIMITIVES.
 *
 * NO ANIMATION LIBRARY, AND THAT IS A DESIGN DECISION RATHER THAN A SHORTCUT.
 *
 * Framer Motion is roughly 40KB gzipped and it runs animation on the main thread through React. On a
 * marketing homepage the single most important number is how fast the first screen paints, and a
 * visitor on a phone deciding whether this looks like a serious company is making that judgement
 * during the exact window a hydration-blocking animation runtime is most expensive. Everything below
 * is IntersectionObserver plus CSS transforms and opacity — both compositor properties, both free of
 * layout and paint, and both running whether or not React has hydrated yet.
 *
 * What that buys: the page is fast, and the motion still lands on the frame it should. What it costs:
 * no spring physics and no gesture choreography. Neither is what makes a page feel expensive. Timing,
 * restraint and easing are.
 *
 * THE EASING IS THE WHOLE CRAFT. A linear fade reads as cheap; so does a bounce. Everything here uses
 * a long, decelerating curve — fast to start, slow to settle — which is how physical objects come to
 * rest and is why it reads as weight rather than as animation.
 */

/** Fast out, slow to rest. The single curve the whole page moves on. */
export const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

function useInView<T extends HTMLElement>(threshold = 0.15, once = true) {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reduced motion is respected by showing the end state immediately — never by removing the
    // content, and never by leaving it invisible.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setSeen(true); return; }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setSeen(true); if (once) io.disconnect(); }
      else if (!once) setSeen(false);
    }, { threshold, rootMargin: "0px 0px -8% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold, once]);
  return { ref, seen };
}

/**
 * The page's one reveal.
 *
 * Fourteen pixels, not forty. A large travel distance reads as a slide transition and draws attention
 * to itself; a small one reads as the content settling into place and draws attention to the content.
 */
export function Rise({
  children, delay = 0, y = 14, className = "",
}: {
  children: React.ReactNode; delay?: number; y?: number; className?: string;
}) {
  const { ref, seen } = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: seen ? 1 : 0,
        transform: seen ? "none" : `translate3d(0, ${y}px, 0)`,
        transition: `opacity 900ms ${EASE} ${delay}ms, transform 900ms ${EASE} ${delay}ms`,
        willChange: seen ? "auto" : "opacity, transform",
      }}
    >
      {children}
    </div>
  );
}

/**
 * How far through a section the viewport has travelled, 0 to 1.
 *
 * This is what drives the sticky storytelling: the section pins, and the scroll that would have moved
 * it instead moves the story inside it. Read on rAF from a passive listener — never in the scroll
 * handler itself — so a fast flick cannot queue up more work than the compositor can retire.
 */
export function useSectionProgress<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [p, setP] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setP(1); return; }

    let raf = 0, last = -1;
    const read = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const travel = r.height - window.innerHeight;
      if (travel <= 0) { setP(0); return; }
      const next = Math.min(1, Math.max(0, -r.top / travel));
      // Only re-render on a visible change. Sub-half-percent moves are invisible and cost a frame.
      if (Math.abs(next - last) > 0.004) { last = next; setP(next); }
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(read); };

    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return { ref, progress: p };
}

/** Map a 0..1 progress onto one step of n, with the crossfade window between them. */
export function stepOf(progress: number, n: number) {
  const raw = progress * n;
  const index = Math.min(n - 1, Math.floor(raw));
  return { index, within: Math.min(1, Math.max(0, raw - index)) };
}
