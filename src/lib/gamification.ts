"use client";

/**
 * Gamification engine (v2 — cross-device via Supabase, with localStorage fallback).
 *
 * On mount the hook calls /api/game. If Supabase is configured, the user is
 * signed in, and the game_state table exists, it uses the SERVER as the source
 * of truth (shared + leaderboard-ready). Otherwise it transparently falls back
 * to the original per-device localStorage behavior — so nothing breaks before
 * the DB is set up. The public hook API is unchanged.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { TIERS, DAILY_MISSIONS, tierFor, quoteOfDay, type Side, type Mission } from "./gameData";

export type { Side, Mission } from "./gameData";
export { TIERS, TIER_XP, tierFor, quoteOfDay } from "./gameData";

type View = { xp: number; streak: number; best: number; done: string[] };
type LocalState = { xp: number; lastLogin: string; streak: number; best: number; days: Record<string, string[]> };
const EMPTY_LOCAL: LocalState = { xp: 0, lastLogin: "", streak: 0, best: 0, days: {} };
const KEY = "om_game_v1";

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function today() { return ymd(new Date()); }
function yesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return ymd(d); }

export type Celebrate = { kind: "level" | "mission"; label: string } | null;

export function useGame(side: Side) {
  const [view, setView] = useState<View>({ xp: 0, streak: 0, best: 0, done: [] });
  const [hydrated, setHydrated] = useState(false);
  const [celebrate, setCelebrate] = useState<Celebrate>(null);
  const modeRef = useRef<"server" | "local">("local");
  const localRef = useRef<LocalState>(EMPTY_LOCAL);

  const loadLocal = useCallback((): View => {
    let s = EMPTY_LOCAL;
    try { const raw = localStorage.getItem(KEY); if (raw) s = { ...EMPTY_LOCAL, ...(JSON.parse(raw) as Partial<LocalState>) }; } catch { /* ignore */ }
    const t = today();
    if (s.lastLogin !== t) {
      const cont = s.lastLogin === yesterday();
      const streak = cont ? s.streak + 1 : 1;
      s = { ...s, xp: s.xp + 10, lastLogin: t, streak, best: Math.max(s.best, streak) };
      try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
    }
    localRef.current = s;
    return { xp: s.xp, streak: s.streak, best: s.best, done: s.days[t] ?? [] };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/game", { cache: "no-store" });
        const j = await res.json();
        if (!alive) return;
        if (j?.enabled && j.state) {
          modeRef.current = "server";
          setView({ xp: j.state.xp, streak: j.state.streak, best: j.state.best, done: Array.isArray(j.state.done) ? j.state.done : [] });
          setHydrated(true);
          return;
        }
      } catch { /* fall through to local */ }
      if (!alive) return;
      modeRef.current = "local";
      setView(loadLocal());
      setHydrated(true);
    })();
    return () => { alive = false; };
  }, [loadLocal]);

  const completeMission = useCallback((m: Mission) => {
    setView((prev) => {
      if (prev.done.includes(m.id)) return prev;
      const before = tierFor(side, prev.xp).index;
      const after = tierFor(side, prev.xp + m.xp).index;
      setCelebrate(after > before ? { kind: "level", label: TIERS[side][after] } : { kind: "mission", label: `+${m.xp} XP` });
      const next: View = { ...prev, xp: prev.xp + m.xp, done: [...prev.done, m.id] };

      if (modeRef.current === "server") {
        fetch("/api/game", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ missionId: m.id }) })
          .then((r) => r.json())
          .then((j) => {
            if (j?.enabled && j.state) {
              setView({ xp: j.state.xp, streak: j.state.streak, best: j.state.best, done: Array.isArray(j.state.done) ? j.state.done : [] });
            }
          })
          .catch(() => { /* keep optimistic */ });
      } else {
        const t = today();
        const s = localRef.current;
        const done = s.days[t] ?? [];
        if (!done.includes(m.id)) {
          const ns: LocalState = { ...s, xp: s.xp + m.xp, days: { ...s.days, [t]: [...done, m.id] } };
          localRef.current = ns;
          try { localStorage.setItem(KEY, JSON.stringify(ns)); } catch { /* ignore */ }
        }
      }
      return next;
    });
  }, [side]);

  const clearCelebrate = useCallback(() => setCelebrate(null), []);

  const tier = tierFor(side, view.xp);
  const missions = DAILY_MISSIONS[side].map((m) => ({ ...m, done: view.done.includes(m.id) }));
  const dailyXp = missions.filter((m) => m.done).reduce((a, m) => a + m.xp, 0);
  const dailyDone = missions.filter((m) => m.done).length;

  return {
    hydrated, xp: view.xp, streak: view.streak, best: view.best,
    tier, missions, dailyXp, dailyDone, total: missions.length,
    completeMission, celebrate, clearCelebrate, quote: quoteOfDay(side),
  };
}
