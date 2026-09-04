"use client";

/**
 * Community Results — a member-facing, platform-wide view of how the OM AI tools
 * are performing. Reads the anonymized `community_signal_stats` RPC (aggregates
 * only, no per-member data). Built to be HONEST: every rate is shown with its
 * sample size and a Wilson 95% confidence interval, headline outcomes stay in a
 * "building" state until enough trades have resolved, and nothing here is a
 * prediction or a promise. Educational decision-support, not financial advice.
 */

import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw, TrendingUp, Activity, Users, Gauge, Trophy, Info, ArrowUp, ArrowDown,
  Radar, Ghost, Crosshair, Zap, Target, AlertCircle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Recent = { engine: string; instrument: string; direction: string; status: string; hit_tp: number | null; realized_r: number | null; at: string };
type EngineRow = { engine: string; generated: number; resolved: number; wins: number; losses: number };
type Stats = {
  generated_at: string;
  members_using: number;
  live: {
    generated: number; generated_7d: number; open: number; resolved: number; wins: number; losses: number; expired: number;
    avg_planned_rr: number | null; avg_realized_r: number | null;
    by_engine: EngineRow[];
    top_instruments: { instrument: string; n: number }[];
    direction: { long: number; short: number };
    confidence: { High: number; Medium: number; Low: number };
    recent: Recent[];
  };
  launch: { resolved: number; wins: number; losses: number };
};

const ENGINE_LABEL: Record<string, string> = { scanner: "Strategy Scanner", command: "Market Command", plays: "OM AI Plays", ghost: "MFXGHOST" };
const ENGINE_ICON: Record<string, typeof Radar> = { scanner: Radar, command: Crosshair, plays: Zap, ghost: Ghost };

const MIN_CONFIDENT = 20; // below this many resolved, we don't headline a win rate

function wilson(wins: number, n: number, z = 1.96): { p: number; low: number; high: number } | null {
  if (n <= 0) return null;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, low: Math.max(0, c - h), high: Math.min(1, c + h) };
}
const pct = (x: number) => `${Math.round(x * 100)}%`;
const nf = (n: number | null | undefined) => (n ?? 0).toLocaleString();

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

export default function CommunityResults() {
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) { setErr("Live stats aren't configured yet."); setLoading(false); return; }
    setErr("");
    const { data: d, error } = await supabase.rpc("community_signal_stats");
    if (error) { setErr(error.message || "Couldn't load community results."); setLoading(false); return; }
    setData(d as Stats);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60000);
    return () => clearInterval(t);
  }, [load]);

  if (loading && !data) {
    return <div className="grid place-items-center rounded-2xl border border-[#E4DCCB] bg-cream/60 py-16 text-charcoal/50"><RefreshCw className="h-5 w-5 animate-spin" /></div>;
  }
  if (err && !data) {
    return <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-800"><AlertCircle className="mr-1 inline h-4 w-4" /> {err}</div>;
  }
  if (!data) return null;

  const L = data.live;
  // Combined recorded outcomes = earlier saved plays (launch) + live ledger as it resolves.
  const resolved = L.resolved + data.launch.resolved;
  const wins = L.wins + data.launch.wins;
  const losses = L.losses + data.launch.losses;
  const ci = wilson(wins, wins + losses);
  const confident = resolved >= MIN_CONFIDENT;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.14em] text-charcoal/45">Live · community-wide · updated {ago(data.generated_at)}</p>
        <button onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#E4DCCB] bg-offwhite/60 px-3 py-1.5 text-xs font-semibold text-charcoal/70 transition-colors hover:bg-ice disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {/* Activity tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<Activity className="h-4 w-4" />} label="Signals generated" value={nf(L.generated)} sub={`${nf(L.generated_7d)} this week`} />
        <Stat icon={<Users className="h-4 w-4" />} label="Members using the tools" value={nf(data.members_using)} />
        <Stat icon={<Target className="h-4 w-4" />} label="Live / pending" value={nf(L.open)} sub="waiting to hit stop or target" />
        <Stat icon={<Gauge className="h-4 w-4" />} label="Avg planned reward:risk" value={L.avg_planned_rr ? `1:${L.avg_planned_rr}` : "—"} tone="gold" />
      </div>

      {/* Track record — the star, built honestly */}
      <section className="rounded-2xl border border-[#E4DCCB] bg-cream shadow-card">
        <div className="flex items-center gap-2 border-b border-[#E4DCCB] px-5 py-3.5">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-primary"><Trophy className="h-4 w-4 text-cream" /></span>
          <div className="leading-tight">
            <h2 className="text-sm font-bold text-navy">Community track record</h2>
            <p className="text-[11px] text-charcoal/55">Every recorded OM AI Plays outcome — fresh record, live from the ledger</p>
          </div>
        </div>

        <div className="p-5">
          {confident && ci ? (
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-charcoal/45">Win rate</p>
                <p className="font-serif text-4xl font-extrabold text-navy">{pct(ci.p)}</p>
                <p className="mt-0.5 text-[12px] text-charcoal/55">95% confidence: {pct(ci.low)}–{pct(ci.high)} · {wins}W / {losses}L ({resolved} resolved)</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-charcoal/45">Avg realised return</p>
                <p className="font-serif text-2xl font-bold text-navy">{L.avg_realized_r != null ? `${L.avg_realized_r > 0 ? "+" : ""}${L.avg_realized_r}R` : "—"}</p>
                <p className="mt-0.5 text-[12px] text-charcoal/55">per resolved signal (live ledger)</p>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-[#E4DCCB] bg-offwhite/60 p-4">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-navy"><Info className="h-4 w-4 text-primary" /> Track record is still building</p>
              <p className="mt-1 text-[13px] leading-relaxed text-charcoal/65">
                {resolved} signal{resolved === 1 ? "" : "s"} resolved so far. We deliberately hold back a headline win rate until at least {MIN_CONFIDENT} have closed — a rate on a tiny sample is noise, not evidence. Results fill in automatically as signals reach their stop or target.
              </p>
              {resolved > 0 && (
                <p className="mt-2 text-[13px] font-medium text-charcoal/70">So far: {wins}W / {losses}L</p>
              )}
            </div>
          )}
          {data.launch.resolved > 0 && (
            <p className="mt-3 text-[11px] text-charcoal/45">Includes {data.launch.resolved} earlier saved plays plus every live signal as it closes. Sample is still small — treat as directional, not a guarantee.</p>
          )}
        </div>
      </section>

      {/* By engine + what the community trades */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-5">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-navy"><TrendingUp className="h-4 w-4 text-primary" /> By tool</h3>
          <div className="mt-3 space-y-2.5">
            {L.by_engine.length === 0 ? (
              <p className="text-sm text-charcoal/50">No signals yet.</p>
            ) : L.by_engine.map((e) => {
              const Icon = ENGINE_ICON[e.engine] ?? Radar;
              const r = e.wins + e.losses;
              const w = wilson(e.wins, r);
              return (
                <div key={e.engine} className="flex items-center justify-between gap-3 rounded-lg border border-[#EFE9DC] bg-cream px-3 py-2">
                  <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-navy"><Icon className="h-4 w-4 text-primary" /> {ENGINE_LABEL[e.engine] ?? e.engine}</span>
                  <span className="text-[12px] tabular-nums text-charcoal/60">
                    {nf(e.generated)} generated · {r >= MIN_CONFIDENT && w ? `${pct(w.p)} win (${r})` : `${r} resolved`}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-charcoal/45">Win rate shown once a tool passes {MIN_CONFIDENT} resolved signals.</p>
        </section>

        <section className="rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-5">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-navy"><Radar className="h-4 w-4 text-primary" /> What the community is trading</h3>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {L.top_instruments.map((i) => (
              <span key={i.instrument} className="rounded-full border border-[#E4DCCB] bg-cream px-2.5 py-1 text-[12px] font-medium text-charcoal/75">{i.instrument} <span className="text-charcoal/40">· {i.n}</span></span>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-[12px]">
            <div className="rounded-lg border border-[#EFE9DC] bg-cream px-3 py-2">
              <p className="text-charcoal/45">Direction</p>
              <p className="mt-1 font-semibold text-navy"><ArrowUp className="mb-0.5 inline h-3.5 w-3.5 text-emerald-600" /> {nf(L.direction.long)} long · <ArrowDown className="mb-0.5 inline h-3.5 w-3.5 text-red-600" /> {nf(L.direction.short)} short</p>
            </div>
            <div className="rounded-lg border border-[#EFE9DC] bg-cream px-3 py-2">
              <p className="text-charcoal/45">Confidence mix</p>
              <p className="mt-1 font-semibold text-navy">{nf(L.confidence.High)} High · {nf(L.confidence.Medium)} Med · {nf(L.confidence.Low)} Low</p>
            </div>
          </div>
        </section>
      </div>

      {/* Recent results feed */}
      <section className="rounded-2xl border border-[#E4DCCB] bg-cream shadow-card">
        <div className="border-b border-[#E4DCCB] px-5 py-3.5">
          <h2 className="text-sm font-bold text-navy">Recent results</h2>
          <p className="text-[11px] text-charcoal/55">The latest signals to reach a stop or target</p>
        </div>
        {L.recent.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-charcoal/50">No live results yet — signals show here the moment they close. Check back soon.</p>
        ) : (
          <div className="divide-y divide-[#EFE9DC]">
            {L.recent.map((r, i) => {
              const win = r.status === "win";
              return (
                <div key={i} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={`grid h-6 w-6 flex-shrink-0 place-items-center rounded-full ${win ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                      {r.direction === "long" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                    </span>
                    <p className="truncate text-[13px] font-semibold text-navy">{r.instrument}</p>
                    <span className="text-[11px] text-charcoal/45">{ENGINE_LABEL[r.engine] ?? r.engine}</span>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2.5">
                    {r.realized_r != null && <span className="text-[12px] tabular-nums text-charcoal/55">{r.realized_r > 0 ? "+" : ""}{r.realized_r}R</span>}
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${win ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                      {win ? (r.hit_tp ? `Win · TP${r.hit_tp}` : "Win") : "Stopped"}
                    </span>
                    <span className="text-[11px] text-charcoal/40">{ago(r.at)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <p className="text-center text-[11px] leading-relaxed text-charcoal/45">
        Educational decision-support, not financial advice and not a prediction. Every trade carries risk. Win rates are shown with sample sizes and 95% confidence intervals because small samples can mislead — a rate only becomes meaningful once enough signals have resolved. Past results never guarantee future outcomes.
      </p>
    </div>
  );
}

function Stat({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: "gold" }) {
  const ring = tone === "gold" ? "border-[#E4DCCB] bg-gradient-to-br from-cream to-offwhite" : "border-[#E4DCCB] bg-cream";
  const ic = "bg-primary/10 text-primary";
  return (
    <div className={`rounded-2xl border p-4 shadow-card ${ring}`}>
      <div className="flex items-center gap-2">
        <span className={`grid h-7 w-7 place-items-center rounded-full ${ic}`}>{icon}</span>
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-charcoal/50">{label}</p>
      </div>
      <p className="mt-2 font-serif text-3xl font-extrabold tabular-nums text-navy">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-charcoal/55">{sub}</p>}
    </div>
  );
}
