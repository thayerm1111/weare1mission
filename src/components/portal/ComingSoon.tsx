import Link from "next/link";
import { Sparkles, ArrowLeft, Check, Clock, type LucideIcon } from "lucide-react";

/**
 * ComingSoon — a premium placeholder for features that aren't ready yet.
 * Used instead of exposing empty or half-built pages. Communicates intent,
 * value, and progress so the platform always feels finished.
 */
export function ComingSoon({
  eyebrow = "Coming Soon",
  title,
  description,
  icon: Icon = Sparkles,
  bullets = [],
  progress,
  progressLabel,
  backHref = "/portal",
  backLabel = "Back to Dashboard",
}: {
  eyebrow?: string;
  title: string;
  description: string;
  icon?: LucideIcon;
  bullets?: string[];
  progress?: number; // 0–100
  progressLabel?: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="relative overflow-hidden rounded-3xl border border-[#E7E4DD] bg-white p-8 shadow-card sm:p-12">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-gold-light/10 blur-3xl" />

        <span className="inline-flex items-center gap-2 rounded-full bg-navy px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-gold-light">
          <Clock className="h-3.5 w-3.5" /> {eyebrow}
        </span>

        <div className="mt-6 grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-navy to-[#1c2230] text-gold-light">
          <Icon className="h-8 w-8" />
        </div>

        <h1 className="mt-6 font-serif text-3xl font-semibold uppercase tracking-[0.01em] text-navy sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-charcoal/70">{description}</p>

        {bullets.length > 0 && (
          <ul className="mt-7 space-y-3">
            {bullets.map((b) => (
              <li key={b} className="flex items-start gap-3">
                <span className="mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-full bg-gold-light/15 text-gold-light">
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
                <span className="text-sm text-navy">{b}</span>
              </li>
            ))}
          </ul>
        )}

        {typeof progress === "number" && (
          <div className="mt-8">
            <div className="flex items-center justify-between text-[12px] font-medium text-charcoal/60">
              <span>{progressLabel ?? "In development"}</span>
              <span className="font-semibold text-navy">{Math.round(progress)}%</span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-ice">
              <div
                className="h-full rounded-full bg-gradient-to-r from-navy to-gold-light transition-[width] duration-700 ease-out"
                style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
              />
            </div>
          </div>
        )}

        <div className="mt-9">
          <Link
            href={backHref}
            className="inline-flex items-center gap-2 text-[13px] font-medium uppercase tracking-[0.12em] text-primary hover:text-medium"
          >
            <ArrowLeft className="h-4 w-4" /> {backLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}
