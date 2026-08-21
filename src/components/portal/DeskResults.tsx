"use client";

/**
 * Trading Desk Results — the ONE unified, front-and-center scoreboard for the whole
 * auto-desk: FLOW forex + GENX gold folded into a single record. Reads /api/flow/stats
 * (which already merges gold in — no double-count) and is built to showcase.
 * `pipsWon` is GROSS pips banked by winners; a stop is the only loss.
 */

import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";

type Recent = { symbol: string; win: boolean; pips: number | null };
type Stats = {
  wins: number; stops: number; trades: number; winRate: number | null; pips: number; pipsWon?: number;
  gold?: { wins: number }; recent?: Recent[];
};

const nf = (n: number) => Math.round(n).toLocaleString();

export function DeskResults() {
  const [st, setSt] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const f = await fetch("/api/flow/stats", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
        if (!alive) return;
        if (f && !f.error) setSt(f as Stats);
      } finally { if (alive) setLoading(false); }
    }
    void load();
    const t = setInterval(() => void load(), 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (loading && !st) {
    return <div className="grid place-items-center rounded-[26px] bg-gradient-to-br from-navy to-primary py-16 text-cream/60 shadow-card">Loading desk results…</div>;
  }

  const pipsWon = st?.pipsWon ?? st?.pips ?? 0;
  const winRate = st?.winRate ?? null;
  const wins = st?.wins ?? 0;
  const trades = st?.trades ?? 0;
  const goldWins = st?.gold?.wins ?? 0;
  const recent = (st?.recent ?? []).filter((r) => r.win && r.pips != null).slice(0, 8);

  return (
    <section className="relative overflow-hidden rounded-[26px] border border-gold/25 bg-gradient-to-br from-navy via-[#131033] to-[#241436] shadow-[0_18px_50px_rgba(0,0,0,0.5)]">
      {/* glow */}
      <div className="pointer-events-none absolute -top-16 left-1/2 h-56 w-[420px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(255,193,75,0.22),transparent_70%)]" />

      <div className="relative flex items-center justify-between px-7 pt-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-cream/10"><Trophy className="h-5 w-5 text-gold" /></span>
          <div className="leading-tight">
            <h2 className="font-serif text-xl font-black text-cream">Trading Desk Results</h2>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-cream/50">Auto-traded · forex + GENX gold</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/20 px-3 py-1 text-[11px] font-bold text-emerald-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" /> LIVE
        </span>
      </div>

      {/* hero */}
      <div className="relative py-4 text-center">
        <div className="font-serif text-6xl font-black leading-none tracking-tight text-gold drop-shadow-[0_3px_26px_rgba(255,180,60,0.4)] sm:text-7xl">+{nf(pipsWon)}</div>
        <div className="mt-2 text-xs font-bold uppercase tracking-[0.18em] text-cream/60">Pips won</div>
      </div>

      {/* stat trio */}
      <div className="relative grid grid-cols-3 gap-3 px-7 pb-2 pt-3">
        <Stat value={winRate != null ? `${winRate}%` : "—"} label="Win rate" accent />
        <Stat value={nf(wins)} label="Winning trades" />
        <Stat value={nf(trades)} label="Total trades" />
      </div>

      {/* recent wins */}
      {recent.length > 0 && (
        <div className="relative flex items-center gap-2 overflow-x-auto px-7 pb-1 pt-3">
          <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-[0.1em] text-cream/40">Recent</span>
          {recent.map((r, i) => (
            <span key={i} className="flex-shrink-0 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-[12px] font-bold text-emerald-300 whitespace-nowrap">
              {r.symbol} +{nf(r.pips as number)}p
            </span>
          ))}
        </div>
      )}

      <p className="relative px-7 pb-5 pt-3 text-center text-[10.5px] leading-relaxed text-cream/45">
        Includes <b className="text-cream/70">{nf(goldWins)}</b> GENX gold wins · every trade auto-tracked from the live ledger. A stop is the only loss. Educational, not financial advice — past results never guarantee future outcomes.
      </p>
    </section>
  );
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-cream/10 bg-cream/[0.045] py-3 text-center">
      <p className={`font-serif text-2xl font-black tabular-nums ${accent ? "text-emerald-300" : "text-cream"}`}>{value}</p>
      <p className="mt-1 text-[9px] font-bold uppercase tracking-[0.06em] text-cream/50">{label}</p>
    </div>
  );
}
