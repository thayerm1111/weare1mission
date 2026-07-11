import type { ReactNode } from "react";

/**
 * Hero — reusable page header for inner pages (navy gradient band).
 */
interface Props {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode; // buttons / extra content
}

export function Hero({ eyebrow, title, description, children }: Props) {
  return (
    <section className="relative overflow-hidden bg-gradient-hero">
      <div className="pointer-events-none absolute inset-0 opacity-60" aria-hidden="true">
        <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-primary/30 blur-3xl" />
        <div className="absolute right-0 top-0 h-80 w-80 rounded-full bg-medium/20 blur-3xl" />
      </div>
      <div className="container-1m relative py-16 sm:py-20 lg:py-24">
        <div className="max-w-3xl animate-fade-up">
          {eyebrow && <span className="eyebrow text-light">{eyebrow}</span>}
          <h1 className="mt-3 text-4xl font-bold leading-[1.05] tracking-tight text-white text-balance sm:text-5xl lg:text-6xl">
            {title}
          </h1>
          {description && (
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-light">{description}</p>
          )}
          {children && <div className="mt-8 flex flex-wrap items-center gap-3">{children}</div>}
        </div>
      </div>
    </section>
  );
}
