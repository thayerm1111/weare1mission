"use client";

import { useEffect, useRef, useState } from "react";

/** Restrained scroll reveal — fade + 14px rise, once, CSS-transition only. */
export function Reveal({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setOn(true); io.disconnect(); } },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={className}
      style={{ opacity: on ? 1 : 0, transform: on ? "none" : "translateY(14px)", transition: `opacity .7s ease ${delay}ms, transform .7s ease ${delay}ms` }}>
      {children}
    </div>
  );
}

/**
 * Scroll progress (0..1) through a section — drives status progressions
 * (WAIT → APPROACHING → ARMED → TAKE NOW) as the visitor scrolls. Passive
 * listener, no layout thrash; respects reduced motion by finishing at 1.
 */
export function useSectionProgress(): { ref: React.RefObject<HTMLDivElement>; progress: number } {
  const ref = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setProgress(1);
      return;
    }
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight || 1;
        // 0 when the section top hits ~85% of the viewport, 1 when its bottom nears ~35%.
        const total = r.height + vh * 0.5;
        const seen = Math.min(Math.max(vh * 0.85 - r.top, 0), total);
        setProgress(Math.max(0, Math.min(1, seen / total)));
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); };
  }, []);
  return { ref, progress };
}
