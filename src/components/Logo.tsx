import Link from "next/link";
import { siteSettings } from "@/data/siteSettings";

/**
 * BRAND MARKS
 * -----------
 * Inspired by the One Mission Collection print marks. Drawn as inline SVG using
 * `currentColor`, so each mark inks near-black on light backgrounds and reads
 * bone/white on dark ones automatically — no separate light/dark asset needed.
 *
 * To use the exact distressed-texture PNG artwork instead, drop the file in
 * /public/images and set `logoImage` in src/data/siteSettings.ts to its path.
 */

const DISPLAY_FONT =
  'var(--font-display), "Helvetica Neue", Arial, sans-serif';

/**
 * Monogram1M — the "OM" (One Mission) monogram.
 * (Kept named `Monogram1M` so existing imports across the app keep working.)
 */
export function Monogram1M({ className = "h-8 w-auto" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 132 72"
      className={className}
      role="img"
      aria-label="One Mission"
    >
      <text
        x="50%"
        y="52%"
        dominantBaseline="central"
        textAnchor="middle"
        fill="currentColor"
        style={{
          fontFamily: DISPLAY_FONT,
          fontWeight: 800,
          fontSize: "62px",
          letterSpacing: "3px",
        }}
      >
        OM
      </text>
    </svg>
  );
}

/**
 * OneMissionArc — the collegiate "ONE MISSION / FOUNDERS CLUB" circular mark.
 * Used as a large brand watermark and badge. `currentColor` driven.
 */
export function OneMissionArc({
  className = "h-40 w-40",
  founders = true,
}: {
  className?: string;
  founders?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 240 240"
      className={className}
      role="img"
      aria-label="One Mission — Founders Club"
    >
      <defs>
        <path id="om-arc-top" d="M 28 132 A 92 92 0 1 1 212 132" fill="none" />
      </defs>
      <text
        fill="currentColor"
        textAnchor="middle"
        style={{
          fontFamily: DISPLAY_FONT,
          fontWeight: 800,
          fontSize: "33px",
          letterSpacing: "2px",
        }}
      >
        <textPath href="#om-arc-top" startOffset="50%">
          ONE MISSION
        </textPath>
      </text>
      {founders && (
        <text
          x="120"
          y="150"
          textAnchor="middle"
          fill="currentColor"
          style={{
            fontFamily: DISPLAY_FONT,
            fontWeight: 700,
            fontSize: "12px",
            letterSpacing: "5px",
          }}
        >
          FOUNDERS CLUB
        </text>
      )}
    </svg>
  );
}

/**
 * Logo — the OM monogram + optional wordmark, linking home.
 * If `logoImage` is set in siteSettings it renders that raster art instead
 * (flipped to white on dark sections). Otherwise the adaptive inline mark is used.
 */
export function Logo({ light = false, wordmark = true }: { light?: boolean; wordmark?: boolean }) {
  const { logoImage, brandName } = siteSettings;
  return (
    <Link
      href="/"
      aria-label={`${brandName} home`}
      className={`inline-flex items-center gap-3 ${light ? "text-cream" : "text-primary"}`}
    >
      {logoImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoImage} alt={brandName} className={`h-14 w-auto sm:h-16 ${light ? "brightness-0 invert" : ""}`} />
      ) : (
        <Monogram1M className="h-9 w-auto sm:h-10" />
      )}
      {wordmark && !logoImage && (
        <span
          className={`text-sm font-semibold uppercase tracking-[0.22em] ${
            light ? "text-cream" : "text-primary"
          }`}
        >
          One Mission
        </span>
      )}
    </Link>
  );
}
