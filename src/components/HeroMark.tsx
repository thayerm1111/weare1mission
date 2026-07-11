"use client";

import { useRef, useState } from "react";
import { Monogram1M } from "./Logo";

/**
 * Homepage hero visual — the 3D "1M" render at /public/images/hero-1m.png.
 * It gently floats on its own and tilts toward the cursor for a lively, 3D feel.
 * Falls back to the flat 1M monogram if the image is missing. Motion is disabled
 * automatically for users who prefer reduced motion (see globals.css).
 */
export function HeroMark() {
  const [ok, setOk] = useState(true);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);

  function onMove(e: React.MouseEvent) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5; // -0.5 .. 0.5
    const py = (e.clientY - r.top) / r.height - 0.5;
    setTilt({ x: py * -10, y: px * 12 });
  }

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={() => setTilt({ x: 0, y: 0 })}
      className="[perspective:1100px]"
    >
      <div className="hero-float">
        <div
          className="relative flex aspect-square w-full max-w-md items-center justify-center overflow-hidden rounded-2xl border border-[#E4DCCB] bg-cream shadow-glow transition-transform duration-300 ease-out will-change-transform"
          style={{ transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` }}
        >
          {ok ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src="/images/ChatGPT%20Image%20Jul%2011,%202026,%2012_30_54%20PM.png"
              alt="1 Mission"
              className="h-full w-full object-contain p-8"
              onError={() => setOk(false)}
            />
          ) : (
            <>
              <Monogram1M className="h-2/3 w-2/3 text-primary" />
              <span className="absolute bottom-5 right-6 text-[11px] font-semibold uppercase tracking-label text-medium">
                1 Mission
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
