"use client";

import { useEffect, useState } from "react";

/**
 * Public GENX wins wall — social proof. Shows the real ENTER-NOW alert calls that
 * hit their target, auto-graded from genx_alerts (via /api/genx/wins). No login.
 * Educational framing + honest "past results" labeling throughout.
 */
type Win = {
  mode: string | null; side: string | null;
  entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null;
  result_pips: number | null; enter_price: number | null; resolved_at: string | null;
};
type Data = { wins: Win[]; stats: { count: number; total_pips: number; best: number } };

const fmt = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "—");
const modeLabel = (m: string | null) => (m === "quick" ? "Scalp" : m === "intraday" ? "Intraday" : m === "swing" ? "Swing" : (m || ""));
const ago = (s: string | null): string => {
  if (!s) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(s).getTime()) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

function Stat({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-5 text-center">
      <p className={`font-serif text-4xl font-black tracking-tight ${tint || "text-white"}`}>{value}</p>
      <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">{label}</p>
    </div>
  );
}

export default function WinsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/genx/wins", { cache: "no-store" });
        const d = await r.json();
        setData(d as Data);
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, []);

  const wins = data?.wins ?? [];
  const stats = data?.stats;

  return (
    <main className="min-h-screen bg-[#07090f] text-white">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        {/* Hero */}
        <div className="text-center">
          <p className="flex items-center justify-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-300/80">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> GENX · Verified calls
          </p>
          <h1 className="mt-3 bg-gradient-to-r from-amber-200 via-amber-400 to-amber-200 bg-clip-text font-serif text-4xl font-black tracking-tight text-transparent sm:text-6xl">
            The GENX Wins Wall
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-white/60">
            Real Gold calls from our AI scanner that hit their target — each one an actual <span className="text-white/80">ENTER NOW</span> alert sent to our members, then auto-graded against the live market. Nothing here is cherry-picked by hand or fabricated.
          </p>
        </div>

        {/* Stats */}
        {stats && (
          <div className="mx-auto mt-10 grid max-w-3xl grid-cols-3 gap-3 sm:gap-4">
            <Stat label="Winning calls" value={String(stats.count)} tint="text-emerald-400" />
            <Stat label="Pips banked" value={`+${stats.total_pips.toLocaleString()}`} tint="text-emerald-400" />
            <Stat label="Best single call" value={`+${stats.best}`} tint="text-amber-300" />
          </div>
        )}

        {/* Wins grid */}
        <div className="mt-12">
          {loading ? (
            <p className="text-center text-white/40">Loading verified wins…</p>
          ) : wins.length === 0 ? (
            <div className="mx-auto max-w-lg rounded-2xl border border-white/10 bg-white/[0.02] px-6 py-8 text-center text-white/55">
              The first verified wins are being logged live right now. Check back shortly — every ENTER NOW call that hits its target lands here automatically.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {wins.map((w, i) => {
                const sell = w.side === "sell";
                const accent = sell ? "#ff5d6c" : "#2ee88f";
                return (
                  <div key={i} className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                    <div className="absolute right-4 top-4 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-bold text-emerald-300">
                      🏆 +{Number(w.result_pips)}p
                    </div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/40">{modeLabel(w.mode)} · Gold</p>
                    <p className="mt-1 text-2xl font-black tracking-tight" style={{ color: accent }}>{sell ? "SELL" : "BUY"} XAU/USD</p>
                    <div className="mt-3 space-y-1 text-[13px] text-white/65">
                      <p>Entry <span className="font-semibold text-white/85">{fmt(w.entry_low)}–{fmt(w.entry_high)}</span></p>
                      <p>Target hit <span className="font-semibold text-emerald-300">{fmt(w.tp1)}</span></p>
                    </div>
                    <p className="mt-3 text-[11px] text-white/35">{ago(w.resolved_at)}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* CTA */}
        <div className="mt-14 rounded-3xl border border-amber-400/20 bg-gradient-to-b from-amber-400/[0.06] to-transparent p-8 text-center">
          <h2 className="font-serif text-2xl font-bold sm:text-3xl">Get these calls the moment they fire</h2>
          <p className="mx-auto mt-2 max-w-xl text-[14px] text-white/55">GENX watches Gold around the clock and sends the exact entry, stop and targets to members — heads-up, then ENTER NOW — the instant a setup confirms.</p>
          <a href="/get-started" className="mt-5 inline-block rounded-full bg-gradient-to-r from-amber-300 to-amber-500 px-7 py-3 text-[15px] font-bold text-black transition hover:brightness-110">
            Join & get the alerts →
          </a>
        </div>

        {/* Disclaimer */}
        <p className="mx-auto mt-10 max-w-3xl text-center text-[11px] leading-relaxed text-white/30">
          Every call shown is a real, automatically-graded GENX alert — a win means price reached the first target before the stop. This is educational content, not financial advice. Trading carries risk and past performance is not indicative of future results.
        </p>
      </div>
    </main>
  );
}
