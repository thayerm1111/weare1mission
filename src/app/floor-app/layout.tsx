import type { Metadata, Viewport } from "next";

/**
 * THE FLOOR — STANDALONE APP SHELL (owner 09-10: "make the floor a separate site...
 * simply another website they login to and it feels like a separate tool/app").
 *
 * Served at floor.weare1mission.com via a host rewrite in src/middleware.ts:
 *   floor./        → /floor-app          (the terminal — login required)
 *   floor./login   → /floor-app/login    (Floor-branded sign-in, same member accounts)
 *
 * Accounts stay ONE system: members register on weare1mission.com; The Floor is a
 * second front door into the same Supabase auth. This layout paints a full-viewport
 * dark shell OVER the marketing site's header/footer (fixed inset-0, z-70), so the
 * Floor reads as its own product without forking the root layout — and the main
 * site's pages keep their static rendering untouched.
 */

const FLOOR_OG = "https://floor.weare1mission.com/images/floor-og.png";
export const metadata: Metadata = {
  title: "The Floor — Live Trading Intelligence",
  description: "The 1 Mission trading floor: FLOW, GENX, Matty Pips, OM AI, Market Pulse and Live Plays — one desk, live.",
  robots: { index: false, follow: false }, // members-only app — keep it out of search
  // LINK-PREVIEW BANNER (owner 09-10: "change the banner to something more the floor
  // feeling") — a shared floor.weare1mission.com link unfurls as the dark terminal
  // card, not the main site's cream marketing banner. Applies to the terminal AND the
  // login page (crawlers land on /login via the auth redirect).
  openGraph: {
    title: "The Floor — Live Trading Intelligence",
    description: "Live trading intelligence. Real results. Powered by OM AI. Sign in with your 1 Mission account.",
    url: "https://floor.weare1mission.com",
    siteName: "The Floor",
    images: [{ url: FLOOR_OG, width: 1200, height: 630, alt: "The Floor — live trading desk" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "The Floor — Live Trading Intelligence",
    description: "Live trading intelligence. Real results. Powered by OM AI.",
    images: [FLOOR_OG],
  },
};

export const viewport: Viewport = { themeColor: "#050505", width: "device-width", initialScale: 1 };

export default function FloorAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-[#050505] text-slate-100">
      {children}
    </div>
  );
}
