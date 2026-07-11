import { Quote } from "lucide-react";
import type { Testimonial } from "@/data/testimonials";

export function TestimonialCard({ t }: { t: Testimonial }) {
  return (
    <figure className="flex h-full flex-col rounded-2xl border border-ice bg-white p-6 shadow-card">
      <Quote className="h-7 w-7 text-light" aria-hidden="true" />
      <blockquote className="mt-3 flex-1 text-[15px] leading-relaxed text-charcoal/85">
        “{t.quote}”
      </blockquote>
      <figcaption className="mt-5 flex items-center gap-3 border-t border-ice pt-4">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-gradient-navy text-sm font-bold text-white" aria-hidden="true">
          {t.name.charAt(0)}
        </span>
        <span>
          <span className="block text-sm font-semibold text-navy">{t.name}</span>
          <span className="block text-xs text-charcoal/60">{t.role} · {t.location}</span>
        </span>
      </figcaption>
    </figure>
  );
}
