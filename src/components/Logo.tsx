import Link from "next/link";
import { siteSettings } from "@/data/siteSettings";

/**
 * Monogram1M — the "1M" mark as inline SVG.
 * Uses `currentColor`, so it takes the surrounding text color and looks correct
 * on both light (cream) and dark (ink) backgrounds automatically.
 * The same artwork also lives at /public/images/logo.svg for external use.
 */
export function Monogram1M({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 96" className={className} fill="currentColor" role="img" aria-label="1 Mission">
      {/* numeral 1 */}
      <path d="M10,27 L30,8 L30,88 L16,88 L16,31 L8,35 Z" />
      {/* letter M */}
      <path d="M40,88 L40,20 L53,20 L64,54 L75,20 L88,20 L88,88 L75,88 L75,49 L64,72 L53,49 L53,88 Z" />
    </svg>
  );
}

/**
 * Logo — the 1M monogram + optional wordmark.
 * To use a raster PNG instead: set `logoImage` in src/data/siteSettings.ts to a
 * file path (e.g. "/images/logo.png") and drop the file in /public/images.
 * Set `wordmark={false}` anywhere you want just the mark.
 */
export function Logo({ light = false, wordmark = true }: { light?: boolean; wordmark?: boolean }) {
  const { logoImage, brandName } = siteSettings;
  return (
    <Link
      href="/"
      aria-label={`${brandName} home`}
      className={`inline-flex items-center gap-2.5 ${light ? "text-cream" : "text-primary"}`}
    >
      {logoImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoImage} alt={brandName} className="h-7 w-auto" />
      ) : (
        <Monogram1M className="h-7 w-7" />
      )}
      {wordmark && (
        <span
          className={`text-base font-semibold uppercase tracking-[0.18em] ${
            light ? "text-cream" : "text-primary"
          }`}
        >
          1 Mission
        </span>
      )}
    </Link>
  );
}
