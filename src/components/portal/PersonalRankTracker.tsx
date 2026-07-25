"use client";

import { useEffect, useState } from "react";
import { Trophy, Pencil, Check, X, ArrowRight, Info } from "lucide-react";
import { computeRank, type BuilderStats } from "@/data/coneqtx";

const STORAGE_KEY = "coneqtx_stats";
const money = (n: number) => "$" + Math.round(n).toLocaleString();
const num = (n: number) => Math.round(n).toLocaleString();

const EMPTY: BuilderStats = { personals: 0, leftVol: 0, rightVol: 0 };

/**
 * Personal rank tracker. Runs on numbers the builder enters (persisted locally)
 * and computes rank + progress from the real ConeqtX comp plan. When a ConeqtX
 * data feed is connected, swap the localStorage source for the API — the UI and
 * rank math stay exactly the same.
 */
export function PersonalRankTracker() {
  const [stats, setStats] = useState<BuilderStats>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<BuilderStats>(EMPTY);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        setStats({
          personals: Number(p.personals) || 0,
          leftVol: Number(p.leftVol) || 0,
          rightVol: Number(p.rightVol) || 0,
        });
      }
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);

  const rp = computeRank(stats);
  const hasData = stats.personals > 0 || stats.leftVol > 0 || stats.rightVol > 0;

  const openEditor = () => { setDraft(stats); setEditing(true); };
  const save = () => {
    const clean: BuilderStats = {
      personals: Math.max(0, Math.floor(draft.personals) || 0),
      leftVol: Math.max(0, Math.floor(draft.leftVol) || 0),
      rightVol: Math.max(0, Math.floor(draft.rightVol) || 0),
    };
    setStats(clean);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(clean)); } catch { /* ignore */ }
    setEditing(false);
  };

  return (
    <section className="overflow-hidden rounded-2xl bg-navy text-white">
      <div className="flex items-center justify-between border-b border-white/10 px-6 py-4 sm:px-8">
        <span className="eyebrow inline-flex items-center gap-2 text-gold-light">
          <Trophy className="h-3.5 w-3.5" aria-hidden="true" /> Your Rank
        </span>
        {!editing && (
          <button
            type="button"
            onClick={openEditor}
            className="inline-flex items-center gap-1.5 rounded-none border border-white/25 px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-white transition-colors hover:bg-white/10"
          >
            <Pencil className="h-3 w-3" aria-hidden="true" /> {hasData ? "Update numbers" : "Enter numbers"}
          </button>
        )}
      </div>

      {editing ? (
        <div className="px-6 py-6 sm:px-8">
          <p className="text-sm text-light/70">Enter your current ConeqtX numbers. Saved on this device.</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {([
              ["Personally enrolled", "personals"],
              ["Left leg volume", "leftVol"],
              ["Right leg volume", "rightVol"],
            ] as const).map(([label, key]) => (
              <label key={key} className="block">
                <span className="text-[11px] uppercase tracking-[0.1em] text-light/60">{label}</span>
                <input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={draft[key] === 0 ? "" : draft[key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))}
                  placeholder="0"
                  className="mt-1.5 w-full rounded-none border border-white/20 bg-white/5 px-3 py-2.5 text-white placeholder:text-light/30 focus:border-gold-light focus:outline-none"
                />
              </label>
            ))}
          </div>
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={save}
              className="inline-flex items-center gap-2 rounded-none bg-white px-6 py-2.5 text-[12px] font-medium uppercase tracking-[0.12em] text-navy transition-colors hover:bg-ice"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" /> Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="inline-flex items-center gap-2 rounded-none border border-white/25 px-6 py-2.5 text-[12px] font-medium uppercase tracking-[0.12em] text-white transition-colors hover:bg-white/10"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" /> Cancel
            </button>
          </div>
        </div>
      ) : !loaded ? (
        <div className="px-6 py-8 sm:px-8"><p className="text-light/50">Loading…</p></div>
      ) : (
        <div className="px-6 py-6 sm:px-8">
          {/* Current rank + pay */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.1em] text-light/50">
                {rp.current ? "Current rank" : "Getting started"}
              </p>
              <p className="mt-1 font-serif text-3xl font-semibold uppercase tracking-[0.02em] text-gold-light sm:text-4xl">
                {rp.current ? rp.current.name : "Not yet ranked"}
              </p>
            </div>
            {rp.current && (
              <div className="flex gap-6 text-right">
                <div>
                  <p className="font-serif text-2xl font-bold tabular-nums">{money(rp.current.weeklyPay)}</p>
                  <p className="text-[11px] uppercase tracking-[0.1em] text-light/50">Max / week</p>
                </div>
                <div>
                  <p className="font-serif text-2xl font-bold tabular-nums text-gold-light">{money(rp.current.monthlyTotal)}</p>
                  <p className="text-[11px] uppercase tracking-[0.1em] text-light/50">Max / month</p>
                </div>
              </div>
            )}
          </div>

          {/* Progress to next */}
          {rp.next && (
            <div className="mt-6">
              <div className="flex items-center justify-between text-sm">
                <span className="text-light/70">
                  Next: <span className="font-semibold text-white">{rp.next.name}</span>
                </span>
                <span className="tabular-nums text-light/60">{Math.round(rp.progress * 100)}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-gold-light transition-all" style={{ width: `${Math.max(3, rp.progress * 100)}%` }} />
              </div>
              {rp.gapLabel && (
                <p className="mt-2 flex items-center gap-1.5 text-sm text-light/70">
                  <ArrowRight className="h-3.5 w-3.5 text-gold-light" aria-hidden="true" /> {rp.gapLabel}
                </p>
              )}
            </div>
          )}

          {/* Leg volumes */}
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <Stat label="Personally enrolled" value={num(stats.personals)} />
            <Stat label="Left leg volume" value={num(stats.leftVol)} />
            <Stat label="Right leg volume" value={num(stats.rightVol)} />
          </div>

          <p className="mt-5 flex items-start gap-2 text-xs text-light/45">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            You&apos;re entering these numbers manually for now. Once your ConeqtX back office is connected, this tracker
            updates automatically from your real volume.
          </p>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <p className="text-[11px] uppercase tracking-[0.1em] text-light/50">{label}</p>
      <p className="mt-0.5 font-serif text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}
