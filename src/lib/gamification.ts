"use client";

/**
 * Gamification engine (v1 — per device via localStorage).
 *
 * Mirrors the useProgress pattern: this is the single seam to swap for Supabase
 * later (read initial state per authenticated user, upsert on change). The public
 * hook API (xp, tier, streak, missions, completeMission, celebrate) can stay
 * identical when persistence moves server-side.
 *
 * XP is a single global number; the *interpretation* (tier names) is side-aware,
 * so The One and The Builder show different progression ladders off the same XP.
 */
import { useCallback, useEffect, useState } from "react";

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

// Cumulative XP needed to REACH each tier index (index 0 = start).
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

type State = { xp: number; lastLogin: string; streak: number; best: number; days: Record<string, string[]> };
const EMPTY: State = { xp: 0, lastLogin: "", streak: 0, best: 0, days: {} };
const KEY = "om_game_v1";

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function today() { return ymd(new Date()); }
function yesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return ymd(d); }
function dayOfYear(d = new Date()) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

export function tierFor(side: Side, xp: number) {
  const tiers = TIERS[side];
  let i = 0;
  for (let k = 0; k < tiers.length; k++) {
    if (xp >= (TIER_XP[k] ?? Infinity)) i = k;
    else break;
  }
  const floor = TIER_XP[i] ?? 0;
  const ceil = TIER_XP[i + 1]; // undefined at max tier
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

export function quoteOfDay(side: Side) {
  const pool = QUOTES[side];
  return pool[dayOfYear() % pool.length];
}

export type Celebrate = { kind: "level" | "mission"; label: string } | null;

export function useGame(side: Side) {
  const [state, setState] = useState<State>(EMPTY);
  const [hydrated, setHydrated] = useState(false);
  const [celebrate, setCelebrate] = useState<Celebrate>(null);

  // Load once, then handle daily login + streak.
  useEffect(() => {
    let s: State = EMPTY;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) s = { ...EMPTY, ...(JSON.parse(raw) as Partial<State>) };
    } catch { /* ignore */ }
    const t = today();
    if (s.lastLogin !== t) {
      const continues = s.lastLogin === yesterday();
      const streak = continues ? s.streak + 1 : 1;
      s = { ...s, xp: s.xp + 10, lastLogin: t, streak, best: Math.max(s.best, streak) };
      try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
    }
    setState(s);
    setHydrated(true);
  }, []);

  const completeMission = useCallback((m: Mission) => {
    setState((prev) => {
      const t = today();
      const done = prev.days[t] ?? [];
      if (done.includes(m.id)) return prev;
      const before = tierFor(side, prev.xp).index;
      const xp = prev.xp + m.xp;
      const after = tierFor(side, xp).index;
      const next: State = { ...prev, xp, days: { ...prev.days, [t]: [...done, m.id] } };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
      setCelebrate(after > before ? { kind: "level", label: TIERS[side][after] } : { kind: "mission", label: `+${m.xp} XP` });
      return next;
    });
  }, [side]);

  const clearCelebrate = useCallback(() => setCelebrate(null), []);

  const t = today();
  const doneToday = state.days[t] ?? [];
  const tier = tierFor(side, state.xp);
  const missions = DAILY_MISSIONS[side].map((m) => ({ ...m, done: doneToday.includes(m.id) }));
  const dailyXp = missions.filter((m) => m.done).reduce((a, m) => a + m.xp, 0);
  const dailyDone = missions.filter((m) => m.done).length;

  return {
    hydrated, xp: state.xp, streak: state.streak, best: state.best,
    tier, missions, dailyXp, dailyDone, total: missions.length,
    completeMission, celebrate, clearCelebrate, quote: quoteOfDay(side),
  };
}
