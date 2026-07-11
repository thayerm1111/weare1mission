"use client";

import { Check, ChevronLeft, ChevronRight, CircleCheck } from "lucide-react";
import type { OnboardingStepData } from "@/data/onboarding";
import { VideoEmbed } from "./VideoEmbed";
import { PlaceholderImage } from "./PlaceholderImage";
import { ExternalLinkButton } from "./ExternalLinkButton";

interface Props {
  data: OnboardingStepData;
  total: number;
  completed: boolean;
  onToggle: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}

export function OnboardingStep({ data, total, completed, onToggle, onPrev, onNext }: Props) {
  return (
    <div className="rounded-2xl border border-ice bg-white p-6 shadow-card sm:p-8">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-ice px-3 py-1 text-xs font-semibold uppercase tracking-wide text-primary">
          {data.phase}
        </span>
        <span className="text-xs font-medium text-charcoal/50">
          Step {data.step} of {total}
        </span>
        {completed && (
          <span className="ml-auto inline-flex items-center gap-1 text-sm font-semibold text-emerald-600">
            <CircleCheck className="h-4 w-4" aria-hidden="true" /> Completed
          </span>
        )}
      </div>

      <h2 className="mt-4 text-2xl font-bold text-navy">{data.title}</h2>
      <p className="mt-2 leading-relaxed text-charcoal/75">{data.description}</p>

      {data.videoUrl !== undefined && data.videoUrl !== "" && (
        <div className="mt-5"><VideoEmbed url={data.videoUrl} title={data.title} /></div>
      )}
      {data.imageUrl && (
        <div className="mt-5"><PlaceholderImage label={data.title} aspect="wide" /></div>
      )}

      {data.checklist && data.checklist.length > 0 && (
        <ul className="mt-5 space-y-2" aria-label="Checklist">
          {data.checklist.map((item, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm text-charcoal/80">
              <span className="mt-0.5 grid h-4 w-4 flex-shrink-0 place-items-center rounded-full border border-medium/50 text-medium" aria-hidden="true">
                <Check className="h-2.5 w-2.5" />
              </span>
              {item}
            </li>
          ))}
        </ul>
      )}

      {data.externalLink && (
        <div className="mt-5">
          <ExternalLinkButton href={data.externalLink.href}>{data.externalLink.label}</ExternalLinkButton>
        </div>
      )}

      <div className="mt-7 flex flex-col gap-3 border-t border-ice pt-5 sm:flex-row sm:items-center">
        <button
          onClick={onToggle}
          className={`inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition-all focus-ring ${
            completed
              ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
              : "bg-gradient-primary text-white shadow-[0_8px_24px_rgba(26,22,16,0.20)] hover:-translate-y-0.5"
          }`}
          aria-pressed={completed}
        >
          <Check className="h-4 w-4" aria-hidden="true" />
          {completed ? "Completed — undo" : "Mark Complete"}
        </button>

        <div className="flex gap-2 sm:ml-auto">
          <button
            onClick={onPrev}
            disabled={!onPrev}
            className="inline-flex items-center gap-1 rounded-full border border-ice px-4 py-3 text-sm font-semibold text-navy transition-colors hover:bg-offwhite disabled:opacity-40 focus-ring"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
          </button>
          <button
            onClick={onNext}
            disabled={!onNext}
            className="inline-flex items-center gap-1 rounded-full border border-ice px-4 py-3 text-sm font-semibold text-navy transition-colors hover:bg-offwhite disabled:opacity-40 focus-ring"
          >
            Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
