"use client";

import { Video, Send, CalendarPlus, Lock, Globe } from "lucide-react";
import type { ScheduleEvent } from "@/data/schedule";
import { sourceTimeZone } from "@/data/schedule";
import { convertToLocal, googleCalendarUrl } from "@/lib/timezone";

const categoryColors: Record<string, string> = {
  Trading: "bg-primary/10 text-primary",
  Business: "bg-medium/10 text-medium",
  Leadership: "bg-navy/10 text-navy",
  Community: "bg-emerald-100 text-emerald-700",
};

export function ScheduleCard({ event, hydrated }: { event: ScheduleEvent; hydrated: boolean }) {
  const local = hydrated ? convertToLocal(event.day, event.time, sourceTimeZone) : null;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-ice bg-white p-5 shadow-card transition-shadow hover:shadow-cardhover">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${categoryColors[event.category]}`}>
              {event.category}
            </span>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-charcoal/60">
              {event.accessLevel === "Public" ? (
                <><Globe className="h-3 w-3" aria-hidden="true" /> Public</>
              ) : (
                <><Lock className="h-3 w-3" aria-hidden="true" /> Members</>
              )}
            </span>
          </div>
          <h3 className="mt-2 text-base font-bold text-navy">{event.title}</h3>
          <p className="text-sm text-charcoal/60">{event.speaker}</p>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold text-primary">
            {local ? local.localTime : "—"}
          </div>
          <div className="text-xs text-charcoal/50">
            {local ? "Your local time" : " "}
          </div>
        </div>
      </div>

      <p className="text-sm leading-relaxed text-charcoal/70">{event.description}</p>

      {event.isPlaceholder && (
        <span className="w-fit rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
          Editable placeholder event
        </span>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-3 border-t border-ice pt-3 text-sm">
        {event.zoomLink && (
          <a href={event.zoomLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-primary hover:text-medium">
            <Video className="h-4 w-4" aria-hidden="true" /> Join Zoom
          </a>
        )}
        {event.telegramLink && (
          <a href={event.telegramLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-navy hover:text-primary">
            <Send className="h-4 w-4" aria-hidden="true" /> Telegram
          </a>
        )}
        {event.registrationLink && (
          <a href={event.registrationLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-navy hover:text-primary">
            Register
          </a>
        )}
        <a
          href={googleCalendarUrl(event.title, event.description, event.day, event.time)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-semibold text-charcoal/70 hover:text-primary"
        >
          <CalendarPlus className="h-4 w-4" aria-hidden="true" /> Add to calendar
        </a>
      </div>
    </div>
  );
}
