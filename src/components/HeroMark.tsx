"use client";

import { useState } from "react";
import { Monogram1M } from "./Logo";

/**
 * Homepage hero visual. Shows the 3D "1M" render at /public/images/hero-1m.png.
 * Until that image is added, it gracefully falls back to the flat 1M monogram.
 * To change the image, replace /public/images/hero-1m.png.
 */
export function HeroMark() {
  const [ok, setOk] = useState(true);
  return (
    <div className="relative flex aspect-square w-full max-w-md items-center justify-center overflow-hidden rounded-2xl border border-[#E4DCCB] bg-cream shadow-glow">
      {ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/images/Hero%20image.%20PNG.png"
          alt="1 Mission"
          className="h-full w-full object-cover"
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
  );
}
