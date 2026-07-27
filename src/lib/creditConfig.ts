/**
 * Credit system config. Members get a daily free allowance that resets every
 * UTC day; purchased credits stack on top and never expire. Free credits are
 * always spent first. Tweak the numbers here — everything reads from this file.
 */

// Daily free credits per member (resets each day). Public so the UI can show it.
export const DAILY_FREE = Number(process.env.NEXT_PUBLIC_DAILY_FREE_CREDITS || 15);

// What each metered action costs. Plays of the Week + Daily Brief are free
// (cached/shared for everyone) so they aren't listed here.
export const CREDIT_COST = {
  chat: 1,       // one OM AI message
  signal: 1,     // generate a play on OM AI Plays
  deepdive: 1,   // open the full reasoning breakdown
  scan: 2,       // Market Pulse scan (heaviest — up to 8 data calls)
  ghost: 3,      // XAUGHOST full gold intelligence run (multi-timeframe + deep analysis)
} as const;

export type Feature = keyof typeof CREDIT_COST;

// Buyable credit packs. Priced with healthy margin over the ~2¢/action cost;
// adjust freely. `id` is what the checkout route looks up.
export type Pack = { id: string; label: string; credits: number; priceUsd: number; blurb: string; best?: boolean };
export const PACKS: Pack[] = [
  { id: "starter", label: "Starter", credits: 100, priceUsd: 9, blurb: "A week or two of extra plays" },
  { id: "trader", label: "Trader", credits: 300, priceUsd: 19, blurb: "Best value for daily traders", best: true },
  { id: "pro", label: "Pro", credits: 1000, priceUsd: 49, blurb: "For heavy users & power days" },
];
export const packById = (id: string): Pack | null => PACKS.find((p) => p.id === id) || null;
