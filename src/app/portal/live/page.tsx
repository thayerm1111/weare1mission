import { Radio, Calendar, Video } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { fmtDateTime } from "@/lib/format";
import { TIER_LABELS } from "@/lib/access";

export default async function LivePage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;

  const nowIso = new Date().toISOString();
  const { data: upcoming } = await supabase
    .from("live_sessions").select("*").eq("published", true).gte("starts_at", nowIso)
    .order("starts_at", { ascending: true });
  const { data: past } = await supabase
    .from("live_sessions").select("*").eq("published", true).lt("starts_at", nowIso)
    .order("starts_at", { ascending: false }).limit(6);

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Members Only</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <Radio className="h-7 w-7 text-primary" aria-hidden="true" /> Live Sessions
        </h1>
        <p className="mt-2 text-charcoal/70">Join live calls and training. Only sessions available at your tier are shown.</p>
      </header>

      <section>
        <h2 className="text-lg font-bold text-navy">Upcoming</h2>
        <div className="mt-4 space-y-3">
          {(upcoming ?? []).length === 0 ? (
            <p className="rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-4 text-sm text-charcoal/60">No upcoming sessions at your tier right now.</p>
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

      {(past ?? []).length > 0 && (
        <section>
          <h2 className="text-lg font-bold text-navy">Recent</h2>
          <div className="mt-4 space-y-2">
            {past!.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-xl border border-[#E4DCCB] bg-offwhite/50 px-4 py-3">
                <span className="text-sm font-medium text-navy">{s.title}</span>
                <span className="text-xs text-medium">{fmtDateTime(s.starts_at)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
