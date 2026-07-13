"use client";

import { useEffect, useState } from "react";
import {
  Sparkles, Zap, Share2, Hammer, Briefcase, Compass, Gem, Star, Crown, Rocket,
  BarChart3, Activity, ArrowLeft, ArrowRight, Users, TrendingUp, ChevronRight,
} from "lucide-react";

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
        <Metric label="EQV" value={DATA.eqv} icon={Activity} accent="text-gold-deep" />
        <Metric label="Left Volume" value={DATA.leftVol} icon={ArrowLeft} accent="text-navy" />
        <Metric label="Right Volume" value={DATA.rightVol} icon={ArrowRight} accent="text-navy" />
      </div>

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

      <p className="text-center text-[11px] text-medium">
        Preview — these numbers fill in from the comp plan when the network side goes live.
      </p>
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
