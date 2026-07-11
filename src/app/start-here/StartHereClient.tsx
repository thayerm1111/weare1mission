"use client";

import { useMemo, useState } from "react";
import { RotateCcw, CheckCircle2, ListChecks } from "lucide-react";
import { onboardingSteps, onboardingPhases } from "@/data/onboarding";
import { useProgress } from "@/lib/useProgress";
import { ProgressBar } from "@/components/ProgressBar";
import { OnboardingStep } from "@/components/OnboardingStep";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";

const STORAGE_KEY = "1m_onboarding_v1";

export function StartHereClient() {
  const steps = onboardingSteps;
  const { completed, hydrated, toggle, reset, count, percent } = useProgress(STORAGE_KEY, steps.length);
  const [activeIndex, setActiveIndex] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);

  const active = steps[activeIndex];
  const currentPhase = active?.phase;

  // Group steps by phase for the sidebar.
  const grouped = useMemo(() => {
    return onboardingPhases.map((phase) => ({
      phase,
      items: steps.map((s, i) => ({ s, i })).filter(({ s }) => s.phase === phase),
    }));
  }, [steps]);

  return (
    <div className="container-1m py-12 lg:py-16">
      {/* Progress summary */}
      <div className="rounded-2xl border border-ice bg-white p-6 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-primary text-white" aria-hidden="true">
              <ListChecks className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-bold text-navy">Your Onboarding Progress</h2>
              <p className="text-sm text-charcoal/60">
                {hydrated ? `${count} of ${steps.length} steps · Current phase: ${currentPhase}` : "Loading your progress…"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-3xl font-black text-primary">{hydrated ? percent : 0}%</div>
              <div className="text-xs text-charcoal/50">complete</div>
            </div>
            <button
              onClick={() => setConfirmReset(true)}
              className="inline-flex items-center gap-1.5 rounded-full border border-ice px-3.5 py-2 text-sm font-medium text-charcoal/70 hover:border-red-300 hover:text-red-600 focus-ring"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" /> Reset
            </button>
          </div>
        </div>
        <div className="mt-5">
          <ProgressBar percent={hydrated ? percent : 0} />
        </div>
        {hydrated && percent === 100 && (
          <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" /> You&apos;ve completed onboarding — welcome to 1 Mission!
          </div>
        )}
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[300px_1fr]">
        {/* Phase sidebar */}
        <nav aria-label="Onboarding phases" className="lg:sticky lg:top-24 lg:self-start">
          <ol className="space-y-5">
            {grouped.map(({ phase, items }, pi) => (
              <li key={phase}>
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-charcoal/50">
                  Phase {pi + 1}: {phase}
                </p>
                <ul className="space-y-1">
                  {items.map(({ s, i }) => {
                    const done = completed.has(s.id);
                    const isActive = i === activeIndex;
                    return (
                      <li key={s.id}>
                        <button
                          onClick={() => setActiveIndex(i)}
                          aria-current={isActive ? "step" : undefined}
                          className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors focus-ring ${
                            isActive ? "bg-ice font-semibold text-primary" : "text-charcoal/75 hover:bg-offwhite"
                          }`}
                        >
                          <span
                            className={`grid h-5 w-5 flex-shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                              done ? "bg-emerald-500 text-white" : isActive ? "bg-primary text-white" : "bg-ice text-charcoal/60"
                            }`}
                            aria-hidden="true"
                          >
                            {done ? "✓" : s.step}
                          </span>
                          <span className="line-clamp-1">{s.title}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>
        </nav>

        {/* Active step */}
        <div>
          {active && (
            <OnboardingStep
              data={active}
              total={steps.length}
              completed={completed.has(active.id)}
              onToggle={() => toggle(active.id)}
              onPrev={activeIndex > 0 ? () => setActiveIndex(activeIndex - 1) : undefined}
              onNext={activeIndex < steps.length - 1 ? () => setActiveIndex(activeIndex + 1) : undefined}
            />
          )}
          <div className="mt-6">
            <DisclaimerBanner>
              Your progress is saved on this device only. Clearing your browser data or switching
              devices will reset it. Always confirm the latest links in the Telegram announcement channel.
            </DisclaimerBanner>
          </div>
        </div>
      </div>

      {/* Reset confirmation */}
      {confirmReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="reset-title">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <h3 id="reset-title" className="text-lg font-bold text-navy">Reset your progress?</h3>
            <p className="mt-2 text-sm text-charcoal/70">
              This will clear all completed onboarding steps on this device. This cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmReset(false)} className="rounded-full px-4 py-2 text-sm font-semibold text-navy hover:bg-offwhite focus-ring">
                Cancel
              </button>
              <button
                onClick={() => { reset(); setConfirmReset(false); setActiveIndex(0); }}
                className="rounded-full bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 focus-ring"
              >
                Yes, reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
