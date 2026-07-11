"use client";

import { useMemo, useState } from "react";
import { GraduationCap, RotateCcw } from "lucide-react";
import { trainingModules, trainingCategories } from "@/data/training";
import { useProgress } from "@/lib/useProgress";
import { ProgressBar } from "@/components/ProgressBar";
import { TrainingModule } from "@/components/TrainingModule";
import { EmptyState } from "@/components/EmptyState";

const STORAGE_KEY = "1m_training_v1";

export function TrainingClient() {
  const modules = trainingModules;
  const { completed, hydrated, toggle, reset, count, percent } = useProgress(STORAGE_KEY, modules.length);
  const [category, setCategory] = useState<string>("All");
  const [openId, setOpenId] = useState<string | null>(modules[0]?.id ?? null);

  // Only show categories that actually have modules.
  const usedCategories = useMemo(
    () => ["All", ...trainingCategories.filter((c) => modules.some((m) => m.category === c))],
    [modules]
  );

  const filtered = useMemo(
    () => (category === "All" ? modules : modules.filter((m) => m.category === category)),
    [modules, category]
  );

  // Per-category progress for the current filter.
  const categoryProgress = useMemo(() => {
    if (category === "All") return null;
    const inCat = modules.filter((m) => m.category === category);
    const done = inCat.filter((m) => completed.has(m.id)).length;
    return { done, total: inCat.length };
  }, [category, modules, completed]);

  const firstIncomplete = modules.find((m) => !completed.has(m.id));

  return (
    <div className="container-1m py-12 lg:py-16">
      {/* Progress dashboard */}
      <div className="rounded-2xl border border-ice bg-white p-6 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-primary text-white" aria-hidden="true">
              <GraduationCap className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-bold text-navy">Overall Training Progress</h2>
              <p className="text-sm text-charcoal/60">
                {hydrated ? `${count} of ${modules.length} modules completed` : "Loading your progress…"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {firstIncomplete && (
              <button
                onClick={() => { setCategory("All"); setOpenId(firstIncomplete.id); document.getElementById(`module-btn-${firstIncomplete.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }}
                className="hidden rounded-full bg-gradient-primary px-5 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(26,22,16,0.20)] hover:-translate-y-0.5 sm:inline-flex"
              >
                Continue Training
              </button>
            )}
            <div className="text-right">
              <div className="text-3xl font-black text-primary">{hydrated ? percent : 0}%</div>
              <div className="text-xs text-charcoal/50">complete</div>
            </div>
            <button onClick={reset} className="inline-flex items-center gap-1.5 rounded-full border border-ice px-3.5 py-2 text-sm font-medium text-charcoal/70 hover:border-red-300 hover:text-red-600 focus-ring">
              <RotateCcw className="h-4 w-4" aria-hidden="true" /> Reset
            </button>
          </div>
        </div>
        <div className="mt-5"><ProgressBar percent={hydrated ? percent : 0} /></div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[240px_1fr]">
        {/* Category sidebar */}
        <nav aria-label="Training categories" className="lg:sticky lg:top-24 lg:self-start">
          <p className="mb-2 px-1 text-xs font-bold uppercase tracking-wider text-charcoal/50">Categories</p>
          <ul className="flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0">
            {usedCategories.map((c) => {
              const isActive = c === category;
              return (
                <li key={c} className="flex-shrink-0">
                  <button
                    onClick={() => setCategory(c)}
                    aria-pressed={isActive}
                    className={`whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors focus-ring lg:w-full ${
                      isActive ? "bg-ice text-primary" : "text-charcoal/75 hover:bg-offwhite"
                    }`}
                  >
                    {c}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Modules */}
        <div>
          {categoryProgress && (
            <div className="mb-5">
              <ProgressBar percent={Math.round((categoryProgress.done / categoryProgress.total) * 100)} label={`${category} progress`} />
            </div>
          )}
          <div className="space-y-3">
            {filtered.length === 0 ? (
              <EmptyState title="No modules here yet" message="Add modules to this category in src/data/training.ts." />
            ) : (
              filtered.map((m, i) => (
                <TrainingModule
                  key={m.id}
                  module={m}
                  index={i + 1}
                  open={openId === m.id}
                  completed={completed.has(m.id)}
                  onToggleOpen={() => setOpenId(openId === m.id ? null : m.id)}
                  onToggleComplete={() => toggle(m.id)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
