"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Flame, Trophy, Sparkles, Check, ArrowRight, Award, Target } from "lucide-react";
import { useGame, type Side, type Mission } from "@/lib/gamification";
import { Leaderboard } from "./Leaderboard";

/**
 * DailyEngagement — the gamified daily home. Level + XP progression, login streak,
 * daily missions with XP, and a rotating mindset. Side-aware (The One / The Builder).
 * Persists per-device (v1) via the gamification engine.
 */
export function DailyEngagement({ side }: { side: Side }) {
  const g = useGame(side);

  // Auto-dismiss the celebration toast.
  useEffect(() => {
    if (!g.celebrate) return;
    const t = setTimeout(() => g.clearCelebrate(), g.celebrate.kind === "level" ? 2600 : 1600);
    return () => clearTimeout(t);
  }, [g.celebrate, g]);

  if (!g.hydrated) return <Skeleton />;

  return (
    <section className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* Rank / level / XP */}
        <div className="relative overflow-hidden rounded-2xl bg-navy p-6 text-white sm:p-7">
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gold-light/10 blur-2xl" />
          <div className="flex items-center justify-between gap-3">
            <span className="eyebrow text-gold-light">Your Rank</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/80">
              <Trophy className="h-3.5 w-3.5 text-gold-light" /> Level {g.tier.level}
            </span>
          </div>
          <h2 className="mt-3 font-serif text-2xl font-semibold uppercase tracking-[0.01em] text-white sm:text-3xl">
            {g.tier.name}
          </h2>

          <div className="mt-5">
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/12">
              <div
                className="h-full rounded-full bg-gradient-to-r from-gold-light to-[#e6c78a] transition-[width] duration-700 ease-out"
                style={{ width: `${g.tier.max ? 100 : g.tier.pct}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[12px] text-light/70">
              <span className="font-semibold text-white">{g.xp.toLocaleString()} XP</span>
              <span>{g.tier.max ? "Max rank reached" : `${g.tier.toNext} XP to ${g.tier.nextTier}`}</span>
            </div>
          </div>
        </div>

        {/* Streak */}
        <div className="flex flex-col justify-between rounded-2xl border border-[#E7E4DD] bg-white p-6 shadow-card">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Daily Streak</span>
            <Award className="h-4 w-4 text-medium" aria-hidden="true" />
          </div>
          <div className="mt-3 flex items-end gap-3">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-[#F5A623] to-[#E8890C] text-white">
              <Flame className="h-6 w-6" />
            </span>
            <div className="leading-none">
              <p className="font-serif text-4xl font-bold text-navy">{g.streak}</p>
              <p className="mt-1 text-xs text-charcoal/55">day{g.streak === 1 ? "" : "s"} in a row</p>
            </div>
          </div>
          <p className="mt-4 text-xs text-charcoal/50">
            Best streak: <span className="font-semibold text-navy">{g.best}</span> · Keep it alive by showing up daily.
          </p>
        </div>
      </div>

      {/* Daily missions */}
      <div className="rounded-2xl border border-[#E7E4DD] bg-white p-6 shadow-card sm:p-7">
        <div className="flex items-center justify-between gap-3">
          <span className="eyebrow inline-flex items-center gap-2"><Target className="h-4 w-4 text-primary" /> Today&apos;s Missions</span>
          <span className="text-xs font-semibold text-navy">
            {g.dailyDone}/{g.total} · <span className="text-gold-light">+{g.dailyXp} XP</span>
          </span>
        </div>
        <ul className="mt-4 space-y-2.5">
          {g.missions.map((m) => (
            <MissionRow key={m.id} m={m} onDone={() => g.completeMission(m)} />
          ))}
        </ul>
      </div>

      {/* Mindset / quote of the day */}
      <div className="rounded-2xl border border-[#E7E4DD] bg-offwhite/70 p-6 sm:p-7">
        <span className="eyebrow">Today&apos;s Mindset</span>
        <p className="mt-3 font-serif text-xl font-semibold uppercase tracking-[0.01em] text-navy sm:text-2xl">
          {g.quote}
        </p>
      </div>

      {/* Community leaderboard */}
      <Leaderboard />

      {g.celebrate && <Celebration kind={g.celebrate.kind} label={g.celebrate.label} />}
    </section>
  );
}

function MissionRow({ m, onDone }: { m: Mission & { done: boolean }; onDone: () => void }) {
  return (
    <li
      className={`flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
        m.done ? "border-[#E7E4DD] bg-offwhite/50" : "border-[#EEEDE8] bg-white hover:border-primary/30"
      }`}
    >
      <button
        type="button"
        onClick={onDone}
        disabled={m.done}
        aria-label={m.done ? "Completed" : `Mark "${m.label}" complete`}
        className={`grid h-6 w-6 flex-shrink-0 place-items-center rounded-full border transition-all ${
          m.done
            ? "border-transparent bg-gradient-to-br from-gold-light to-[#c6a667] text-navy"
            : "border-primary/30 text-transparent hover:border-primary hover:bg-primary/5"
        }`}
      >
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      </button>
      <span className={`flex-1 text-sm font-medium ${m.done ? "text-charcoal/40 line-through" : "text-navy"}`}>
        {m.label}
      </span>
      {!m.done && m.href && (
        <Link
          href={m.href}
          className="inline-flex items-center gap-1 text-[12px] font-semibold uppercase tracking-[0.1em] text-primary hover:text-medium"
        >
          {m.cta ?? "Go"} <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      )}
      <span
        className={`ml-1 flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
          m.done ? "bg-transparent text-charcoal/30" : "bg-ice text-navy"
        }`}
      >
        +{m.xp}
      </span>
    </li>
  );
}

function Celebration({ kind, label }: { kind: "level" | "mission"; label: string }) {
  const isLevel = kind === "level";
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <style>{`@keyframes omfall{0%{transform:translateY(-10px) rotate(0);opacity:1}100%{transform:translateY(120px) rotate(320deg);opacity:0}}@keyframes ompop{0%{transform:translateY(12px) scale(.9);opacity:0}12%{transform:translateY(0) scale(1);opacity:1}88%{transform:translateY(0) scale(1);opacity:1}100%{transform:translateY(8px) scale(.98);opacity:0}}`}</style>
      <div
        className={`relative overflow-hidden rounded-2xl px-6 py-3.5 shadow-2xl ${
          isLevel ? "bg-navy text-white ring-1 ring-gold-light/40" : "bg-white text-navy ring-1 ring-[#E7E4DD]"
        }`}
        style={{ animation: "ompop 1.6s ease-in-out forwards" }}
      >
        {isLevel &&
          Array.from({ length: 14 }).map((_, i) => (
            <span
              key={i}
              className="absolute top-0 h-2 w-2 rounded-sm"
              style={{
                left: `${(i * 7 + 6) % 100}%`,
                background: ["#c6a667", "#e6c78a", "#ffffff", "#F5A623"][i % 4],
                animation: `omfall 1.5s ${i * 60}ms ease-in forwards`,
              }}
            />
          ))}
        <div className="relative flex items-center gap-2.5">
          <span className={`grid h-8 w-8 place-items-center rounded-full ${isLevel ? "bg-gold-light/20 text-gold-light" : "bg-ice text-primary"}`}>
            {isLevel ? <Trophy className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
          </span>
          <div className="leading-tight">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] opacity-70">
              {isLevel ? "Rank Up" : "Nice work"}
            </p>
            <p className="font-serif text-base font-bold">{isLevel ? label : label}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <section className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="h-40 animate-pulse rounded-2xl bg-navy/90" />
        <div className="h-40 animate-pulse rounded-2xl border border-[#E7E4DD] bg-offwhite/70" />
      </div>
      <div className="h-56 animate-pulse rounded-2xl border border-[#E7E4DD] bg-offwhite/70" />
    </section>
  );
}
