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
  command_center: 5, // COMMAND CENTER — 5 credits opens it for 30 minutes, the clock starting when you open it (owner 09-21). See src/lib/ccPass.ts.
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

/*
 * THE FLOW PASS — $99/month, unmetered FLOW + GENX (owner 09-23).
 *
 * WHY THIS EXISTS. FLOW is an always-on product that was priced per-event, and the two never fit.
 * At the median member's burn (~22 credits/day) a $19.99 Starter pack lasted 2.3 days, a $39.99
 * Trader 9 days and a $79.99 Pro 23 days — so nobody could keep FLOW running for a month without
 * rebuying, and 73% of members who bought once never bought again. The Pass sells the thing the
 * member actually wants — "it just runs" — for one predictable price.
 *
 * WHAT IT COVERS. While the Pass is active, the features in PASS_COVERED are FREE and UNMETERED:
 * the FLOW/GENX automation (flow_autorun) and the GENX Gold decision engine (genx). A Pass holder
 * still TRADES normally — they are simply never charged for it, and never credit-paused.
 *
 * WHAT IT DOES NOT COVER. Everything else on the site (OM AI chat and plays, Market Pulse, MFXGHOST,
 * chart reads, Command Center) still costs credits, and the Pass tops the member up to
 * `monthlyCredits` each billing period — topped UP TO, never stacked, no rollover, exactly like the
 * old Suite allowance. ATLAS voice minutes are a separate product and are untouched.
 *
 * FAIR USE. `genx` is a real AI call, so unmetered is capped at GENX_FAIR_USE_PER_DAY analyses a day
 * per member — high enough that no honest member will ever see it, low enough that a stuck re-analyze
 * loop cannot run up a bill. Past the cap the member falls back to paying credits, they are not blocked.
 */
export const FLOW_PASS = {
  key: "flow_pass",
  label: "FLOW Pass",
  priceUsd: Number(process.env.NEXT_PUBLIC_FLOW_PASS_PRICE_USD ?? 99),
  monthlyCredits: Number(process.env.NEXT_PUBLIC_FLOW_PASS_CREDITS ?? 50),
  interval: "month" as const,
  // Marker written to BOTH the checkout session and the subscription metadata, so a renewal
  // invoice (which carries no session) can still tell this plan from the Suite and from voice.
  tag: "flow_pass",
} as const;

/** Features the Pass makes free. Everything not listed still costs credits. */
export const PASS_COVERED: ReadonlyArray<Feature> = ["flow_autorun", "genx"];
export const isPassCovered = (f: Feature): boolean => PASS_COVERED.includes(f);

/** Fair-use ceiling on the one covered feature that is an on-demand AI call. */
export const GENX_FAIR_USE_PER_DAY = Number(process.env.GENX_FAIR_USE_PER_DAY ?? 100);

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

// Refill sizes a member can pick for auto-refill (owner directive 08-30): each automatic
// charge tops up by their chosen amount. Mirrors the credit packs' pricing. The choice is
// stored per member in user_autorefill.refill_credits / refill_price_cents; the cron
// charges exactly what the row says, so changing this list never affects existing members
// until they re-pick.
export const AUTOREFILL_OPTIONS: ReadonlyArray<{ credits: number; priceCents: number }> = [
  { credits: 50, priceCents: 1999 },  // $19.99
  { credits: 200, priceCents: 3999 }, // $39.99 — best value
];
