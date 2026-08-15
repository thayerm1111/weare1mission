"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Zap, Activity, Radio, ChevronRight, TrendingUp, TrendingDown, Ghost, Gem } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { LIVE_URL, CALLS } from "@/lib/liveCalls";

/* ---------- real community ledger (same RPC the results page uses) ---------- */

type Recent = { engine: string; instrument: string; direction: string; status: string; hit_tp: number | null; realized_r: number | null; at: string };
type Stats = {
  live: { open: number; generated_7d: number; resolved: number; wins: number; losses: number; recent: Recent[] };
  launch: { resolved: number; wins: number; losses: number };
};

const MIN_CONFIDENT = 20;
const isLong = (d: string) => /long|buy/i.test(String(d || ""));
const short = (s: string) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const ENGINE: Record<string, string> = { scanner: "Scanner", plays: "OM Plays", command: "Command", ghost: "MFXGHOST", signal: "Signal", charts: "Charts", pulse: "Pulse", weekly: "Plays of the Week" };
const engineLabel = (e: string) => ENGINE[String(e || "").toLowerCase()] || (e ? e.charAt(0).toUpperCase() + e.slice(1) : "Desk");
function ago(iso: string) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
function statusMeta(status: string): { word: string; tone: "win" | "loss" | "live" | "mute" } {
  const s = String(status || "").toLowerCase();
  if (s === "win") return { word: "Won", tone: "win" };
  if (s === "loss") return { word: "Lost", tone: "loss" };
  if (s === "expired") return { word: "Expired", tone: "mute" };
  return { word: "Live", tone: "live" };
}

function useCountUp(target: number, duration = 1000) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return v;
}

/* ---------- component ---------- */

export function FloorHome({ onGo }: { onGo: (view: string) => void }) {
  const [data, setData] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<"all" | "live" | "wins">("all");

  useEffect(() => {
    const supabase = createClient();
    if (!supabase) return;
    let alive = true;
    const load = async () => {
      const { data: d, error } = await supabase.rpc("community_signal_stats");
      if (!error && d && alive) setData(d as Stats);
    };
    void load();
    const iv = setInterval(() => void load(), 60000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const live = data?.live;
  const resolved = (live?.resolved ?? 0) + (data?.launch.resolved ?? 0);
  const wins = (live?.wins ?? 0) + (data?.launch.wins ?? 0);
  const losses = (live?.losses ?? 0) + (data?.launch.losses ?? 0);
  const wr = resolved >= MIN_CONFIDENT && wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : null;
  const recent = live?.recent ?? [];

  const tickerWins = recent
    .filter((r) => String(r.status).toLowerCase() === "win")
    .map((r) => `✅ ${short(r.instrument)} ${isLong(r.direction) ? "LONG" : "SHORT"} · Won${r.hit_tp != null ? ` · hit TP${r.hit_tp}` : ""}`);

  const feed = useMemo(() => {
    const t = (x: Recent) => statusMeta(x.status).tone;
    const list = filter === "live" ? recent.filter((r) => t(r) === "live")
      : filter === "wins" ? recent.filter((r) => t(r) === "win")
      : recent;
    return list.slice(0, 12);
  }, [recent, filter]);

  return (
    <div className="relative overflow-hidden rounded-xl">
      <div className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(1200px_400px_at_10%_-10%,rgba(111,106,93,0.06),transparent),radial-gradient(900px_400px_at_100%_0%,rgba(111,106,93,0.05),transparent)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.05] [background-image:linear-gradient(rgba(17,17,17,.3)_1px,transparent_1px),linear-gradient(90deg,rgba(17,17,17,.3)_1px,transparent_1px)] [background-size:34px_34px]" />

      <div className="relative space-y-5 p-1 sm:p-2">
        {/* Hero — daily live calls, up and center */}
        <div className="pt-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-gold/40 bg-gold/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-widest text-navy">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" /></span>
            Live daily · 3 · 6 · 9 PM CST
          </span>
          <h2 className="mt-2 text-3xl font-black leading-none tracking-tight sm:text-4xl">
            <span className="bg-gradient-to-r from-navy via-charcoal to-gold-deep bg-clip-text text-transparent">Live trading calls</span>
          </h2>
          <p className="mt-2 text-sm text-charcoal/55">Market overview plus a live trading session — every day on Zoom. Tap to join.</p>

          <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
            {CALLS.map((c) => (
              <div key={c.t} className={`rounded-2xl border p-3.5 ${c.hot ? "border-primary/50 bg-primary/[0.06]" : "border-ice bg-white"}`}>
                <p className="text-lg font-black tracking-tight text-navy">{c.t}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">{c.zone}</p>
                <p className="mt-1 text-xs text-charcoal/60">{c.label}</p>
              </div>
            ))}
          </div>

          <a
            href={LIVE_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-navy to-primary px-5 py-3.5 text-sm font-bold text-cream shadow-card transition hover:shadow-cardhover"
          >
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400/70" /><span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" /></span>
            Join the live call · 1MissionLive.com
            <ChevronRight className="h-4 w-4" />
          </a>
        </div>

        {/* Wins ticker — wins only, with the TP that hit */}
        {tickerWins.length > 0 && (
          <div className="relative overflow-hidden rounded-xl border border-ice bg-offwhite py-2.5">
            <div className="flex w-max gap-10 whitespace-nowrap pl-10" style={{ animation: "floorMarquee 34s linear infinite" }}>
              {[...tickerWins, ...tickerWins].map((t, i) => (
                <span key={i} className="text-sm font-medium text-charcoal/70">{t}</span>
              ))}
            </div>
          </div>
        )}

        {/* GENX — flagship Gold engine (its own page) */}
        <Link
          href="/portal/genx"
          className="group relative flex items-center justify-between gap-3 overflow-hidden rounded-2xl border border-amber-400/40 bg-[#0b0d14] px-5 py-4 text-white transition hover:border-amber-300/70"
          style={{ backgroundImage: "radial-gradient(120% 120% at 0% 0%, rgba(255,194,75,0.14), transparent 55%)" }}
        >
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-300/80"><Gem className="h-3 w-3" /> Flagship · new</p>
            <p className="mt-0.5 bg-gradient-to-r from-amber-200 via-amber-400 to-amber-200 bg-clip-text text-2xl font-black tracking-tight text-transparent">GENX</p>
            <p className="text-xs text-white/55">Gold intelligence engine — “what should I do on Gold right now?”</p>
          </div>
          <ChevronRight className="h-5 w-5 flex-shrink-0 text-amber-300/80 transition group-hover:translate-x-0.5" />
        </Link>

        {/* Real stat band */}
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatCard label="Live now" value={live?.open ?? 0} />
          <StatCard label="Plays this week" value={live?.generated_7d ?? 0} />
          <StatCard label="Community win rate" value={wr ?? 0} suffix="%" dash={wr == null} />
          <StatCard label="Signals resolved" value={resolved} />
        </div>

        {/* Quick jump */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <JumpCard onClick={() => onGo("xghost")} icon={Ghost} label="xGhost" sub="5-pair AI scanner" />
          <JumpCard onClick={() => onGo("room")} icon={Radio} label="The Room" sub="Live calls" />
          <JumpCard onClick={() => onGo("plays")} icon={Zap} label="Live Plays" sub="Plays of the week" />
          <JumpCard onClick={() => onGo("pulse")} icon={Activity} label="Market Pulse" sub="AI scanner" />
        </div>

        {/* Live plays — real signals from the AI desk */}
        <section className="rounded-2xl border border-ice bg-white p-4 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="inline-flex items-center gap-2 text-sm font-bold"><Zap className="h-4 w-4 text-navy" /> Live plays</p>
            <div className="flex gap-1.5">
              {(["all", "live", "wins"] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-3 py-1 text-xs font-semibold capitalize transition-colors ${filter === f ? "bg-primary text-cream" : "bg-offwhite/60 text-charcoal/60 hover:bg-ice"}`}>{f}</button>
              ))}
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {feed.length === 0 && (
              <p className="py-6 text-center text-xs text-charcoal/40">No live plays yet — new signals show here as the desk calls them.</p>
            )}
            {feed.map((r, i) => {
              const m = statusMeta(r.status);
              const long = isLong(r.direction);
              const sym = short(r.instrument);
              const rr = r.realized_r != null ? `${r.realized_r > 0 ? "+" : ""}${r.realized_r}R` : "";
              const toneCls = m.tone === "win" ? "text-emerald-500" : m.tone === "loss" ? "text-red-400" : m.tone === "live" ? "text-sky-500" : "text-charcoal/45";
              return (
                <div key={`${r.instrument}-${r.at}-${i}`} className="flex items-center gap-3 rounded-xl border border-ice bg-offwhite/50 px-3 py-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy/[0.05] text-[11px] font-black text-navy">{sym.slice(0, 3)}</div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">{sym}</p>
                    <p className="truncate text-[11px] text-charcoal/40">{engineLabel(r.engine)} · {ago(r.at)}</p>
                  </div>
                  <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${long ? "bg-navy/[0.06] text-navy" : "bg-gold/15 text-gold-deep"}`}>{long ? "LONG" : "SHORT"}</span>
                  <span className={`inline-flex w-20 items-center justify-end gap-1 text-sm font-bold ${toneCls}`}>
                    {m.tone === "win" ? <TrendingUp className="h-3.5 w-3.5" /> : m.tone === "loss" ? <TrendingDown className="h-3.5 w-3.5" /> : null}
                    {rr || m.word}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <p className="pb-1 text-center text-[11px] text-charcoal/35">
          Real results from the AI desk · educational analysis, not financial advice.
        </p>
      </div>

      <style>{`@keyframes floorMarquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}

function StatCard({ label, value, suffix = "", dash = false }: { label: string; value: number; suffix?: string; dash?: boolean }) {
  const v = useCountUp(value);
  return (
    <div className="rounded-2xl border border-ice bg-white p-3.5 backdrop-blur">
      <p className="text-2xl font-black tabular-nums text-navy sm:text-3xl">
        {dash ? "—" : Math.round(v).toLocaleString()}
        {!dash && <span className="text-navy">{suffix}</span>}
      </p>
      <p className="mt-0.5 text-[11px] uppercase tracking-wide text-charcoal/45">{label}</p>
    </div>
  );
}

function JumpCard({ onClick, icon: Icon, label, sub }: { onClick: () => void; icon: typeof Radio; label: string; sub: string }) {
  return (
    <button
      onClick={onClick}
      className="group relative flex items-center gap-3 overflow-hidden rounded-2xl border border-ice bg-white p-3.5 text-left backdrop-blur transition hover:border-charcoal/25 hover:bg-offwhite"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-navy/[0.05] text-navy transition group-hover:scale-110">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-bold">{label}</p>
        <p className="truncate text-[11px] text-charcoal/45">{sub}</p>
      </div>
      <ChevronRight className="ml-auto h-4 w-4 text-charcoal/30 transition group-hover:translate-x-0.5 group-hover:text-charcoal/60" />
    </button>
  );
}
