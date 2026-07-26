"use client";

/**
 * Achievements — milestone badges derived from the member's real activity
 * (XP/streak from the game state, plays generated, trades journaled, onboarding
 * progress). No backend: everything is read from what we already store on the
 * device, so badges light up as members use the platform.
 */
import { useEffect, useMemo, useState } from "react";
import { Medal, Lock } from "lucide-react";
import { BADGES, type StatKey } from "@/data/achievements";
import { useGame } from "@/lib/gamification";

function countArray(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return 0;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.length : 0;
  } catch { return 0; }
}

export function Achievements() {
  const g = useGame("ones");
  const [local, setLocal] = useState({ plays: 0, trades: 0, onboard: 0 });

  useEffect(() => {
    setLocal({
      plays: countArray("om_signals"),
      trades: countArray("1m_trade_journal_v1"),
      onboard: countArray("1m_customer_onboarding_v1"),
    });
  }, []);

  const stats: Record<StatKey, number> = useMemo(() => ({
    onboard: local.onboard,
    plays: local.plays,
    trades: local.trades,
    streak: Math.max(g.streak || 0, g.best || 0), // peak streak — badges don't un-earn
    xp: g.xp || 0,
  }), [local, g.streak, g.best, g.xp]);

  const badges = BADGES.map((b) => {
    const cur = stats[b.metric];
    return { ...b, earned: cur >= b.goal, cur: Math.min(cur, b.goal) };
  });
  const earnedCount = badges.filter((b) => b.earned).length;

  return (
    <div className="rounded-2xl border border-[#E7E4DD] bg-white p-5 shadow-card sm:p-6">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-bold text-navy">
          <Medal className="h-5 w-5 text-primary" aria-hidden="true" /> Achievements
        </h2>
        <span className="text-sm font-semibold text-charcoal/60">{g.hydrated ? `${earnedCount} / ${badges.length}` : "…"}</span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {badges.map((b) => {
          const Icon = b.icon;
          return (
            <div key={b.id} title={`${b.label} — ${b.desc}`}
              className={`flex flex-col items-center rounded-xl border p-3 text-center transition-colors ${
                b.earned ? "border-primary/25 bg-offwhite/60" : "border-ice bg-white"
              }`}>
              <span className={`relative grid h-11 w-11 place-items-center rounded-full ${
                b.earned ? "bg-primary text-cream" : "bg-ice text-charcoal/30"
              }`}>
                <Icon className="h-5 w-5" aria-hidden="true" />
                {!b.earned && <Lock className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-white p-0.5 text-charcoal/40" />}
              </span>
              <span className={`mt-2 text-[11px] font-bold leading-tight ${b.earned ? "text-navy" : "text-charcoal/45"}`}>{b.label}</span>
              {b.earned ? (
                <span className="mt-0.5 text-[10px] font-semibold text-emerald-600">Unlocked</span>
              ) : (
                <span className="mt-0.5 text-[10px] text-charcoal/40">{b.cur}/{b.goal}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
