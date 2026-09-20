"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { EASE } from "./motion";

/**
 * THE HERO.
 *
 * Ten seconds to answer three questions: what is this, is it serious, and what do I do next. Every
 * decision here serves one of those and nothing else.
 *
 * WHAT IT IS NOT. No stock photography of a man at six monitors. No candlestick chart racing upward.
 * No counter ticking a fabricated profit figure. Those are the visual vocabulary of the exact
 * category this has to stand apart from, and a visitor has seen a thousand of them — using one puts
 * this page in that pile before a word is read.
 *
 * THE VISUAL IS THE PRODUCT'S ACTUAL SHAPE. Five nodes, one instrument, intelligence moving between
 * them in a loop that never resolves — because the system genuinely never stops. It is drawn rather
 * than filmed, which means it is a few kilobytes instead of a few megabytes, it is sharp on every
 * display, and it starts on the first frame rather than after a video buffers.
 *
 * THE MOTION IS SLOW ON PURPOSE. Confidence moves slowly. A hero that races is trying to convince
 * you; one that breathes assumes you are already interested.
 */

const NODES = [
  { id: "plays", label: "OM AI Plays", angle: -90 },
  { id: "genx", label: "GENX", angle: -18 },
  { id: "cc", label: "Command Center", angle: 54 },
  { id: "flow", label: "FLOW", angle: 126 },
  { id: "floor", label: "The Floor", angle: 198 },
];

function Orbit() {
  const [t, setT] = useState(0);
  const raf = useRef(0);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      setT((now - start) / 1000);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  const R = 148;
  // One full circuit every twenty seconds. A pulse arrives somewhere roughly every four.
  const travel = (t % 20) / 20;

  return (
    <svg viewBox="-220 -220 440 440" className="h-full w-full" role="img"
      aria-label="The One Mission ecosystem: intelligence moving between OM AI Plays, GENX, Command Center, FLOW and The Floor.">
      <defs>
        <radialGradient id="h3-core" cx="50%" cy="42%" r="60%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="45%" stopColor="#DCE7FB" />
          <stop offset="100%" stopColor="#B9CCF2" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="h3-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4C7DF0" stopOpacity="0.30" />
          <stop offset="50%" stopColor="#4C7DF0" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#C9A961" stopOpacity="0.22" />
        </linearGradient>
      </defs>

      {/* the path the intelligence travels */}
      <circle r={R} fill="none" stroke="url(#h3-ring)" strokeWidth="1.25" />
      <circle r={R * 0.62} fill="none" stroke="#0B0D12" strokeOpacity="0.05" strokeWidth="1" />

      {/* the instrument at the centre — everything here is about one market */}
      <circle r="58" fill="url(#h3-core)" opacity="0.95" />
      <text textAnchor="middle" y="-2" className="fill-[#0B0D12]"
        style={{ fontSize: 15, fontWeight: 800, letterSpacing: "0.14em" }}>XAUUSD</text>
      <text textAnchor="middle" y="15" className="fill-[#0B0D12]" opacity="0.45"
        style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: "0.22em" }}>GOLD</text>

      {/*
        * The pulse. One point of light completing the loop, brightest at the node it is passing, so
        * the eye learns the order of the system without a single label being read as a list.
        */}
      {(() => {
        const a = travel * Math.PI * 2 - Math.PI / 2;
        return <circle cx={Math.cos(a) * R} cy={Math.sin(a) * R} r="4.5" fill="#4C7DF0" opacity="0.9" />;
      })()}

      {NODES.map((n, i) => {
        const a = (n.angle * Math.PI) / 180;
        const x = Math.cos(a) * R, y = Math.sin(a) * R;
        // How close the travelling pulse is to this node, 0..1 — drives a brief lift as it passes.
        const own = ((n.angle + 90) / 360 + 1) % 1;
        const d = Math.min(Math.abs(travel - own), 1 - Math.abs(travel - own));
        const near = Math.max(0, 1 - d * 14);
        return (
          <g key={n.id} style={{ transform: `translate(${x}px, ${y}px)` }}>
            <circle r={9 + near * 3} fill="#FFFFFF" stroke="#0B0D12" strokeOpacity={0.10 + near * 0.35} strokeWidth="1.25" />
            <circle r={3 + near * 1.6} fill={near > 0.35 ? "#4C7DF0" : "#8FA3C4"} />
            <text textAnchor="middle" y={y > 40 ? 30 : -19} className="fill-[#0B0D12]"
              opacity={0.42 + near * 0.5}
              style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.10em", transition: `opacity 600ms ${EASE}` }}>
              {n.label.toUpperCase()}
            </text>
            {i === 0 && null}
          </g>
        );
      })}
    </svg>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden" style={{ background: "var(--h3-page)" }}>
      {/* Ambient light, not decoration: it lifts the centre of the composition off the page. */}
      <div aria-hidden className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(900px 520px at 50% 6%, rgba(76,125,240,0.10), transparent 70%)" }} />

      <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-6 pb-20 pt-24 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pb-28 lg:pt-32">
        <div>
          {/*
            * The eyebrow earns the headline. It says what category this is in, so the headline does
            * not have to spend itself explaining and can be about what the product is FOR.
            */}
          <p className="h3-in" style={{ animationDelay: "40ms" }}>
            <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em]"
              style={{ borderColor: "var(--h3-line)", background: "var(--h3-surface)", color: "var(--h3-muted)" }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#4C7DF0" }} />
              Gold intelligence, running continuously
            </span>
          </p>

          <h1 className="h3-in mt-6 text-[clamp(2.6rem,6.2vw,4.5rem)] font-black leading-[0.96] tracking-[-0.035em]"
            style={{ color: "var(--h3-ink)", animationDelay: "120ms" }}>
            One market.
            <br />
            Understood completely.
          </h1>

          <p className="h3-in mt-6 max-w-lg text-[17px] leading-relaxed" style={{ color: "var(--h3-muted)", animationDelay: "220ms" }}>
            Five systems watching XAUUSD as one. They find the opportunity, judge it,
            explain it in plain words, take it, and manage it — and you can talk to any
            of it, out loud, while it runs.
          </p>

          <div className="h3-in mt-8 flex flex-wrap items-center gap-3" style={{ animationDelay: "320ms" }}>
            <Link href="/signup" className="h3-cta rounded-full px-6 py-3 text-[13px] font-bold tracking-[0.02em]"
              style={{ background: "var(--h3-ink)", color: "#FFFFFF" }}>
              Start with One Mission
            </Link>
            <Link href="#how" className="rounded-full border px-6 py-3 text-[13px] font-bold tracking-[0.02em] transition-colors"
              style={{ borderColor: "var(--h3-line)", color: "var(--h3-ink)", background: "var(--h3-surface)" }}>
              See how it works
            </Link>
          </div>

          <p className="h3-in mt-5 text-[12px] leading-relaxed" style={{ color: "var(--h3-faint)", animationDelay: "400ms" }}>
            Trading involves risk. This is software, not a promise — you can lose money using it.
          </p>
        </div>

        <div className="h3-in relative mx-auto aspect-square w-full max-w-[460px]" style={{ animationDelay: "260ms" }}>
          <Orbit />
        </div>
      </div>
    </section>
  );
}

export default Hero;
