"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, TrendingDown, ShieldAlert, RefreshCw, Loader2 } from "lucide-react";

/**
 * Continuous-learning desk (admin). Shows the audit loop working: overall
 * expectancy, WHY trades fail, per-bucket expectancy, and the bounded penalties
 * the gate is currently applying. All numbers come from the graded ledger.
 */
type Bucket = { dimension: string; bucket: string; n: number; wins: number; losses: number; expectancy_r: number; penalty: number; top_reason: string | null };
type Active = { dimension: string; bucket: string; n: number; expectancy_r: number; penalty: number; top_reason: string | null };
type Data = {
  ok: boolean;
  overview: { graded: number; wins: number; losses: number; win_rate: number; expectancy_r: number; profit_factor: number | null; loss_autopsied_pct: number };
  by_reason: { reason: string; label: string; count: number }[];
  by_instrument: Bucket[]; by_session: Bucket[]; by_mode: Bucket[]; by_setup: Bucket[];
  active_adjustments: Active[];
  error?: string;
};

const rColor = (r: number) => (r > 0.05 ? "text-emerald-400" : r < -0.05 ? "text-red-400" : "text-white/60");
const fmtR = (r: number) => `${r > 0 ? "+" : ""}${r.toFixed(2)}R`;

export function LearningDesk() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  async function load() {
    setLoading(true); setErr("");
    try {
      const res = await fetch("/api/admin/learning", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok || !d.ok) { setErr(d.error || "Couldn't load learning data."); setData(null); }
      else setData(d);
    } catch { setErr("Couldn't reach the server."); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const maxReason = data ? Math.max(1, ...data.by_reason.map((r) => r.count)) : 1;

  return (
    <div className="rounded-2xl border border-white/10 bg-[#0b0d14] p-5 text-white sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-sky-300/80">
            <Activity className="h-3.5 w-3.5" /> Continuous learning
          </p>
          <h2 className="mt-1 font-serif text-2xl font-bold">Why trades fail — and how the gate adapts</h2>
          <p className="mt-1 text-sm text-white/50">Every stopped-out trade is auto-diagnosed. Buckets with proven-negative expectancy tighten the gate automatically — bounded, and penalty-only.</p>
        </div>
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/70 hover:border-white/30 disabled:opacity-40">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
        </button>
      </div>

      {err && <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.07] px-4 py-3 text-sm text-red-300">{err}</div>}
      {loading && !data && <div className="mt-6 flex items-center gap-2 text-white/50"><Loader2 className="h-4 w-4 animate-spin" /> Loading the ledger…</div>}

      {data && (
        <>
          {/* Overview tiles */}
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Graded trades" value={String(data.overview.graded)} />
            <Tile label="Win rate" value={`${data.overview.win_rate}%`} sub={`${data.overview.wins}W · ${data.overview.losses}L`} />
            <Tile label="Expectancy" value={fmtR(data.overview.expectancy_r)} tint={rColor(data.overview.expectancy_r)} />
            <Tile label="Profit factor" value={data.overview.profit_factor == null ? "—" : data.overview.profit_factor.toFixed(2)} />
          </div>

          {data.overview.graded === 0 && (
            <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/60">
              No graded trades yet. As the resolver grades stopped-out trades, their autopsy and the adjustments will appear here.
            </p>
          )}

          {/* Why trades fail */}
          {data.by_reason.length > 0 && (
            <section className="mt-6">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45"><AlertTriangle className="h-3.5 w-3.5" /> Why trades fail</h3>
              <div className="mt-3 space-y-2">
                {data.by_reason.map((r) => (
                  <div key={r.reason} className="flex items-center gap-3">
                    <span className="w-40 flex-shrink-0 text-[13px] text-white/75">{r.label}</span>
                    <div className="h-5 flex-1 overflow-hidden rounded bg-white/[0.05]">
                      <div className="h-full rounded bg-gradient-to-r from-sky-500/70 to-sky-400/70" style={{ width: `${Math.round((r.count / maxReason) * 100)}%` }} />
                    </div>
                    <span className="w-8 flex-shrink-0 text-right text-[13px] font-semibold text-white/70">{r.count}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Active adjustments */}
          <section className="mt-6">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300/80"><ShieldAlert className="h-3.5 w-3.5" /> Adjustments the gate is applying now</h3>
            {data.active_adjustments.length === 0 ? (
              <p className="mt-2 text-sm text-white/50">None active — no bucket has enough graded trades AND clearly negative expectancy yet. The gate is running on its base thresholds.</p>
            ) : (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {data.active_adjustments.map((a, i) => (
                  <div key={i} className="flex items-center justify-between rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3.5 py-2.5">
                    <div>
                      <p className="text-sm font-semibold text-white">{a.bucket} <span className="text-white/40">· {a.dimension}</span></p>
                      <p className="text-[11px] text-white/50">{a.n} trades · {fmtR(a.expectancy_r)} avg{a.top_reason ? ` · mostly ${a.top_reason.replace(/_/g, " ")}` : ""}</p>
                    </div>
                    <span className="rounded-full bg-amber-400/20 px-2.5 py-1 text-sm font-bold text-amber-300">−{a.penalty}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Per-bucket expectancy tables */}
          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            <BucketTable title="By instrument" rows={data.by_instrument} />
            <BucketTable title="By setup" rows={data.by_setup} />
            <BucketTable title="By mode" rows={data.by_mode} />
            <BucketTable title="By session" rows={data.by_session} />
          </div>

          <p className="mt-5 border-t border-white/10 pt-4 text-[11px] leading-relaxed text-white/35">
            Guardrails: a bucket needs ≥20 graded trades before it can adjust anything; each penalty is capped and only ever tightens the bar; penalties recompute every resolver run, so they decay back to zero as a bucket&apos;s expectancy recovers. Educational analysis — not financial advice.
          </p>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, tint }: { label: string; value: string; sub?: string; tint?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-white/40">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tint || "text-white"}`}>{value}</p>
      {sub && <p className="text-[11px] text-white/45">{sub}</p>}
    </div>
  );
}

function BucketTable({ title, rows }: { title: string; rows: Bucket[] }) {
  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45"><TrendingDown className="h-3.5 w-3.5" /> {title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-white/40">Not enough data yet.</p>
      ) : (
        <div className="mt-2 overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-white/[0.04] text-[10px] uppercase tracking-wide text-white/40">
              <tr><th className="px-3 py-2 font-semibold">Bucket</th><th className="px-2 py-2 font-semibold">n</th><th className="px-2 py-2 font-semibold">W/L</th><th className="px-2 py-2 font-semibold">Exp</th><th className="px-3 py-2 text-right font-semibold">Adj</th></tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((r, i) => (
                <tr key={i} className="border-t border-white/[0.06]">
                  <td className="px-3 py-2 font-medium text-white/85">{r.bucket}</td>
                  <td className="px-2 py-2 text-white/55">{r.n}</td>
                  <td className="px-2 py-2 text-white/55">{r.wins}/{r.losses}</td>
                  <td className={`px-2 py-2 font-semibold ${rColor(r.expectancy_r)}`}>{fmtR(r.expectancy_r)}</td>
                  <td className="px-3 py-2 text-right">{r.penalty > 0 ? <span className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[11px] font-bold text-amber-300">−{r.penalty}</span> : <span className="text-white/25">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
