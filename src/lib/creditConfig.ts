/**
 * Credit system config. Single-balance model with a WEEKLY floor:
 *  - New members get a one-time WELCOME grant of 5 credits on first touch
 *    (set in the get_credit_balance / spend_credits DB functions). Members who
 *    joined earlier keep their original balance — the grant is future-only.
 *  - Once per week, the first time a member touches a tool their balance is
 *    topped up TO the floor (DAILY_FREE) if it sits below it — never above. A
 *    member at 2 refills to 5; a member at 15 stays 15 (no stacking). The
 *    weekly cadence is enforced in the DB functions (top-up keyed to the Monday
 *    of the current UTC week), so this number is "free credits per week".
 *  - Purchased credits stack on top of the floor and persist. Tweak numbers here.
 */

// Free floor per member, refreshed WEEKLY. Each member is topped up to this many
// credits once per calendar week if they're below it (never lowered if above).
// The welcome grant (5 for new members) sits at/above this floor and is spent
// down first. The name is kept as DAILY_FREE for import stability, but the
// cadence is weekly — see the get_credit_balance / spend_credits DB functions.
// Overridable via env; leave NEXT_PUBLIC_DAILY_FREE_CREDITS unset to use 5.
export const DAILY_FREE = Number(process.env.NEXT_PUBLIC_DAILY_FREE_CREDITS ?? 5);

// What each metered action costs. Plays of the Week + Daily Brief are free
// (cached/shared for everyone) so they aren't listed here.
export const CREDIT_COST = {
  chat: 1,       // one OM AI message
  signal: 3,     // generate a play on OM AI Plays
  deepdive: 1,   // open the full reasoning breakdown
  scan: 5,       // Market Pulse scan (heaviest — up to 8 data calls)
  ghost: 5,      // MFXGHOST full institutional read — the heaviest AI call (up to 4k-token output + multi-timeframe data). Priced as a premium action so its margin holds even on the cheapest credit pack.
  genx: 5,       // GENX flagship Gold decision engine — deterministic engine + a short AI market story. Every analyze/re-analyze charges the full read.
  chartread: 2,  // OM Charts AI read — vision analysis of a marked-up chart + live data
  command: 1,    // OM AI Market Command — full deterministic qualification run (multi-TF + risk engine)
  flow_autorun: 1, // FLOW auto-run — billed once per 30-min window while auto-run is ON and markets are open (charged by the executor cron via spend_credits_for).
} as const;

export type Feature = keyof typeof CREDIT_COST;

// Buyable credit packs. Priced with healthy margin over the ~2¢/action cost;
// adjust freely. `id` is what the checkout route looks up.
export type Pack = { id: string; label: string; credits: number; priceUsd: number; blurb: string; best?: boolean };
export const PACKS: Pack[] = [
  { id: "starter", label: "Starter", credits: 50, priceUsd: 19.99, blurb: "A week or two of extra plays" },
  { id: "trader", label: "Trader", credits: 200, priceUsd: 39.99, blurb: "Best value for daily traders", best: true },
  { id: "pro", label: "Pro", credits: 500, priceUsd: 79.99, blurb: "For heavy users & power days" },
];
export const packById = (id: string): Pack | null => PACKS.find((p) => p.id === id) || null;

// Trading Suite — the $39/mo add-on membership. One flat price unlocks everything,
// grants a monthly credit allowance (topped up to the floor each billing period,
// no rollover), and makes FLOW auto-run FREE (non-members keep the pay-per-use
// meter). Overridable via env so the price can be tuned without a redeploy.
export const SUITE = {
  key: "trading_suite",
  label: "Trading Suite",
  priceUsd: Number(process.env.NEXT_PUBLIC_SUITE_PRICE_USD ?? 39),
  monthlyCredits: Number(process.env.NEXT_PUBLIC_SUITE_CREDITS ?? 250),
  interval: "month" as const,
} as const;

// Auto-refill — card on file, off-session top-ups (replaces the subscription as the
// primary path). When a member turns it ON and their spendable balance drops BELOW
// `threshold`, the auto-refill cron charges their saved card `priceCents` and grants
// `credits`. The one-tap manual top-up buys `manualCredits` for `manualPriceCents`.
// All amounts overridable via env so pricing can be tuned without a redeploy.
export const AUTOREFILL = {
  threshold: Number(process.env.NEXT_PUBLIC_AUTOREFILL_THRESHOLD ?? 3),
  credits: Number(process.env.NEXT_PUBLIC_AUTOREFILL_CREDITS ?? 50),
  priceCents: Number(process.env.NEXT_PUBLIC_AUTOREFILL_PRICE_CENTS ?? 1999), // $19.99 / 50
  manualCredits: Number(process.env.NEXT_PUBLIC_AUTOREFILL_MANUAL_CREDITS ?? 200),
  manualPriceCents: Number(process.env.NEXT_PUBLIC_AUTOREFILL_MANUAL_PRICE_CENTS ?? 3999), // $39.99 / 200
} as const;
