"use client";

import { useEffect, useState } from "react";
import {
  Radio, Zap, Activity, Repeat, Flame, Trophy, TrendingUp, TrendingDown,
  ChevronRight, Sparkles, Eye, Circle,
} from "lucide-react";

/* ---------- sample data (Phase 1) ---------- */

const STATS = [
  { label: "Trading now", value: 214, suffix: "" },
  { label: "Plays called today", value: 37, suffix: "" },
  { label: "Community win rate", value: 73, suffix: "%" },
  { label: "Live streak record", value: 19, suffix: "d" },
];

const TICKER = [
  "🔴 RJ Antuna is LIVE in The Room",
  "🔥 Gold_Master on a 7-day green streak",
  "⚡ New play: XAU/USD SELL by Arabella",
  "✅ XAU GHOSTS hit TP3 (+18.4% mo)",
  "🚀 BTC buy-and-hold +12.6% since Mon",
  "🏆 Hannah Gallagher climbed to #3",
  "💎 42 members copying live trades",
];

type Trader = { name: string; monthly: number; streak: number; hot?: boolean };
const LEADERS: Trader[] = [
  { name: "Gold_Master", monthly: 29.6, streak: 7, hot: true },
  { name: "XAU GHOSTS", monthly: 18.4, streak: 5 },
  { name: "Hannah Gallagher", monthly: 15.1, streak: 4 },
  { name: "Alpha Pro", monthly: 3.5, streak: 2 },
  { name: "Kairos Nas100", monthly: 8.2, streak: 3 },
];

type Play = { ticker: string; name: string; dir: "LONG" | "SHORT"; pnl: number; by: string; held: string; cat: string };
const PLAYS: Play[] = [
  { ticker: "XAUUSD", name: "Gold", dir: "LONG", pnl: 4.2, by: "Gold_Master", held: "3d", cat: "FX" },
  { ticker: "BTCUSDT", name: "Bitcoin", dir: "LONG", pnl: 12.6, by: "XAU GHOSTS", held: "6d", cat: "Crypto" },
  { ticker: "NAS100", name: "Nasdaq", dir: "LONG", pnl: -1.8, by: "Kairos Nas100", held: "2d", cat: "Indices" },
  { ticker: "EURUSD", name: "Euro", dir: "SHORT", pnl: 2.1, by: "RJ Antuna", held: "1d", cat: "FX" },
  { ticker: "TSLA", name: "Tesla", dir: "LONG", pnl: 7.9, by: "Alpha Pro", held: "5d", cat: "Stocks" },
  { ticker: "ETHUSDT", name: "Ethereum", dir: "LONG", pnl: 5.4, by: "XAU GHOSTS", held: "4d", cat: "Crypto" },
];
const CATS = ["All", "FX", "Crypto", "Indices", "Stocks"];

/* ---------- count-up hook ---------- */

function useCountUp(target: number, duration = 1100) {
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
  const [cat, setCat] = useState("All");
  const plays = cat === "All" ? PLAYS : PLAYS.filter((p) => p.cat === cat);

  return (
    <div className="relative overflow-hidden rounded-xl">
      {/* futuristic backdrop */}
      <div className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(1200px_400px_at_10%_-10%,rgba(16,185,129,0.12),transparent),radial-gradient(900px_400px_at_100%_0%,rgba(94,134,168,0.14),transparent)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.05] [background-image:linear-gradient(rgba(255,255,255,.5)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.5)_1px,transparent_1px)] [background-size:34px_34px]" />

      <div className="relative space-y-5 p-1 sm:p-2">
        {/* Hero */}
        <div className="flex flex-col gap-4 pt-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-widest text-emerald-300">
              <Sparkles className="h-3 w-3" /> The Floor
            </span>
            <h2 className="mt-2 text-3xl font-black leading-none tracking-tight sm:text-4xl">
              <span className="bg-gradient-to-r from-emerald-300 via-white to-gold-light bg-clip-text text-transparent">
                Where the movement moves.
              </span>
            </h2>
            <p className="mt-2 text-sm text-white/55">
              Top traders, hottest streaks, and the newest plays — live.
            </p>
          </div>
          <button
            onClick={() => onGo("room")}
            className="group inline-flex items-center justify-center gap-2 self-start rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-400 px-5 py-3 text-sm font-bold text-black shadow-[0_0_30px_-6px_rgba(16,185,129,0.7)] transition hover:shadow-[0_0_40px_-4px_rgba(16,185,129,0.9)]"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-black/60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-black" />
            </span>
            Jump into the live room
            <ChevronRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </button>
        </div>

        {/* Live ticker */}
        <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black/30 py-2.5">
          <div className="flex w-max gap-10 whitespace-nowrap pl-10" style={{ animation: "floorMarquee 34s linear infinite" }}>
            {[...TICKER, ...TICKER].map((t, i) => (
              <span key={i} className="text-sm font-medium text-white/70">{t}</span>
            ))}
          </div>
        </div>

        {/* Stat band */}
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {STATS.map((s) => (
            <StatCard key={s.label} {...s} />
          ))}
        </div>

        {/* Quick jump */}
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <JumpCard onClick={() => onGo("room")} icon={Radio} label="The Room" sub="Live session" live />
          <JumpCard onClick={() => onGo("plays")} icon={Zap} label="Live Plays" sub="3 active" />
          <JumpCard onClick={() => onGo("pulse")} icon={Activity} label="Market Pulse" sub="Scanners" />
          <JumpCard onClick={() => onGo("sync")} icon={Repeat} label="Trade Sync" sub="Copy trade" />
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
          {/* Leaderboard / streaks */}
          <section className="rounded-2xl border border-white/10 bg-[#1e1810]/80 p-4 backdrop-blur">
            <div className="flex items-center justify-between">
              <p className="inline-flex items-center gap-2 text-sm font-bold">
                <Trophy className="h-4 w-4 text-gold-light" /> Top traders & streaks
              </p>
              <button onClick={() => onGo("sync")} className="text-xs font-semibold text-emerald-400 hover:text-emerald-300">
                See all
              </button>
            </div>

            {/* Podium top 3 */}
            <div className="mt-4 grid grid-cols-3 gap-2">
              {[LEADERS[1], LEADERS[0], LEADERS[2]].map((t, i) => {
                const rank = i === 1 ? 1 : i === 0 ? 2 : 3;
                const h = rank === 1 ? "h-24" : "h-16";
                const ring = rank === 1 ? "ring-2 ring-gold-light shadow-[0_0_30px_-8px_rgba(94,134,168,0.9)]" : "ring-1 ring-white/15";
                return (
                  <div key={t.name} className="flex flex-col items-center justify-end">
                    <div className={`flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-sm font-black text-emerald-300 ${ring}`}>
                      {t.name.slice(0, 2).toUpperCase()}
                    </div>
                    <p className="mt-1 max-w-full truncate text-[11px] font-semibold">{t.name}</p>
                    <p className="text-[11px] font-bold text-emerald-400">+{t.monthly}%</p>
                    <div className={`mt-1 flex w-full items-start justify-center rounded-t-lg bg-gradient-to-t from-emerald-500/10 to-emerald-400/25 ${h}`}>
                      <span className="mt-1 text-xs font-black text-white/70">#{rank}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Rest of leaderboard */}
            <div className="mt-3 space-y-1.5">
              {LEADERS.map((t, i) => (
                <div key={t.name} className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
                  <span className="w-4 text-xs font-bold text-white/40">{i + 1}</span>
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/15 text-[11px] font-bold text-emerald-300">
                    {t.name.slice(0, 2).toUpperCase()}
                  </div>
                  <span className="flex-1 truncate text-sm font-semibold">{t.name}</span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-bold text-gold-light">
                    <Flame className="h-3 w-3" /> {t.streak}d
                  </span>
                  <span className="w-14 text-right text-sm font-bold text-emerald-400">+{t.monthly}%</span>
                </div>
              ))}
            </div>
          </section>

          {/* Newest plays */}
          <section className="rounded-2xl border border-white/10 bg-[#1e1810]/80 p-4 backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="inline-flex items-center gap-2 text-sm font-bold">
                <Zap className="h-4 w-4 text-emerald-400" /> Newest buy &amp; hold plays
              </p>
              <button onClick={() => onGo("plays")} className="text-xs font-semibold text-emerald-400 hover:text-emerald-300">
                All plays
              </button>
            </div>

            {/* filter chips */}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {CATS.map((c) => (
                <button
                  key={c}
                  onClick={() => setCat(c)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                    cat === c ? "bg-white text-black" : "bg-white/5 text-white/60 hover:bg-white/10"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>

            <div className="mt-3 space-y-2">
              {plays.map((p, i) => {
                const up = p.pnl >= 0;
                return (
                  <button
                    key={i}
                    onClick={() => onGo("plays")}
                    className="flex w-full items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5 text-left transition hover:border-emerald-400/30"
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-[11px] font-black text-emerald-300">
                      {p.ticker.slice(0, 3)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">{p.ticker}</p>
                      <p className="truncate text-[11px] text-white/40">{p.by} · held {p.held}</p>
                    </div>
                    <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${p.dir === "LONG" ? "bg-emerald-500/15 text-emerald-300" : "bg-gold/15 text-gold-light"}`}>
                      {p.dir}
                    </span>
                    <span className={`inline-flex w-16 items-center justify-end gap-1 text-sm font-bold ${up ? "text-emerald-400" : "text-red-400"}`}>
                      {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                      {up ? "+" : ""}{p.pnl}%
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <p className="pb-1 text-center text-[11px] text-white/35">
          Preview data — the Floor lights up with real streaks, plays and traders in Phase 2.
        </p>
      </div>

      <style>{`@keyframes floorMarquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}

function StatCard({ label, value, suffix }: { label: string; value: number; suffix: string }) {
  const v = useCountUp(value);
  const shown = suffix === "%" || suffix === "d" ? Math.round(v) : Math.round(v);
  return (
    <div className="rounded-2xl border border-white/10 bg-[#1e1810]/70 p-3.5 backdrop-blur">
      <p className="text-2xl font-black tabular-nums text-white sm:text-3xl">
        {shown.toLocaleString()}
        <span className="text-emerald-400">{suffix}</span>
      </p>
      <p className="mt-0.5 text-[11px] uppercase tracking-wide text-white/45">{label}</p>
    </div>
  );
}

function JumpCard({
  onClick, icon: Icon, label, sub, live,
}: {
  onClick: () => void; icon: typeof Radio; label: string; sub: string; live?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="group relative flex items-center gap-3 overflow-hidden rounded-2xl border border-white/10 bg-[#1e1810]/70 p-3.5 text-left backdrop-blur transition hover:border-emerald-400/40 hover:bg-[#241d13]"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300 transition group-hover:scale-110">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-bold">
          {label}
          {live && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-400">
              <Circle className="h-1.5 w-1.5 animate-pulse fill-red-500 text-red-500" /> LIVE
            </span>
          )}
        </p>
        <p className="truncate text-[11px] text-white/45">{sub}</p>
      </div>
      <ChevronRight className="ml-auto h-4 w-4 text-white/30 transition group-hover:translate-x-0.5 group-hover:text-white/60" />
    </button>
  );
}
