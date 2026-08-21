"use client";

/**
 * FLOW track record — how the FLOW auto-engine's trades have actually resolved,
 * read from /api/flow/stats (the flow_managed_positions outcome ledger). Mirrors
 * the GENX/community track record style but in FLOW's own terms: break-even,
 * partials banked, full target, and stop — where a STOP is the only losing
 * outcome. Total pips + a per-pair breakdown. Honest by construction: it shows
 * the sample size and stays humble on small samples.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Trophy, Target, TrendingUp, Shield, Scissors, XCircle, RefreshCw, Info } from "lucide-react";

type PerPair = {
  symbol: string; trades: number; wins: number; stops: number;
  breakeven: number; trailed: number; fullTarget: number; partialsTaken: number;
  pips: number; winRate: number | null;
};
type Recent = { symbol: string; side: string; outcome: string; win: boolean; pips: number | null; at: string };
type Stats = {
  open: number;
  trades: number; wins: number; stops: number;
  breakeven: number; trailed: number; fullTarget: number; partialsTaken: number;
  pips: number; winRate: number | null;
  perPair: PerPair[]; recent: Recent[];
};

const OUTCOME_LABEL: Record<string, string> = { target: "Full target", trail: "Trailed", breakeven: "Break-even", stop: "Stopped" };

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
const signed = (n: number | null | undefined) => (typeof n === "number" ? `${n > 0 ? "+" : ""}${n}` : "—");

export function FlowTrackRecord() {
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch("/api/flow/stats", { cache: "no-store" });
      const d = await r.json();
      if (!d || d.error) { setErr("Track record isn't available yet."); setLoading(false); return; }
      setData(d as Stats);
    } catch { setErr("Couldn't load the track record."); }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60000);
    return () => clearInterval(t);
  }, [load]);

  if (loading && !data) {
    return <div className="grid place-items-center rounded-2xl border border-ice bg-white/60 py-12 text-charcoal/40"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }
  if (err && !data) {
    return <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800"><Info className="mr-1 inline h-4 w-4" /> {err}</div>;
  }
  if (!data) return null;

  const noneYet = data.trades === 0;

  return (
    <section className="rounded-2xl border border-ice bg-white shadow-card">
      <div className="flex items-center justify-between gap-2 border-b border-ice px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-r from-navy to-primary"><Trophy className="h-4 w-4 text-cream" /></span>
          <div className="leading-tight">
            <h3 className="text-sm font-bold text-navy">FLOW track record</h3>
            <p className="text-[11px] text-charcoal/55">How the auto-engine&apos;s trades resolved · a stop is the only loss</p>
          </div>
        </div>
        <button onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full border border-ice bg-offwhite/60 px-2.5 py-1.5 text-[11px] font-semibold text-charcoal/70 hover:bg-ice disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {noneYet ? (
        <div className="p-5">
          <div className="rounded-xl border border-ice bg-offwhite/60 p-4">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-navy"><Info className="h-4 w-4 text-primary" /> Building your track record</p>
            <p className="mt-1 text-[13px] leading-relaxed text-charcoal/65">
              No trades have fully closed yet. Every FLOW trade is recorded the moment it resolves — break-even, partial, full target, or stop — and this fills in automatically. {data.open > 0 ? `${data.open} trade${data.open === 1 ? "" : "s"} currently open.` : ""}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-5 p-5">
          {/* Headline */}
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-charcoal/45">Win rate</p>
              <p className="font-serif text-4xl font-extrabold text-navy">{data.winRate != null ? `${data.winRate}%` : "—"}</p>
              <p className="mt-0.5 text-[12px] text-charcoal/55">{data.wins}W / {data.stops}L · {data.trades} closed{data.open > 0 ? ` · ${data.open} open` : ""}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-charcoal/45">Total pips</p>
              <p className={`font-serif text-3xl font-bold ${data.pips >= 0 ? "text-emerald-600" : "text-red-500"}`}>{signed(data.pips)}</p>
              <p className="mt-0.5 text-[12px] text-charcoal/55">net, per signal</p>
            </div>
          </div>

          {/* Outcome breakdown */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <OutcomeTile icon={<Target className="h-4 w-4" />} label="Full target" value={data.fullTarget} tone="emerald" />
            <OutcomeTile icon={<TrendingUp className="h-4 w-4" />} label="Trailed win" value={data.trailed} tone="emerald" />
            <OutcomeTile icon={<Shield className="h-4 w-4" />} label="Break-even" value={data.breakeven} tone="sky" />
            <OutcomeTile icon={<XCircle className="h-4 w-4" />} label="Stopped" value={data.stops} tone="red" />
          </div>
          <p className="flex items-center gap-1.5 text-[12px] text-charcoal/55">
            <Scissors className="h-3.5 w-3.5 text-primary" /> Partials banked on <b className="text-navy">{data.partialsTaken}</b> of {data.trades} trades (every trade that reached +1R).
          </p>

          {/* Per pair */}
          {data.perPair.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-charcoal/45">By pair</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[460px] border-collapse text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-charcoal/40">
                      <th className="py-1.5 pr-2 font-semibold">Pair</th>
                      <th className="py-1.5 px-2 text-right font-semibold">Win %</th>
                      <th className="py-1.5 px-2 text-right font-semibold">Pips</th>
                      <th className="py-1.5 px-2 text-right font-semibold">Full</th>
                      <th className="py-1.5 px-2 text-right font-semibold">Trail</th>
                      <th className="py-1.5 px-2 text-right font-semibold">BE</th>
                      <th className="py-1.5 pl-2 text-right font-semibold">Stop</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#EFE9DC]">
                    {data.perPair.map((p) => (
                      <tr key={p.symbol}>
                        <td className="py-2 pr-2 font-bold text-navy">{p.symbol}</td>
                        <td className="py-2 px-2 text-right tabular-nums font-semibold text-navy">{p.winRate != null ? `${p.winRate}%` : "—"}</td>
                        <td className={`py-2 px-2 text-right tabular-nums font-semibold ${p.pips >= 0 ? "text-emerald-600" : "text-red-500"}`}>{signed(p.pips)}</td>
                        <td className="py-2 px-2 text-right tabular-nums text-charcoal/70">{p.fullTarget}</td>
                        <td className="py-2 px-2 text-right tabular-nums text-charcoal/70">{p.trailed}</td>
                        <td className="py-2 px-2 text-right tabular-nums text-charcoal/70">{p.breakeven}</td>
                        <td className="py-2 pl-2 text-right tabular-nums text-red-500/80">{p.stops}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Recent */}
          {data.recent.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-charcoal/45">Recent closes</p>
              <div className="divide-y divide-[#EFE9DC] rounded-xl border border-ice bg-offwhite/40">
                {data.recent.map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 px-3.5 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="text-[13px] font-semibold text-navy">{r.symbol}</span>
                      <span className="text-[11px] uppercase text-charcoal/45">{r.side}</span>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2.5">
                      {r.pips != null && <span className={`text-[12px] tabular-nums font-medium ${r.pips >= 0 ? "text-emerald-600" : "text-red-500"}`}>{signed(r.pips)}p</span>}
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${r.win ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</span>
                      <span className="text-[11px] text-charcoal/40">{ago(r.at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-charcoal/45">
            One entry per signal (largest account shown). Outcomes are read from FLOW&apos;s own managed exits; a stop is the only loss. Small samples are directional, not a guarantee — past results never promise future ones.
          </p>
        </div>
      )}
    </section>
  );
}

function OutcomeTile({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: "emerald" | "sky" | "red" }) {
  const ic = tone === "emerald" ? "bg-emerald-100 text-emerald-700" : tone === "sky" ? "bg-sky-100 text-sky-700" : "bg-red-100 text-red-700";
  return (
    <div className="rounded-xl border border-ice bg-offwhite/60 p-3">
      <span className={`grid h-6 w-6 place-items-center rounded-full ${ic}`}>{icon}</span>
      <p className="mt-2 font-serif text-2xl font-extrabold tabular-nums text-navy">{value}</p>
      <p className="text-[11px] text-charcoal/55">{label}</p>
    </div>
  );
}
