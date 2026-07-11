"use client";

import { useEffect, useState } from "react";
import { MapPin, Calendar, Clock, Users } from "lucide-react";
import type { CommunityEvent } from "@/data/events";
import { PlaceholderImage } from "./PlaceholderImage";

const statusStyles: Record<string, string> = {
  "Registration Open": "bg-emerald-100 text-emerald-700",
  "Coming Soon": "bg-medium/15 text-medium",
  "Sold Out": "bg-red-100 text-red-700",
  Completed: "bg-charcoal/10 text-charcoal/70",
};

function useCountdown(target: string) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return null;
  const diff = new Date(target).getTime() - now;
  if (diff <= 0) return null;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return { days, hours, mins };
}

export function EventCard({ event, featured = false }: { event: CommunityEvent; featured?: boolean }) {
  const countdown = useCountdown(event.startDate);
  const showCountdown = event.status !== "Completed" && countdown;

  return (
    <article
      className={`group flex flex-col overflow-hidden rounded-2xl border border-ice bg-white shadow-card transition-shadow hover:shadow-cardhover ${
        featured ? "lg:flex-row" : ""
      }`}
    >
      <div className={featured ? "lg:w-1/2" : ""}>
        <PlaceholderImage
          label={event.name}
          aspect={featured ? "wide" : "video"}
          rounded="rounded-none"
          className="h-full"
        />
      </div>
      <div className={`flex flex-1 flex-col p-6 ${featured ? "lg:p-8" : ""}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusStyles[event.status]}`}>
            {event.status}
          </span>
          <span className="rounded-full bg-ice px-2.5 py-0.5 text-xs font-semibold text-navy">
            {event.type}
          </span>
        </div>

        <h3 className={`mt-3 font-bold text-navy ${featured ? "text-2xl" : "text-lg"}`}>
          {event.name}
        </h3>

        <div className="mt-3 space-y-1.5 text-sm text-charcoal/70">
          <p className="flex items-center gap-2"><Calendar className="h-4 w-4 text-medium" aria-hidden="true" /> {event.displayDate}</p>
          <p className="flex items-center gap-2"><Clock className="h-4 w-4 text-medium" aria-hidden="true" /> {event.time}</p>
          <p className="flex items-center gap-2"><MapPin className="h-4 w-4 text-medium" aria-hidden="true" /> {event.location}</p>
          {event.capacity && (
            <p className="flex items-center gap-2"><Users className="h-4 w-4 text-medium" aria-hidden="true" /> Capacity: {event.capacity}</p>
          )}
        </div>

        <p className="mt-3 flex-1 text-sm leading-relaxed text-charcoal/70">{event.description}</p>

        {showCountdown && countdown && (
          <div className="mt-4 flex gap-2" aria-label="Time until event">
            {[
              { v: countdown.days, l: "days" },
              { v: countdown.hours, l: "hrs" },
              { v: countdown.mins, l: "min" },
            ].map((u) => (
              <div key={u.l} className="rounded-lg bg-ice px-3 py-1.5 text-center">
                <div className="text-base font-bold text-navy">{u.v}</div>
                <div className="text-[10px] uppercase tracking-wide text-charcoal/50">{u.l}</div>
              </div>
            ))}
          </div>
        )}

        {event.speakers?.length > 0 && (
          <p className="mt-4 text-xs text-charcoal/60">
            <span className="font-semibold text-navy">Speakers:</span> {event.speakers.join(", ")}
          </p>
        )}

        {event.registrationLink && event.status !== "Completed" && (
          <a
            href={event.registrationLink}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 inline-flex w-fit items-center justify-center rounded-full bg-gradient-primary px-6 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(26,22,16,0.20)] transition-transform hover:-translate-y-0.5"
          >
            {event.status === "Coming Soon" ? "Get Notified" : "Register"}
          </a>
        )}
      </div>
    </article>
  );
}
