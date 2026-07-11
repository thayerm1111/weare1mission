import { SectionHeading } from "../SectionHeading";
import { TestimonialCard } from "../TestimonialCard";
import { testimonials } from "@/data/testimonials";

export function Testimonials() {
  return (
    <section className="section bg-gradient-ice">
      <div className="container-1m">
        <SectionHeading
          eyebrow="From the Community"
          title="What members value most"
          description="Real growth is personal. These reflect what members say matters — community, confidence, and consistency."
        />
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {testimonials.map((t) => <TestimonialCard key={t.id} t={t} />)}
        </div>
        <p className="mt-6 text-center text-xs text-charcoal/50">
          Placeholder testimonials — replace with real, permission-granted quotes before launch. No income claims.
        </p>
      </div>
    </section>
  );
}
