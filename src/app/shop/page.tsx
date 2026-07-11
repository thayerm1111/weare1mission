import { Hero } from "@/components/Hero";
import { SectionHeading } from "@/components/SectionHeading";
import { NewsletterForm } from "@/components/NewsletterForm";
import { Shirt, HardHat, Ticket, BookOpen, NotebookPen, Download, Megaphone } from "lucide-react";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "Shop — Coming Soon",
  description:
    "The 1 Mission shop is coming soon: apparel, hats, event merchandise, leadership materials, journals, and digital resources. Join the interest list to be notified first.",
  path: "/shop",
});

const categories = [
  { icon: Shirt, name: "1 Mission Apparel" },
  { icon: HardHat, name: "Hats" },
  { icon: Ticket, name: "Event Merchandise" },
  { icon: BookOpen, name: "Leadership Materials" },
  { icon: NotebookPen, name: "Journals" },
  { icon: Download, name: "Digital Resources" },
  { icon: Megaphone, name: "Social Media Services" },
];

const productOptions = categories.map((c) => c.name);

export default function ShopPage() {
  return (
    <>
      <Hero eyebrow="Shop" title="Something is coming" description="Premium 1 Mission gear and resources are on the way. Join the list and you'll be the first to know when the shop opens." />

      <section className="section bg-white">
        <div className="container-1m grid gap-12 lg:grid-cols-2">
          <div>
            <SectionHeading align="left" eyebrow="Coming Soon" title="Represent the movement" description="Here's a preview of what we're building. No payments are being processed yet." />
            <ul className="mt-8 grid gap-3 sm:grid-cols-2">
              {categories.map((c) => (
                <li key={c.name} className="flex items-center gap-3 rounded-xl border border-ice bg-offwhite p-4">
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-gradient-primary text-white" aria-hidden="true">
                    <c.icon className="h-5 w-5" />
                  </span>
                  <span className="text-sm font-semibold text-navy">{c.name}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-ice bg-gradient-ice p-6 shadow-card sm:p-8">
            <h2 className="text-xl font-bold text-navy">Get notified at launch</h2>
            <p className="mt-2 text-sm text-charcoal/70">Tell us what you&apos;re interested in and we&apos;ll reach out when it&apos;s ready.</p>
            <div className="mt-6">
              <NewsletterForm productOptions={productOptions} />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
