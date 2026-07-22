import Link from "next/link";
import { Pin, Calendar } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { PathHub } from "@/components/portal/PathHub";
import { fmtDateTime } from "@/lib/format";

export default async function PortalDashboard() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile();

  const { data: updates } = await supabase
    .from("team_updates").select("*").eq("published", true)
    .order("pinned", { ascending: false }).order("created_at", { ascending: false }).limit(3);

  const { data: sessions } = await supabase
    .from("live_sessions").select("*").gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true }).limit(3);

  const firstName = (profile?.full_name || profile?.email || "there").split(" ")[0].split("@")[0];

  return (
    <div className="space-y-10">
      {/* Side-aware hub — The One vs The Builder */}
      <PathHub firstName={firstName} />

      {/* Latest updates */}
      <section>
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-base font-semibold uppercase tracking-[0.14em] text-navy">Latest Updates</h2>
          <Link href="/portal/updates" className="text-[12px] font-medium uppercase tracking-[0.12em] text-primary hover:text-medium">View all</Link>
        </div>
        <div className="mt-4 space-y-3">
          {(updates ?? []).length === 0 ? (
            <p className="rounded-xl border border-[#E7E4DD] bg-offwhite/60 p-4 text-sm text-charcoal/60">No updates yet.</p>
          ) : (
            updates!.map((u) => (
              <article key={u.id} className="rounded-2xl border border-[#E7E4DD] bg-white p-5 shadow-card">
                <div className="flex items-center gap-2">
                  {u.pinned && <Pin className="h-4 w-4 text-primary" aria-hidden="true" />}
                  <span className="rounded-full bg-ice px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-navy">{u.category}</span>
                  <span className="text-xs text-medium">{fmtDateTime(u.created_at)}</span>
                </div>
                <h3 className="mt-2 font-bold text-navy">{u.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-charcoal/70">{u.body}</p>
              </article>
            ))
          )}
        </div>
      </section>

      {/* Upcoming sessions */}
      <section>
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-base font-semibold uppercase tracking-[0.14em] text-navy">Upcoming Live Sessions</h2>
          <Link href="/portal/live" className="text-[12px] font-medium uppercase tracking-[0.12em] text-primary hover:text-medium">Full schedule</Link>
        </div>
        <div className="mt-4 space-y-3">
          {(sessions ?? []).length === 0 ? (
            <p className="rounded-xl border border-[#E7E4DD] bg-offwhite/60 p-4 text-sm text-charcoal/60">No upcoming sessions available at your tier right now.</p>
          ) : (
            sessions!.map((s) => (
              <article key={s.id} className="flex items-center justify-between gap-4 rounded-2xl border border-[#E7E4DD] bg-white p-5 shadow-card">
                <div>
                  <h3 className="font-bold text-navy">{s.title}</h3>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-medium">
                    <Calendar className="h-3.5 w-3.5" aria-hidden="true" /> {fmtDateTime(s.starts_at)} · {s.host}
                  </p>
                </div>
                {s.join_url && (
                  <a href={s.join_url} target="_blank" rel="noopener noreferrer" className="flex-shrink-0 rounded-none bg-primary px-5 py-2.5 text-[12px] font-medium uppercase tracking-[0.12em] text-white hover:bg-black">Join</a>
                )}
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
