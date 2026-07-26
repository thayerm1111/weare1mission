"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Trophy, Crown, ArrowRight } from "lucide-react";

type Row = { rank: number; user_id: string; name: string; xp: number; streak: number };

/**
 * Global leaderboard (top members by XP). Reads /api/leaderboard, which is
 * powered by the live Supabase `get_leaderboard` function. Until the DB is set
 * up it shows a premium anticipatory state rather than an empty box.
 */
export function Leaderboard() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/leaderboard", { cache: "no-store" });
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
  }, []);

  return (
    <div className="rounded-2xl border border-[#E7E4DD] bg-white p-6 shadow-card sm:p-7">
      <div className="flex items-center justify-between">
        <span className="eyebrow inline-flex items-center gap-2"><Trophy className="h-4 w-4 text-gold-light" /> Leaderboard</span>
        <span className="text-[11px] uppercase tracking-[0.12em] text-medium">Top by XP</span>
      </div>

      {rows === null ? (
        <ul className="mt-4 space-y-2">
          {[0, 1, 2, 3, 4].map((i) => <li key={i} className="h-10 animate-pulse rounded-xl bg-offwhite/70" />)}
        </ul>
      ) : !enabled || rows.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-[#E7E4DD] bg-offwhite/40 px-4 py-8 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-gold-light/15 text-gold-light">
            <Crown className="h-5 w-5" />
          </span>
          <p className="mt-3 text-sm font-semibold text-navy">
            {enabled ? "No one's on the board yet" : "The community board is warming up"}
          </p>
          <p className="mt-1 text-xs text-charcoal/55">
            {enabled ? "Complete a mission to claim the #1 spot." : "Keep earning XP — rankings go live shortly."}
          </p>
        </div>
      ) : (
        <ol className="mt-4 space-y-1.5">
          {rows.slice(0, 5).map((r) => {
            const mine = r.user_id === me;
            return (
              <li
                key={r.user_id}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                  mine ? "bg-gold-light/10 ring-1 ring-gold-light/30" : "hover:bg-offwhite/60"
                }`}
              >
                <RankBadge n={r.rank} />
                <span className="flex-1 truncate text-sm font-medium text-navy">
                  {r.name}
                  {mine && <span className="ml-2 rounded-full bg-navy px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">You</span>}
                </span>
                <span className="tabular-nums text-sm font-bold text-navy">
                  {r.xp.toLocaleString()}<span className="ml-1 text-[11px] font-medium text-charcoal/40">XP</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <Link
        href="/portal/leaderboard"
        className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-primary hover:text-medium"
      >
        View full leaderboard <ArrowRight className="h-3.5 w-3.5" />
      </Link>
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
    <span className={`grid h-7 w-7 flex-shrink-0 place-items-center rounded-full text-[12px] font-bold tabular-nums ${medal}`}>
      {n}
    </span>
  );
}
