import type { ReactNode } from "react";

/**
 * Hero — reusable page header for inner pages (warm cream band, dark text).
 */
interface Props {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode; // buttons / extra content
}

export function Hero({ eyebrow, title, description, children }: Props) {
  return (
    <section className="relative overflow-hidden border-b border-[#E4DCCB] bg-gradient-hero">
      <div className="pointer-events-none absolute inset-0 opacity-50" aria-hidden="true">
        <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-medium/10 blur-3xl" />
        <div className="absolute right-0 top-0 h-80 w-80 rounded-full bg-light/30 blur-3xl" />
      </div>
      <div className="container-1m relative py-16 sm:py-20 lg:py-24">
        <div className="max-w-3xl animate-fade-up">
          {eyebrow && <span className="eyebrow text-medium">{eyebrow}</span>}
          <h1 className="mt-3 text-4xl font-bold leading-[1.05] tracking-tight text-navy text-balance sm:text-5xl lg:text-6xl">
            {title}
          </h1>
          {description && (
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-charcoal/70">{description}</p>
          )}
          {children && <div className="mt-8 flex flex-wrap items-center gap-3">{children}</div>}
        </div>
      </div>
    </section>
  );
}
