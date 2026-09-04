"use client";

/**
 * Trading Desk Results — the unified auto-desk scoreboard (FLOW forex + GENX gold
 * folded into one record via /api/flow/stats; no double-count). Restyled 09-04 to
 * the premium dark-tech system of the Desk Dashboard: deep black, thin borders,
 * monospaced micro-labels, ice illumination — no washed gradients.
 * `pipsWon` is GROSS pips banked by winners; a stop is the only loss.
 */

import { useEffect, useState } from "react";

type Recent = { symbol: string; win: boolean; pips: number | null };
type Stats = {
  wins: number; stops: number; trades: number; winRate: number | null; pips: number; pipsWon?: number;
  gold?: { wins: number }; recent?: Recent[];
};

const nf = (n: number) => Math.round(n).toLocaleString();
const MICRO = "font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[#5E708E]";

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
      <div className="grid place-items-center rounded-2xl border border-white/[0.08] bg-[#0B0E14] py-16 font-mono text-[11px] uppercase tracking-[0.2em] text-[#5E708E]">
        Loading desk results…
      </div>
    );
  }

  const pipsWon = st?.pipsWon ?? st?.pips ?? 0;
  const winRate = st?.winRate ?? null;
  const wins = st?.wins ?? 0;
  const trades = st?.trades ?? 0;
  const goldWins = st?.gold?.wins ?? 0;
  const recent = (st?.recent ?? []).filter((r) => r.win && r.pips != null && (r.pips as number) > 0).slice(0, 6);

  return (
    <section className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0B0E14]">
      {/* cool-blue illumination, kept subtle */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(640px 260px at 50% -30%, rgba(93,158,224,0.14), transparent 62%), radial-gradient(420px 220px at 96% 110%, rgba(93,158,224,0.06), transparent 60%)" }}
      />

      {/* header */}
      <div className="relative flex flex-wrap items-center justify-between gap-3 px-7 pt-6">
        <div className="leading-tight">
          <p className={MICRO}>Live desk record · Auto-traded · Forex + GENX gold</p>
          <h2 className="mt-1.5 text-[19px] font-bold tracking-tight text-[#EDF2FA]">Trading Desk Results</h2>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Live
        </span>
      </div>

      {/* hero number */}
      <div className="relative py-7 text-center">
        <div className="text-[56px] font-bold leading-none tracking-tight text-[#F2F6FC] [text-shadow:0_0_44px_rgba(93,158,224,0.35)] sm:text-[68px]">
          <span className="text-emerald-300">+</span>{nf(pipsWon)}
        </div>
        <p className={`mt-3 ${MICRO}`}>Pips won</p>
      </div>

      {/* stat trio */}
      <div className="relative grid grid-cols-3 gap-3 px-7">
        <Stat value={winRate != null ? `${winRate}%` : "—"} label="Win rate" accent />
        <Stat value={nf(wins)} label="Winning trades" />
        <Stat value={nf(trades)} label="Total trades" />
      </div>

      {/* recent wins */}
      {recent.length > 0 && (
        <div className="relative flex items-center gap-2 overflow-x-auto px-7 pt-4">
          <span className="flex-shrink-0 font-mono text-[9.5px] font-bold uppercase tracking-[0.18em] text-[#5E708E]">Recent</span>
          {recent.map((r, i) => (
            <span key={i} className="flex-shrink-0 whitespace-nowrap rounded-md border border-emerald-400/20 bg-emerald-400/[0.05] px-2.5 py-1 font-mono text-[11px] font-semibold tracking-[0.04em] text-emerald-300">
              {r.symbol} +{nf(r.pips as number)}p
            </span>
          ))}
        </div>
      )}

      <p className="relative px-7 pb-5 pt-4 text-center text-[10.5px] leading-relaxed text-[#5E708E]">
        Includes <b className="font-semibold text-[#8FA0BC]">{nf(goldWins)}</b> GENX gold wins · every trade auto-tracked from the live ledger. A stop is the only loss. Educational, not financial advice — past results never guarantee future outcomes.
      </p>
    </section>
  );
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] py-3.5 text-center">
      <p className={`text-[22px] font-bold tabular-nums tracking-tight ${accent ? "text-emerald-300" : "text-[#EDF2FA]"}`}>{value}</p>
      <p className="mt-1 font-mono text-[8.5px] font-bold uppercase tracking-[0.16em] text-[#5E708E]">{label}</p>
    </div>
  );
}
