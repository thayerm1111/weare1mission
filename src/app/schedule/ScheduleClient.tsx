"use client";

import { useEffect, useMemo, useState } from "react";
import { Globe2 } from "lucide-react";
import { scheduleEvents, scheduleFilters, type ScheduleEvent } from "@/data/schedule";
import { getLocalTimeZone } from "@/lib/timezone";
import { ScheduleCard } from "@/components/ScheduleCard";
import { EmptyState } from "@/components/EmptyState";

const DAYS: ScheduleEvent["day"][] = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

export function ScheduleClient() {
  const [hydrated, setHydrated] = useState(false);
  const [tz, setTz] = useState("");
  const [filter, setFilter] = useState<string>("All Events");

  useEffect(() => {
    setTz(getLocalTimeZone());
    setHydrated(true);
  }, []);

  const filtered = useMemo(() => {
    if (filter === "All Events") return scheduleEvents;
    if (filter === "Public") return scheduleEvents.filter((e) => e.accessLevel === "Public");
    if (filter === "Members Only") return scheduleEvents.filter((e) => e.accessLevel === "Members Only");
    return scheduleEvents.filter((e) => e.category === filter);
  }, [filter]);

  const byDay = useMemo(
    () => DAYS.map((day) => ({ day, items: filtered.filter((e) => e.day === day) })).filter((g) => g.items.length),
    [filtered]
  );

  return (
    <div className="container-1m py-12 lg:py-16">
      {/* Timezone + filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex items-center gap-2 rounded-full border border-ice bg-white px-4 py-2 text-sm shadow-card">
          <Globe2 className="h-4 w-4 text-primary" aria-hidden="true" />
          <span className="font-medium text-navy">
            {hydrated ? <>Times shown in your local timezone: <span className="text-primary">{tz}</span></> : "Detecting your timezone…"}
          </span>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Filter schedule">
        {scheduleFilters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors focus-ring ${
              filter === f ? "bg-gradient-primary text-white shadow-[0_6px_16px_rgba(26,22,16,0.20)]" : "border border-ice bg-white text-navy hover:border-primary"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Schedule grouped by day */}
      <div className="mt-8 space-y-8">
        {byDay.length === 0 ? (
          <EmptyState title="No events match this filter" message="Try a different filter, or update src/data/schedule.ts." />
        ) : (
          byDay.map(({ day, items }) => (
            <section key={day} aria-labelledby={`day-${day}`}>
              <h2 id={`day-${day}`} className="mb-4 flex items-center gap-3 text-xl font-bold text-navy">
                {day}
                <span className="h-px flex-1 bg-ice" aria-hidden="true" />
                <span className="text-sm font-medium text-charcoal/50">{items.length} event{items.length > 1 ? "s" : ""}</span>
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                {items.map((e) => <ScheduleCard key={e.id} event={e} hydrated={hydrated} />)}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
