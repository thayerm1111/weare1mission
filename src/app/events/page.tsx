import { Hero } from "@/components/Hero";
import { EventCard } from "@/components/EventCard";
import { SectionHeading } from "@/components/SectionHeading";
import { PlaceholderImage } from "@/components/PlaceholderImage";
import { events, pastEventGallery } from "@/data/events";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "Events",
  description:
    "Upcoming 1 Mission events: conventions, leadership retreats, local meetups, and online sessions. Register, add to your calendar, and never miss a gathering.",
  path: "/events",
});

export default function EventsPage() {
  const featured = events.find((e) => e.featured);
  const upcoming = events.filter((e) => e.status !== "Completed" && !e.featured);
  const online = events.filter((e) => e.type === "Online" && e.status !== "Completed");
  const local = events.filter((e) => e.type === "Local" && e.status !== "Completed");
  const retreats = events.filter((e) => e.type === "Leadership Retreat");
  const conventions = events.filter((e) => e.type === "Convention" && e.status !== "Completed");
  const past = events.filter((e) => e.status === "Completed");

  return (
    <>
      <Hero
        eyebrow="Events"
        title="Where the community comes together"
        description="From weekly online calls to conventions and retreats, our events are where momentum, connection, and growth happen. All details are editable placeholders until announced."
      />

      <div className="container-1m space-y-16 py-14 lg:py-20">
        {featured && (
          <section aria-labelledby="featured-heading">
            <SectionHeading align="left" eyebrow="Featured Event" title={<span id="featured-heading">Don&apos;t miss this one</span>} />
            <div className="mt-6"><EventCard event={featured} featured /></div>
          </section>
        )}

        <EventGroup id="upcoming" title="Upcoming Events" items={upcoming} />
        <EventGroup id="online" title="Online Events" items={online} />
        <EventGroup id="local" title="Local Events" items={local} />
        <EventGroup id="retreats" title="Leadership Retreats" items={retreats} />
        <EventGroup id="conventions" title="Conventions" items={conventions} />

        {/* Past event gallery */}
        <section aria-labelledby="gallery-heading">
          <SectionHeading align="left" eyebrow="Memories" title={<span id="gallery-heading">Past Event Gallery</span>} description="Replace these placeholders with real photos from your gatherings." />
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {pastEventGallery.map((g) => (
              <figure key={g.id}>
                <PlaceholderImage label={g.caption} aspect="square" />
              </figure>
            ))}
          </div>
        </section>

        {past.length > 0 && <EventGroup id="past" title="Past Events" items={past} />}
      </div>
    </>
  );
}

function EventGroup({ id, title, items }: { id: string; title: string; items: typeof events }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={`${id}-heading`}>
      <SectionHeading align="left" title={<span id={`${id}-heading`}>{title}</span>} />
      <div className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {items.map((e) => <EventCard key={e.id} event={e} />)}
      </div>
    </section>
  );
}
