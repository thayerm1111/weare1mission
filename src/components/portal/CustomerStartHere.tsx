"use client";

/**
 * CustomerStartHere — the customer/trader onboarding experience for The Ones.
 *
 * A friendly, guided flow: welcome, get connected, set up the ConeqtX app +
 * Tap to Trade + broker, go live with MFX, learn risk & basics, journal trades,
 * and tour the platform. Progress saves on-device via useProgress. Includes a
 * built-in Trade Journal tab.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2, Circle, ChevronDown, RotateCcw, ExternalLink, Clock,
  ArrowRight, ListChecks, NotebookPen, Rocket, Sparkles,
} from "lucide-react";
import {
  customerOnboardingSteps, customerSections, platformTour,
  type CustomerStep,
} from "@/data/customerOnboarding";
import { useProgress } from "@/lib/useProgress";
import { ProgressBar } from "@/components/ProgressBar";
import { TradeJournal } from "@/components/portal/TradeJournal";

const STORAGE_KEY = "1m_customer_onboarding_v1";

type Tab = "start" | "journal";

export function CustomerStartHere() {
  const steps = customerOnboardingSteps;
  const { completed, hydrated, setComplete, reset, count, percent } = useProgress(STORAGE_KEY, steps.length);
  const [tab, setTab] = useState<Tab>("start");
  const [openId, setOpenId] = useState<string | null>(steps[0]?.id ?? null);
  const [confirmReset, setConfirmReset] = useState(false);

  const grouped = useMemo(
    () =>
      customerSections.map((section) => ({
        section,
        items: steps.filter((s) => s.section === section),
      })),
    [steps]
  );

  const allDone = hydrated && percent === 100;

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex gap-1 rounded-full border border-ice bg-white p-1 shadow-card sm:w-fit">
        <TabButton active={tab === "start"} onClick={() => setTab("start")} icon={Rocket} label="Get Started" />
        <TabButton active={tab === "journal"} onClick={() => setTab("journal")} icon={NotebookPen} label="Trade Journal" />
      </div>

      {tab === "journal" ? (
        <TradeJournal />
      ) : (
        <>
          {/* Progress summary */}
          <div className="rounded-2xl border border-ice bg-white p-5 shadow-card sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-navy text-cream" aria-hidden="true">
                  <ListChecks className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="text-lg font-bold text-navy">Your setup progress</h2>
                  <p className="text-sm text-charcoal/60">
                    {hydrated ? `${count} of ${steps.length} steps complete` : "Loading your progress…"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="text-3xl font-black text-primary">{hydrated ? percent : 0}%</div>
                  <div className="text-xs text-charcoal/50">done</div>
                </div>
                {count > 0 && (
                  <button
                    onClick={() => setConfirmReset(true)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-ice px-3.5 py-2 text-sm font-medium text-charcoal/70 hover:border-red-300 hover:text-red-600 focus-ring"
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" /> Reset
                  </button>
                )}
              </div>
            </div>
            <div className="mt-5">
              <ProgressBar percent={hydrated ? percent : 0} />
            </div>
            {allDone && (
              <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" /> You&apos;re all set up — welcome to the Mission. Now go trade smart.
              </div>
            )}
          </div>

          {/* Sections & steps */}
          <div className="space-y-8">
            {grouped.map(({ section, items }, si) => (
              <section key={section}>
                <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-charcoal/50">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-navy text-[10px] text-cream">{si + 1}</span>
                  {section}
                </p>
                <div className="space-y-3">
                  {items.map((step) => (
                    <StepCard
                      key={step.id}
                      step={step}
                      done={completed.has(step.id)}
                      open={openId === step.id}
                      onToggleOpen={() => setOpenId((cur) => (cur === step.id ? null : step.id))}
                      onToggleDone={(v) => setComplete(step.id, v)}
                      onOpenJournal={() => setTab("journal")}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>

          {/* Platform tour grid */}
          <section aria-labelledby="tour-heading" className="rounded-2xl border border-ice bg-offwhite/50 p-5 sm:p-6">
            <h2 id="tour-heading" className="flex items-center gap-2 text-lg font-bold text-navy">
              <Sparkles className="h-5 w-5 text-primary" aria-hidden="true" /> Your platform, at a glance
            </h2>
            <p className="mt-1 text-sm text-charcoal/60">Tap any area to jump straight in.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {platformTour.map((card) => {
                const Icon = card.icon;
                return (
                  <Link
                    key={card.href}
                    href={card.href}
                    className="group flex flex-col rounded-2xl border border-ice bg-white p-4 shadow-card transition-shadow hover:shadow-cardhover focus-ring"
                  >
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-ice text-primary transition-colors group-hover:bg-primary group-hover:text-cream" aria-hidden="true">
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="mt-3 flex items-center gap-1 font-bold text-navy">
                      {card.label}
                      <ArrowRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                    </span>
                    <span className="mt-1 text-sm text-charcoal/60">{card.blurb}</span>
                  </Link>
                );
              })}
            </div>
          </section>

          <p className="text-center text-xs text-charcoal/45">
            Your progress is saved on this device. Always confirm the latest links in the announcements channel.
          </p>
        </>
      )}

      {/* Reset confirmation */}
      {confirmReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="reset-title">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <h3 id="reset-title" className="text-lg font-bold text-navy">Reset your progress?</h3>
            <p className="mt-2 text-sm text-charcoal/70">
              This clears all completed steps on this device. Your trade journal is not affected.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmReset(false)} className="rounded-full px-4 py-2 text-sm font-semibold text-navy hover:bg-offwhite focus-ring">
                Cancel
              </button>
              <button
                onClick={() => { reset(); setConfirmReset(false); setOpenId(steps[0]?.id ?? null); }}
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

function TabButton({
  active, onClick, icon: Icon, label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Rocket;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex flex-1 items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition-colors focus-ring sm:flex-none ${
        active ? "bg-primary text-cream" : "text-charcoal/55 hover:text-charcoal"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" /> {label}
    </button>
  );
}

function StepCard({
  step, done, open, onToggleOpen, onToggleDone, onOpenJournal,
}: {
  step: CustomerStep;
  done: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onToggleDone: (v: boolean) => void;
  onOpenJournal: () => void;
}) {
  const Icon = step.icon;
  const isJournalStep = step.id === "trade-journal";
  return (
    <div className={`overflow-hidden rounded-2xl border bg-white shadow-card transition-colors ${done ? "border-emerald-200" : "border-ice"}`}>
      {/* Header row */}
      <div className="flex items-center gap-3 p-4">
        {/* Complete toggle */}
        <button
          onClick={() => onToggleDone(!done)}
          className="flex-shrink-0 focus-ring rounded-full"
          aria-pressed={done}
          aria-label={done ? `Mark "${step.title}" not done` : `Mark "${step.title}" done`}
        >
          {done ? (
            <CheckCircle2 className="h-6 w-6 text-emerald-500" />
          ) : (
            <Circle className="h-6 w-6 text-charcoal/25 hover:text-primary" />
          )}
        </button>

        {/* Title (click to expand) */}
        <button onClick={onToggleOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left focus-ring rounded-lg" aria-expanded={open}>
          <span className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl ${done ? "bg-emerald-50 text-emerald-600" : "bg-ice text-primary"}`} aria-hidden="true">
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className={`block font-bold ${done ? "text-charcoal/60" : "text-navy"}`}>{step.title}</span>
            <span className="block truncate text-sm text-charcoal/55">{step.summary}</span>
          </span>
        </button>

        <button onClick={onToggleOpen} className="flex-shrink-0 rounded-full p-1.5 text-charcoal/40 hover:bg-offwhite focus-ring" aria-label={open ? "Collapse" : "Expand"}>
          <ChevronDown className={`h-5 w-5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* Expanded content */}
      {open && (
        <div className="border-t border-ice px-4 pb-5 pt-4 sm:px-5">
          <div className="space-y-4 pl-0 sm:pl-12">
            {step.blocks.map((block, bi) => (
              <div key={bi}>
                {block.heading && (
                  <h4 className="mb-1.5 text-sm font-bold uppercase tracking-wide text-charcoal/70">{block.heading}</h4>
                )}
                {block.body?.map((p, pi) => (
                  <p key={pi} className="mb-2 text-[15px] leading-relaxed text-charcoal/80">{p}</p>
                ))}
                {block.points && (
                  <ul className="mt-1 space-y-1.5">
                    {block.points.map((pt, pti) => (
                      <li key={pti} className="flex gap-2 text-[15px] leading-relaxed text-charcoal/80">
                        <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary/40" aria-hidden="true" />
                        <span>{pt}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}

            {/* Links */}
            {step.links && step.links.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {step.links.map((link) =>
                  link.placeholder ? (
                    <span
                      key={link.label}
                      className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[#E7E4DD] bg-offwhite px-3.5 py-2 text-sm font-medium text-charcoal/45"
                      title="Coming soon — your team will share this"
                    >
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {link.label}
                    </span>
                  ) : (
                    <Link
                      key={link.label}
                      href={link.href}
                      className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-sm font-semibold text-cream transition-colors hover:bg-navy focus-ring"
                    >
                      {link.label}
                      {link.external ? <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> : <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />}
                    </Link>
                  )
                )}
                {isJournalStep && (
                  <button
                    onClick={onOpenJournal}
                    className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-sm font-semibold text-cream transition-colors hover:bg-navy focus-ring"
                  >
                    <NotebookPen className="h-3.5 w-3.5" aria-hidden="true" /> Open the Trade Journal
                  </button>
                )}
              </div>
            )}

            {/* Note */}
            {step.note && (
              <p className="rounded-xl bg-offwhite px-3.5 py-2.5 text-[13px] leading-relaxed text-charcoal/60">
                {step.note}
              </p>
            )}

            {/* Checklist + done */}
            <div className="rounded-xl border border-ice bg-offwhite/40 p-3.5">
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-charcoal/50">Done when</p>
              <ul className="space-y-1">
                {step.checklist.map((c, ci) => (
                  <li key={ci} className="flex items-center gap-2 text-sm text-charcoal/75">
                    <CheckCircle2 className={`h-4 w-4 flex-shrink-0 ${done ? "text-emerald-500" : "text-charcoal/25"}`} aria-hidden="true" />
                    {c}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => onToggleDone(!done)}
                className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors focus-ring ${
                  done
                    ? "border border-ice text-charcoal/60 hover:bg-white"
                    : "bg-emerald-500 text-white hover:bg-emerald-600"
                }`}
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                {done ? "Completed — mark as not done" : "Mark this step complete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
