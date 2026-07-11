import { Hero } from "@/components/Hero";
import { ContactForm } from "@/components/ContactForm";
import { contactCards } from "@/data/contactInformation";
import { announcementChannel } from "@/data/socialLinks";
import { buildMetadata } from "@/lib/metadata";
import { User, LifeBuoy, Calendar, Wrench, Mail, Phone, Send } from "lucide-react";

export const metadata = buildMetadata({
  title: "Contact",
  description:
    "Get in touch with the 1 Mission team. Contact your mentor, general support, event questions, or technical support — or send us a message directly.",
  path: "/contact",
});

const iconMap = { user: User, "life-buoy": LifeBuoy, calendar: Calendar, wrench: Wrench } as const;

export default function ContactPage() {
  return (
    <>
      <Hero eyebrow="Contact" title="We're here to help" description="Reach the right person fast. Your mentor is always your best first point of contact — and the team is here for everything else." />

      <section className="section bg-white">
        <div className="container-1m grid gap-12 lg:grid-cols-[1fr_1.1fr]">
          {/* Contact cards */}
          <div>
            <h2 className="text-xl font-bold text-navy">How can we help?</h2>
            <p className="mt-2 text-sm text-charcoal/60">Contact details below are placeholders — update them in <code className="rounded bg-offwhite px-1">src/data/contactInformation.ts</code>.</p>
            <div className="mt-6 space-y-4">
              {contactCards.map((c) => {
                const Icon = iconMap[c.icon];
                return (
                  <div key={c.id} className="rounded-2xl border border-ice bg-white p-5 shadow-card">
                    <div className="flex items-start gap-3">
                      <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl bg-ice text-primary" aria-hidden="true">
                        <Icon className="h-5 w-5" />
                      </span>
                      <div>
                        <h3 className="text-base font-bold text-navy">{c.title}</h3>
                        <p className="mt-0.5 text-sm text-charcoal/70">{c.description}</p>
                        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                          <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1.5 text-primary hover:text-medium">
                            <Mail className="h-4 w-4" aria-hidden="true" /> {c.email}
                          </a>
                          <a href={`tel:${c.phone.replace(/[^+\d]/g, "")}`} className="inline-flex items-center gap-1.5 text-charcoal/70 hover:text-primary">
                            <Phone className="h-4 w-4" aria-hidden="true" /> {c.phone}
                          </a>
                          <span className="inline-flex items-center gap-1.5 text-charcoal/70">
                            <Send className="h-4 w-4" aria-hidden="true" /> {c.telegram}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <a href={announcementChannel.href} {...(announcementChannel.href !== "#" ? { target: "_blank", rel: "noopener noreferrer" } : {})} className="mt-6 flex items-center gap-3 rounded-2xl bg-gradient-navy p-5 text-white shadow-card">
              <Send className="h-6 w-6 flex-shrink-0" aria-hidden="true" />
              <div>
                <p className="font-semibold">Join the announcement channel</p>
                <p className="text-sm text-light/80">The single source of truth for schedules and links.</p>
              </div>
            </a>
          </div>

          {/* Form */}
          <div className="rounded-2xl border border-ice bg-offwhite p-6 shadow-card sm:p-8">
            <h2 className="text-xl font-bold text-navy">Send us a message</h2>
            <p className="mt-2 text-sm text-charcoal/70">Fill this out and the team will follow up.</p>
            <div className="mt-6"><ContactForm /></div>
          </div>
        </div>
      </section>
    </>
  );
}
