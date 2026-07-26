/**
 * Shared gamification data & pure helpers (no React, no "use client").
 * Safe to import from BOTH server route handlers and client components.
 * The client hook lives in gamification.ts; server validation uses MISSION_XP.
 */

export type Side = "ones" | "builders";

export const TIERS: Record<Side, string[]> = {
  ones: [
    "Beginner", "Market Explorer", "Chart Reader", "Risk Manager",
    "Disciplined Trader", "Consistent Trader", "Elite Trader", "Master Trader", "Legend",
  ],
  builders: [
    "Builder", "Connector", "Recruiter", "Influencer", "Leader",
    "Coach", "Director", "Visionary", "Icon", "Legend",
  ],
};

export const TIER_XP = [0, 120, 300, 600, 1050, 1700, 2600, 3900, 5600, 8000];

export type Mission = { id: string; label: string; xp: number; href?: string; cta?: string };

export const DAILY_MISSIONS: Record<Side, Mission[]> = {
  ones: [
    { id: "mind", label: "Read today's mindset", xp: 10 },
    { id: "omai", label: "Ask OM AI a trading question", xp: 20, href: "/portal/om-ai", cta: "Open OM AI" },
    { id: "signal", label: "Generate a play in OM AI Plays", xp: 20, href: "/portal/signals", cta: "Open Plays" },
    { id: "review", label: "Review one trade or journal entry", xp: 15 },
  ],
  builders: [
    { id: "reach", label: "Reach out to 3 new people", xp: 20 },
    { id: "coach", label: "Ask OM AI a business question", xp: 20, href: "/portal/om-ai", cta: "Open OM AI" },
    { id: "circle", label: "Engage in the Inner Circle", xp: 15, href: "/portal/leadership", cta: "Open" },
    { id: "dmo", label: "Complete your daily method of operation", xp: 15 },
  ],
};

/** id → xp, flattened across sides, for server-side validation (never trust client xp). */
export const MISSION_XP: Record<string, number> = Object.fromEntries(
  [...DAILY_MISSIONS.ones, ...DAILY_MISSIONS.builders].map((m) => [m.id, m.xp])
);

export const QUOTES: Record<Side, string[]> = {
  ones: [
    "Discipline is remembering what you want most, not what you want now.",
    "The market rewards patience, not prediction.",
    "Protect your capital first. Profits are what's left after you survive.",
    "You don't have to trade today. You have to be right over 100 trades.",
    "Plan the trade. Trade the plan. Journal the result.",
    "Consistency beats intensity. Show up, take the clean setups, repeat.",
    "Your edge is only an edge if you follow it every single time.",
  ],
  builders: [
    "Champions are made in the boring reps nobody sees.",
    "Talk to more people. Everything downstream gets easier.",
    "You're not selling — you're inviting people to something you believe in.",
    "The fortune is in the follow-up.",
    "Lead by example first, by words second.",
    "Serve, don't sell. Value first, always.",
    "Do the work today your future self will thank you for.",
  ],
};

export function tierFor(side: Side, xp: number) {
  const tiers = TIERS[side];
  let i = 0;
  for (let k = 0; k < tiers.length; k++) {
    if (xp >= (TIER_XP[k] ?? Infinity)) i = k;
    else break;
  }
  const floor = TIER_XP[i] ?? 0;
  const ceil = TIER_XP[i + 1];
  const pct = ceil ? Math.min(100, Math.max(0, Math.round(((xp - floor) / (ceil - floor)) * 100))) : 100;
  return {
    index: i,
    name: tiers[i],
    level: i + 1,
    nextTier: tiers[i + 1] as string | undefined,
    ceil,
    toNext: ceil ? Math.max(0, ceil - xp) : 0,
    pct,
    max: !ceil,
  };
}

function dayOfYear(d = new Date()) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

export function quoteOfDay(side: Side) {
  const pool = QUOTES[side];
  return pool[dayOfYear() % pool.length];
}
