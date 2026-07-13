"use client";

import { useEffect, useState } from "react";
import {
  Sparkles, Zap, Share2, Hammer, Briefcase, Compass, Gem, Star, Crown, Rocket,
  BarChart3, Activity, ArrowLeft, ArrowRight, Users, TrendingUp, ChevronDown,
  Car, Plane, Home, DollarSign, Check, Lock, Wallet, ArrowUpRight,
} from "lucide-react";

// Earnings (placeholder). 30-day = Visionary's $200k/mo.
const EARNINGS = [
  { label: "Last 7 days", value: 50_000, bars: [38, 52, 44, 66, 58, 80, 100] },
  { label: "Last 30 days", value: 200_000, highlight: true, bars: [40, 55, 62, 58, 74, 88, 100] },
  { label: "Last 12 months", value: 2_400_000, bars: [30, 42, 50, 60, 72, 84, 100] },
];

// Top enrollment lines — sums to EQV (1,350,700).
const ENROLLMENTS = [
  { name: "Wifi Money", volume: 520_000 },
  { name: "Garret Roberts", volume: 340_000 },
  { name: "Korab Kozgori", volume: 210_700 },
  { name: "Ali Saleh", volume: 160_000 },
  { name: "Anthony Waukuski", volume: 120_000 },
];

// 90-day run milestones. RUN = current 90-day volume (placeholder).
const RUN = 37_000;
const RUN_MAX = 100_000;
const MILESTONES = [
  { vol: 20_000, reward: "Car Bonus", sub: "$1,000", icon: Car },
  { vol: 32_500, reward: "Cash Bonus", sub: "$3,000", icon: DollarSign },
  { vol: 50_000, reward: "Mallorca, Spain", sub: "Trip paid", icon: Plane },
  { vol: 100_000, reward: "House Bonus", sub: "$5,000", icon: Home },
];

/* -------- rank ladder (lowest → highest) -------- */
const RANKS = [
  { name: "The One", icon: Sparkles },
  { name: "Activated", icon: Zap },
  { name: "Connector", icon: Share2 },
  { name: "Mission Builder", icon: Hammer },
  { name: "Mogul", icon: Briefcase },
  { name: "Pathfinder", icon: Compass },
  { name: "Diamond", icon: Gem },
  { name: "Icon", icon: Star },
  { name: "Legend", icon: Crown },
  { name: "Visionary", icon: Rocket },
];

/* -------- placeholder data (wired to real comp plan later) -------- */
const DATA = {
  currentRank: "Visionary",
  leftPersonals: 5,
  rightPersonals: 5,
  volume: 1_570_000,
  eqv: 1_350_700,
  leftVol: 785_000,
  rightVol: 785_000,
};

function useCountUp(target: number, duration = 1200) {
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

export function BuildersDashboard({ name }: { name?: string | null }) {
  const rankIdx = RANKS.findIndex((r) => r.name === DATA.currentRank);
  const RankIcon = RANKS[rankIdx]?.icon ?? Rocket;
  const first = (name ?? "Builder").split(" ")[0];
  const [showEqv, setShowEqv] = useState(false);

  return (
    <div className="space-y-5">
      {/* ---------- Hero ---------- */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-primary p-6 text-cream shadow-card sm:p-8">
        <div className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(900px_360px_at_100%_-20%,rgba(94,134,168,0.35),transparent),radial-gradient(700px_320px_at_-10%_120%,rgba(212,180,90,0.25),transparent)]" />
        <div className="pointer-events-none absolute inset-0 opacity-[0.06] [background-image:linear-gradient(rgba(255,255,255,.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.6)_1px,transparent_1px)] [background-size:32px_32px]" />

        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-cream/25 bg-cream/10 px-3 py-1 text-[11px] font-bold uppercase tracking-widest">
              <Rocket className="h-3 w-3" /> Builder HQ
            </span>
            <h1 className="mt-3 text-2xl font-black tracking-tight sm:text-3xl">
              Let&apos;s build, {first} 🚀
            </h1>
            <p className="mt-1 text-sm text-cream/70">Your network at a glance.</p>
          </div>

          {/* Rank badge */}
          <div className="flex items-center gap-4 rounded-2xl border border-cream/20 bg-cream/10 p-4 backdrop-blur">
            <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-gold text-navy shadow-[0_0_30px_-6px_rgba(94,134,168,0.9)]">
              <RankIcon className="h-8 w-8" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-cream/60">Current Rank</p>
              <p className="text-xl font-black">{DATA.currentRank}</p>
              <p className="text-[11px] font-semibold text-gold-light">★ Max rank unlocked</p>
            </div>
          </div>
        </div>
      </div>

      {/* ---------- 90-day milestone meter ---------- */}
      <MilestoneMeter />

      {/* ---------- Binary legs ---------- */}
      <div className="rounded-3xl border border-[#E4DCCB] bg-cream p-5 shadow-card">
        <div className="flex items-center justify-between">
          <p className="inline-flex items-center gap-2 text-sm font-bold text-navy">
            <Users className="h-4 w-4 text-primary" /> Your Team Legs
          </p>
          <span className="text-xs text-medium">1 personal = 100 volume</span>
        </div>

        {/* mini binary tree */}
        <div className="mt-4">
          <div className="flex justify-center">
            <div className="flex flex-col items-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-sm font-black text-cream">YOU</div>
              <div className="h-4 w-px bg-[#E4DCCB]" />
            </div>
          </div>
          <div className="relative mx-auto flex max-w-md justify-between">
            <div className="absolute left-1/4 right-1/4 top-0 h-px bg-[#E4DCCB]" />
            <div className="absolute left-1/4 top-0 h-4 w-px bg-[#E4DCCB]" />
            <div className="absolute right-1/4 top-0 h-4 w-px bg-[#E4DCCB]" />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <LegCard side="left" personals={DATA.leftPersonals} />
            <LegCard side="right" personals={DATA.rightPersonals} />
          </div>
        </div>
      </div>

      {/* ---------- Metrics ---------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Total Volume" value={DATA.volume} icon={BarChart3} accent="text-primary" glow />
        <EqvCard value={DATA.eqv} open={showEqv} onToggle={() => setShowEqv((v) => !v)} />
        <Metric label="Left Volume" value={DATA.leftVol} icon={ArrowLeft} accent="text-navy" />
        <Metric label="Right Volume" value={DATA.rightVol} icon={ArrowRight} accent="text-navy" />
      </div>

      {/* EQV breakdown */}
      {showEqv && (
        <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-4 shadow-card">
          <div className="flex items-center justify-between">
            <p className="inline-flex items-center gap-2 text-sm font-bold text-navy">
              <Activity className="h-4 w-4 text-gold-deep" /> Top enrollment lines
            </p>
            <span className="text-xs text-medium">EQV breakdown</span>
          </div>
          <div className="mt-3 space-y-1.5">
            {ENROLLMENTS.map((e, i) => (
              <div key={e.name} className="flex items-center gap-3 rounded-xl border border-[#E4DCCB] bg-offwhite/50 px-3 py-2.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-cream">{i + 1}</span>
                <span className="flex-1 text-sm font-semibold text-navy">{e.name}</span>
                <span className="text-sm font-bold tabular-nums text-gold-deep">{e.volume.toLocaleString()} <span className="text-xs font-medium text-medium">vol</span></span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-[#E4DCCB] pt-2.5">
            <span className="text-sm font-bold text-navy">Total EQV</span>
            <span className="text-sm font-black tabular-nums text-gold-deep">{DATA.eqv.toLocaleString()}</span>
          </div>
        </div>
      )}

      {/* ---------- Rank ladder ---------- */}
      <div className="rounded-3xl border border-[#E4DCCB] bg-cream p-5 shadow-card">
        <div className="flex items-center justify-between">
          <p className="inline-flex items-center gap-2 text-sm font-bold text-navy">
            <TrendingUp className="h-4 w-4 text-primary" /> Rank Journey
          </p>
          <span className="text-xs text-medium">{rankIdx + 1} / {RANKS.length}</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {RANKS.map((r, i) => {
            const Icon = r.icon;
            const achieved = i <= rankIdx;
            const current = i === rankIdx;
            return (
              <div
                key={r.name}
                className={`flex flex-col items-center gap-1.5 rounded-2xl border p-3 text-center transition ${
                  current
                    ? "border-primary bg-gradient-primary text-cream shadow-card"
                    : achieved
                    ? "border-[#E4DCCB] bg-ice text-navy"
                    : "border-[#E4DCCB] bg-offwhite/40 text-medium"
                }`}
              >
                <span
                  className={`flex h-9 w-9 items-center justify-center rounded-xl ${
                    current ? "bg-cream/15 text-cream" : achieved ? "bg-white text-primary" : "bg-white/60 text-medium"
                  }`}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <span className="text-[11px] font-bold leading-tight">{r.name}</span>
                {current && <span className="text-[9px] font-bold uppercase tracking-wide text-gold-light">You are here</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------- Earnings ---------- */}
      <EarningsSection />

      <p className="text-center text-[11px] text-medium">
        Preview — these numbers fill in from the comp plan when the network side goes live.
      </p>
    </div>
  );
}

function EarningsSection() {
  return (
    <div className="relative overflow-hidden rounded-3xl bg-gradient-primary p-6 text-cream shadow-card sm:p-7">
      <div className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(900px_340px_at_-5%_-30%,rgba(16,185,129,0.28),transparent),radial-gradient(800px_320px_at_105%_120%,rgba(94,134,168,0.3),transparent)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.06] [background-image:linear-gradient(rgba(255,255,255,.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.6)_1px,transparent_1px)] [background-size:32px_32px]" />
      <div className="relative">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="inline-flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-cream/70">
            <Wallet className="h-4 w-4" /> Earnings
          </p>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-cream/20 bg-cream/10 px-3 py-1 text-[11px] font-bold">
            <Rocket className="h-3 w-3 text-gold-light" /> Visionary · $200,000 / month
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {EARNINGS.map((e) => (
            <EarnTile key={e.label} {...e} />
          ))}
        </div>
      </div>
    </div>
  );
}

function EarnTile({
  label, value, bars, highlight,
}: {
  label: string; value: number; bars: number[]; highlight?: boolean;
}) {
  const v = useCountUp(value, 1600);
  return (
    <div
      className={`rounded-2xl border p-4 backdrop-blur ${
        highlight ? "border-gold-light/50 bg-gold/15 ring-1 ring-gold-light/20" : "border-cream/15 bg-cream/[0.06]"
      }`}
    >
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-cream/55">{label}</p>
        <ArrowUpRight className="h-4 w-4 text-emerald-300" />
      </div>
      <p className="mt-1 text-2xl font-black tabular-nums sm:text-3xl">
        <span className="bg-gradient-to-r from-emerald-300 via-cream to-gold-light bg-clip-text text-transparent">
          ${Math.round(v).toLocaleString()}
        </span>
      </p>
      {highlight && (
        <p className="text-[10px] font-bold uppercase tracking-wide text-gold-light">Matches your rank</p>
      )}
      <div className="mt-3 flex h-8 items-end gap-1">
        {bars.map((h, i) => (
          <span
            key={i}
            className={`w-full rounded-sm ${highlight ? "bg-gold-light/60" : "bg-cream/25"}`}
            style={{ height: `${Math.max(12, h)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function MilestoneMeter() {
  const progress = useCountUp((RUN / RUN_MAX) * 100, 1900); // 0 → current %
  const pct = (v: number) => (v / RUN_MAX) * 100;
  return (
    <div className="rounded-3xl border border-[#E4DCCB] bg-cream p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 text-sm font-bold text-navy">
          <Rocket className="h-4 w-4 text-gold-deep" /> 90-Day Run
        </p>
        <span className="text-xs text-medium">
          <span className="font-bold text-gold-deep">{RUN.toLocaleString()}</span> / {RUN_MAX.toLocaleString()} vol
        </span>
      </div>

      {/* progress bar with milestone ticks + rocket */}
      <div className="relative mx-1 mt-9 h-2.5 rounded-full bg-ice">
        <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-gold" style={{ width: `${progress}%` }} />
        {MILESTONES.map((m) => {
          const p = pct(m.vol);
          const q = progress >= p - 0.2;
          return (
            <span key={m.vol} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${p}%` }}>
              <span className={`block h-4 w-4 rounded-full border-2 transition-colors ${q ? "border-gold-deep bg-gold" : "border-[#E4DCCB] bg-cream"}`} />
              <span className={`absolute left-1/2 top-5 -translate-x-1/2 whitespace-nowrap text-[10px] font-bold transition-colors ${q ? "text-gold-deep" : "text-medium"}`}>
                {m.vol / 1000}k
              </span>
            </span>
          );
        })}
        <span className="absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2" style={{ left: `${progress}%` }}>
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-cream shadow-card">
            <Rocket className="h-4 w-4 -rotate-45" />
          </span>
        </span>
      </div>

      {/* milestone cards */}
      <div className="mt-9 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {MILESTONES.map((m) => {
          const q = progress >= pct(m.vol) - 0.2;
          const Icon = m.icon;
          return (
            <div key={m.vol} className={`rounded-2xl border p-3 transition-colors ${q ? "border-gold-deep bg-gold/10" : "border-[#E4DCCB] bg-offwhite/40"}`}>
              <div className="flex items-center justify-between">
                <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${q ? "bg-gold text-cream" : "bg-white text-medium"}`}>
                  <Icon className="h-4 w-4" />
                </span>
                {q ? <Check className="h-4 w-4 text-gold-deep" /> : <Lock className="h-3.5 w-3.5 text-medium" />}
              </div>
              <p className={`mt-2 text-sm font-bold ${q ? "text-navy" : "text-charcoal/70"}`}>{m.reward}</p>
              <p className="text-xs text-medium">{m.sub}</p>
              <p className={`mt-1 text-[11px] font-bold ${q ? "text-gold-deep" : "text-medium"}`}>{m.vol.toLocaleString()} vol</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LegCard({ side, personals }: { side: "left" | "right"; personals: number }) {
  const vol = useCountUp(personals * 100);
  const Arrow = side === "left" ? ArrowLeft : ArrowRight;
  return (
    <div className="rounded-2xl border border-[#E4DCCB] bg-offwhite/50 p-4 text-center">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-medium">
        <Arrow className="h-3.5 w-3.5" /> {side} leg
      </span>
      <p className="mt-1 text-4xl font-black tabular-nums text-navy">{personals}</p>
      <p className="text-xs text-medium">personals</p>
      <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-ice px-2.5 py-1 text-xs font-bold text-primary">
        {Math.round(vol).toLocaleString()} vol
      </p>
    </div>
  );
}

function Metric({
  label, value, icon: Icon, accent, glow,
}: {
  label: string; value: number; icon: typeof BarChart3; accent: string; glow?: boolean;
}) {
  const v = useCountUp(value);
  return (
    <div className={`rounded-2xl border border-[#E4DCCB] bg-cream p-4 shadow-card ${glow ? "ring-1 ring-primary/20" : ""}`}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-medium">{label}</p>
        <Icon className={`h-4 w-4 ${accent}`} />
      </div>
      <p className={`mt-1 text-2xl font-black tabular-nums ${accent}`}>{Math.round(v).toLocaleString()}</p>
    </div>
  );
}

function EqvCard({ value, open, onToggle }: { value: number; open: boolean; onToggle: () => void }) {
  const v = useCountUp(value);
  return (
    <button
      onClick={onToggle}
      className={`rounded-2xl border bg-cream p-4 text-left shadow-card transition-colors ${
        open ? "border-gold-deep ring-1 ring-gold-deep/30" : "border-[#E4DCCB] hover:border-gold-deep/50"
      }`}
    >
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-medium">EQV</p>
        <ChevronDown className={`h-4 w-4 text-gold-deep transition-transform ${open ? "rotate-180" : ""}`} />
      </div>
      <p className="mt-1 text-2xl font-black tabular-nums text-gold-deep">{Math.round(v).toLocaleString()}</p>
      <p className="mt-0.5 text-[10px] font-semibold text-medium">Tap for top lines</p>
    </button>
  );
}
