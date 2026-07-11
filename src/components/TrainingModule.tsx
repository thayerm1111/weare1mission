"use client";

import { ChevronDown, Check, Clock, Download, ArrowUpRight } from "lucide-react";
import type { TrainingModuleData } from "@/data/training";
import { VideoEmbed } from "./VideoEmbed";

interface Props {
  module: TrainingModuleData;
  index: number;
  open: boolean;
  completed: boolean;
  onToggleOpen: () => void;
  onToggleComplete: () => void;
}

export function TrainingModule({ module, index, open, completed, onToggleOpen, onToggleComplete }: Props) {
  const panelId = `module-panel-${module.id}`;
  const btnId = `module-btn-${module.id}`;
  return (
    <div className="overflow-hidden rounded-2xl border border-ice bg-white shadow-card">
      <h3>
        <button
          id={btnId}
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-offwhite focus-ring"
        >
          <span
            className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-full text-sm font-bold ${
              completed ? "bg-emerald-500 text-white" : "bg-ice text-primary"
            }`}
            aria-hidden="true"
          >
            {completed ? <Check className="h-4 w-4" /> : index}
          </span>
          <span className="flex-1">
            <span className="block text-sm font-bold text-navy sm:text-base">{module.title}</span>
            <span className="mt-0.5 block text-xs text-charcoal/60">{module.description}</span>
          </span>
          <span className="hidden items-center gap-1 text-xs font-medium text-charcoal/50 sm:flex">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {module.estimatedTime}
          </span>
          <ChevronDown className={`h-5 w-5 flex-shrink-0 text-charcoal/40 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      </h3>

      {open && (
        <div id={panelId} role="region" aria-labelledby={btnId} className="border-t border-ice px-5 py-5">
          {module.videoUrl !== undefined && module.videoUrl !== "" && (
            <div className="mb-5"><VideoEmbed url={module.videoUrl} title={module.title} /></div>
          )}

          <div className="space-y-3 text-sm leading-relaxed text-charcoal/80">
            {module.lesson.split("\n\n").map((p, i) => <p key={i}>{p}</p>)}
          </div>

          {module.actionSteps.length > 0 && (
            <div className="mt-5">
              <h4 className="text-xs font-bold uppercase tracking-wide text-primary">Action Steps</h4>
              <ol className="mt-2 space-y-1.5">
                {module.actionSteps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-charcoal/80">
                    <span className="mt-0.5 grid h-4 w-4 flex-shrink-0 place-items-center rounded-full bg-ice text-[10px] font-bold text-primary">{i + 1}</span>
                    {s}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {module.resources && module.resources.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-3">
              {module.resources.map((r) => (
                <a
                  key={r.label}
                  href={r.href}
                  {...(r.type === "link" && r.href !== "#" ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  className="inline-flex items-center gap-1.5 rounded-full border border-ice bg-offwhite px-3.5 py-1.5 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
                >
                  {r.type === "download" ? <Download className="h-3.5 w-3.5" aria-hidden="true" /> : <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />}
                  {r.label}
                </a>
              ))}
            </div>
          )}

          <button
            onClick={onToggleComplete}
            aria-pressed={completed}
            className={`mt-6 inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-all focus-ring ${
              completed ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "bg-gradient-primary text-white shadow-[0_8px_24px_rgba(26,22,16,0.20)] hover:-translate-y-0.5"
            }`}
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            {completed ? "Completed — undo" : "Mark Complete"}
          </button>
        </div>
      )}
    </div>
  );
}
