"use client";

import { useEffect, useState } from "react";
import { Crown, Flame } from "lucide-react";

type Row = { rank: number; user_id: string; name: string; xp: number; streak: number };
type Period = "week" | "month" | "all";

const PERIODS: { k: Period; label: string }[] = [
  { k: "week", label: "This Week" },
  { k: "month", label: "This Month" },
  { k: "all", label: "All Time" },
];

export function LeaderboardFull() {
  const [period, setPeriod] = useState<Period>("all");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    (async () => {
      try {
        const r = await fetch(`/api/leaderboard?period=${period}&limit=100`, { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        setEnabled(!!j.enabled);
        setMe(j.me ?? null);
        setRows(Array.isArray(j.rows) ? j.rows : []);
      } catch {
        if (alive) { setEnabled(false); setRows([]); }
      }
    })();
    return () => { alive = false; };
  }, [period]);

  const mine = rows?.find((r) => r.user_id === me) ?? null;

  return (
    <div className="space-y-5">
      {/* Period tabs */}
      <div className="inline-flex rounded-full border border-[#E7E4DD] bg-white p-1 shadow-card">
        {PERIODS.map((p) => (
          <button
            key={p.k}
            onClick={() => setPeriod(p.k)}
            aria-pressed={period === p.k}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              period === p.k ? "bg-primary text-white" : "text-charcoal/65 hover:text-navy"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Your standing */}
      {mine && (
        <div className="flex items-center gap-3 rounded-2xl border border-gold-light/30 bg-gold-light/[0.07] px-5 py-4">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-navy text-sm font-bold text-gold-light">#{mine.rank}</span>
          <div className="flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-charcoal/50">Your rank</p>
            <p className="font-serif text-lg font-bold text-navy">{mine.name}</p>
          </div>
          <span className="tabular-nums text-lg font-bold text-navy">{mine.xp.toLocaleString()}<span className="ml-1 text-xs font-medium text-charcoal/40">XP</span></span>
        </div>
      )}

      {/* Board */}
      <div className="overflow-hidden rounded-2xl border border-[#E7E4DD] bg-white shadow-card">
        {rows === null ? (
          <ul className="divide-y divide-[#EEEDE8]">
            {Array.from({ length: 8 }).map((_, i) => <li key={i} className="h-14 animate-pulse bg-offwhite/50" />)}
          </ul>
        ) : !enabled || rows.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-gold-light/15 text-gold-light">
              <Crown className="h-6 w-6" />
            </span>
            <p className="mt-4 font-serif text-lg font-bold text-navy">
              {enabled ? "No one's on the board yet" : "The leaderboard is warming up"}
            </p>
            <p className="mt-1 text-sm text-charcoal/55">
              {enabled ? "Be the first — earn XP by showing up and completing your daily missions." : "Keep earning XP — rankings go live shortly."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-[#EEEDE8]">
            {rows.map((r) => {
              const isMe = r.user_id === me;
              return (
                <li
                  key={r.user_id}
                  className={`flex items-center gap-4 px-5 py-3.5 ${isMe ? "bg-gold-light/[0.08]" : "hover:bg-offwhite/50"}`}
                >
                  <RankBadge n={r.rank} />
                  <span className="flex-1 truncate text-[15px] font-semibold text-navy">
                    {r.name}
                    {isMe && <span className="ml-2 rounded-full bg-navy px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">You</span>}
                  </span>
                  {r.streak > 1 && (
                    <span className="hidden items-center gap-1 text-xs font-semibold text-[#E8890C] sm:inline-flex">
                      <Flame className="h-3.5 w-3.5" /> {r.streak}
                    </span>
                  )}
                  <span className="tabular-nums text-[15px] font-bold text-navy">
                    {r.xp.toLocaleString()}<span className="ml-1 text-[11px] font-medium text-charcoal/40">XP</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-center text-xs text-charcoal/45">
        Earn XP by showing up daily, keeping your streak, completing missions, and using OM AI &amp; OM AI Plays.
      </p>
    </div>
  );
}

function RankBadge({ n }: { n: number }) {
  const medal =
    n === 1 ? "bg-gradient-to-br from-gold-light to-[#c6a667] text-navy"
    : n === 2 ? "bg-gradient-to-br from-[#d9d9d9] to-[#b8b8b8] text-navy"
    : n === 3 ? "bg-gradient-to-br from-[#e0b088] to-[#c58a5a] text-white"
    : "bg-ice text-navy";
  return (
    <span className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-full text-sm font-bold tabular-nums ${medal}`}>
      {n}
    </span>
  );
}
