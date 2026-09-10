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

export const metadata: Metadata = {
  title: "The Floor — Live Trading Intelligence",
  description: "The 1 Mission trading floor: FLOW, GENX, Matty Pips, OM AI, Market Pulse and Live Plays — one desk, live.",
  robots: { index: false, follow: false }, // members-only app — keep it out of search
};

export const viewport: Viewport = { themeColor: "#050505", width: "device-width", initialScale: 1 };

export default function FloorAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-[#050505] text-slate-100">
      {children}
    </div>
  );
}
