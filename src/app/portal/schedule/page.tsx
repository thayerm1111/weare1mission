import { CalendarClock, Radio, Video, Calendar } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { ScheduleClient } from "@/app/schedule/ScheduleClient";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { scheduleNotice } from "@/data/schedule";
import { fmtDateTime } from "@/lib/format";
import { TIER_LABELS } from "@/lib/access";

export const metadata = { title: "Schedule", robots: { index: false, follow: false } };

export default async function PortalSchedulePage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;

  // Upcoming dated live sessions (tier-gated by RLS).
  const { data: upcoming } = await supabase
    .from("live_sessions").select("*").eq("published", true)
    .gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true }).limit(8);

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Members Only</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <CalendarClock className="h-7 w-7 text-primary" aria-hidden="true" /> Schedule &amp; Live Sessions
        </h1>
        <p className="mt-2 text-charcoal/70">Your weekly community calls plus upcoming live sessions.</p>
      </header>

      {/* Upcoming live sessions (from the database) */}
      <section aria-labelledby="live-heading">
        <h2 id="live-heading" className="flex items-center gap-2 text-lg font-bold text-navy">
          <Radio className="h-5 w-5 text-primary" aria-hidden="true" /> Upcoming Live Sessions
        </h2>
        <div className="mt-4 space-y-3">
          {(upcoming ?? []).length === 0 ? (
            <p className="rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-4 text-sm text-charcoal/60">
              No upcoming sessions at your tier right now.
            </p>
          ) : (
            upcoming!.map((s) => (
              <article key={s.id} className="flex flex-col gap-3 rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-ice px-2.5 py-0.5 text-xs font-semibold text-navy">{s.category}</span>
                    <span className="text-[11px] font-medium uppercase tracking-wide text-medium">{TIER_LABELS[s.required_tier as keyof typeof TIER_LABELS] ?? s.required_tier}+</span>
                  </div>
                  <h3 className="mt-2 font-bold text-navy">{s.title}</h3>
                  {s.description && <p className="mt-1 text-sm text-charcoal/70">{s.description}</p>}
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-medium">
                    <Calendar className="h-3.5 w-3.5" aria-hidden="true" /> {fmtDateTime(s.starts_at)}{s.host ? ` · ${s.host}` : ""}
                  </p>
                </div>
                {s.join_url && (
                  <a href={s.join_url} target="_blank" rel="noopener noreferrer" className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full bg-gradient-primary px-5 py-2.5 text-sm font-semibold text-cream">
                    <Video className="h-4 w-4" aria-hidden="true" /> Join
                  </a>
                )}
              </article>
            ))
          )}
        </div>
      </section>

      {/* Weekly recurring schedule (from the editable data file, local timezone) */}
      <section aria-labelledby="weekly-heading">
        <h2 id="weekly-heading" className="text-lg font-bold text-navy">Weekly Community Calls</h2>
        <div className="mt-3">
          <DisclaimerBanner>{scheduleNotice}</DisclaimerBanner>
        </div>
        <ScheduleClient />
      </section>
    </div>
  );
}
