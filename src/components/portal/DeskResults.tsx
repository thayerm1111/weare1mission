"use client";

/**
 * Trading Desk Results — the headline scoreboard, shown front-and-center on the
 * dashboard. Reads ONE combined source, /api/flow/stats, which now folds the GENX
 * gold results INTO the desk-wide flow record and also returns a gold/forex split:
 *   • combined totals (top level) → the big headline
 *   • gold  { wins, losses, pips, winRate } → GENX gold engine
 *   • forex { wins, stops, pips, winRate }  → FLOW forex engine
 * Every number comes straight from the recorded outcome ledgers. Win rate is over
 * decided trades; a stop is the only loss.
 */

import { useEffect, useState } from "react";
import { Trophy, TrendingUp, Target, Loader2 } from "lucide-react";

type Split = { wins: number; losses?: number; stops?: number; pips: number; winRate: number | null };
type Stats = {
  wins: number; stops: number; winRate: number | null; pips: number; pipsWon?: number;
  gold?: Split; forex?: Split & { open?: number };
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
    return (
      <div className="grid place-items-center rounded-3xl bg-gradient-to-br from-navy to-primary py-14 text-cream/70 shadow-card">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  const gold = st?.gold;
  const forex = st?.forex;
  const goldWins = gold?.wins ?? 0, goldLosses = gold?.losses ?? 0, goldPips = gold?.pips ?? 0;
  const fxWins = forex?.wins ?? 0, fxStops = forex?.stops ?? 0, fxPips = forex?.pips ?? 0;
  const totalWins = st?.wins ?? goldWins + fxWins;
  const winRate = st?.winRate ?? null;
  const totalPips = st?.pipsWon ?? goldPips + fxPips; // gross pips won by winners

  return (
    <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-navy via-navy to-primary shadow-card">
      <div className="flex items-center justify-between gap-3 px-6 pt-5">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-cream/15"><Trophy className="h-5 w-5 text-gold" /></span>
          <div className="leading-tight">
            <h2 className="font-serif text-lg font-extrabold text-cream">Trading Desk Results</h2>
            <p className="text-[11px] uppercase tracking-[0.14em] text-cream/60">FLOW + GENX · live, auto-tracked</p>
          </div>
        </div>
        <span className="hidden items-center gap-1.5 rounded-full bg-emerald-400/20 px-2.5 py-1 text-[11px] font-bold text-emerald-300 sm:inline-flex">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> LIVE
        </span>
      </div>

      {/* Headline numbers */}
      <div className="grid grid-cols-3 gap-2 px-6 py-5">
        <Big label="Win rate" value={winRate != null ? `${winRate}%` : "—"} />
        <Big label="Pips won" value={`${totalPips >= 0 ? "+" : ""}${nf(totalPips)}`} accent />
        <Big label="Winning trades" value={nf(totalWins)} />
      </div>

      {/* Per-engine breakdown */}
      <div className="grid gap-px bg-cream/10 sm:grid-cols-2">
        <EngineRow
          icon={<Target className="h-4 w-4 text-gold" />}
          name="Gold — GENX engine"
          wins={goldWins} losses={goldLosses} winRate={gold?.winRate ?? null} pips={goldPips}
        />
        <EngineRow
          icon={<TrendingUp className="h-4 w-4 text-emerald-300" />}
          name="Forex — FLOW engine"
          wins={fxWins} losses={fxStops} winRate={forex?.winRate ?? null} pips={fxPips}
          extra={forex && forex.open && forex.open > 0 ? `${forex.open} open` : undefined}
        />
      </div>

      <p className="px-6 py-3 text-center text-[10.5px] leading-relaxed text-cream/45">
        Recorded outcomes from the live engines — a stop is the only loss. Educational, not financial advice. Past results never guarantee future outcomes.
      </p>
    </section>
  );
}

function Big({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="text-center">
      <p className={`font-serif text-3xl font-black tabular-nums sm:text-4xl ${accent ? "text-gold" : "text-cream"}`}>{value}</p>
      <p className="mt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-cream/55">{label}</p>
    </div>
  );
}

function EngineRow({ icon, name, wins, losses, winRate, pips, extra }: { icon: React.ReactNode; name: string; wins: number; losses: number; winRate: number | null; pips: number; extra?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-navy/40 px-6 py-3.5">
      <span className="inline-flex items-center gap-2 text-[13px] font-bold text-cream">{icon} {name}</span>
      <span className="text-right text-[12px] tabular-nums text-cream/75">
        <b className="text-cream">{nf(wins)}W</b> / {nf(losses)}L{winRate != null ? ` · ${winRate}%` : ""}
        <span className={`ml-2 font-bold ${pips >= 0 ? "text-emerald-300" : "text-red-300"}`}>{pips >= 0 ? "+" : ""}{nf(pips)}p</span>
        {extra ? <span className="ml-2 text-cream/45">{extra}</span> : null}
      </span>
    </div>
  );
}
