/**
 * Credit system config. Single-balance model with a daily floor:
 *  - New members get a one-time WELCOME grant of 20 credits (signup trigger).
 *  - Each day, the first time a member touches a tool their balance is topped
 *    up TO the floor (DAILY_FREE) if it sits below it — never above. A member
 *    at 3 refills to 10; a member at 15 stays 15 (no daily stacking).
 *  - Purchased credits stack on top of the floor and persist. Tweak numbers here.
 */

// Daily free floor per member. Each member is topped up to this many credits
// once per day if they're below it (never lowered if above). 20 welcome credits
// on signup sit above this floor and are spent down before the floor matters.
// Overridable via env; leave NEXT_PUBLIC_DAILY_FREE_CREDITS unset to use 10.
export const DAILY_FREE = Number(process.env.NEXT_PUBLIC_DAILY_FREE_CREDITS ?? 10);

// What each metered action costs. Plays of the Week + Daily Brief are free
// (cached/shared for everyone) so they aren't listed here.
export const CREDIT_COST = {
  chat: 1,       // one OM AI message
  signal: 1,     // generate a play on OM AI Plays
  deepdive: 1,   // open the full reasoning breakdown
  scan: 2,       // Market Pulse scan (heaviest — up to 8 data calls)
  ghost: 1,      // MFXGHOST full multi-instrument intelligence run (multi-timeframe + deep analysis)
  chartread: 2,  // OM Charts AI read — vision analysis of a marked-up chart + live data
  command: 1,    // OM AI Market Command — full deterministic qualification run (multi-TF + risk engine)
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
