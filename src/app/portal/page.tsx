import Link from "next/link";
import { GraduationCap, Radio, Megaphone, ArrowRight, Pin, Calendar } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
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
      <header>
        <p className="eyebrow">Welcome back</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-navy">Hi {firstName} 👋</h1>
        <p className="mt-2 text-charcoal/70">Here&apos;s what&apos;s happening in the 1 Mission community.</p>
      </header>

      {/* Quick links */}
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { href: "/portal/training", icon: GraduationCap, label: "Training", desc: "Affiliate modules" },
          { href: "/portal/schedule", icon: Radio, label: "Schedule", desc: "Calls & live sessions" },
          { href: "/portal/updates", icon: Megaphone, label: "Team Updates", desc: "Latest news" },
        ].map((c) => (
          <Link key={c.href} href={c.href} className="group rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-5 transition-all hover:-translate-y-0.5 hover:shadow-card">
            <c.icon className="h-6 w-6 text-primary" aria-hidden="true" />
            <h2 className="mt-3 flex items-center gap-1 text-base font-bold text-navy">
              {c.label} <ArrowRight className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
            </h2>
            <p className="text-sm text-charcoal/60">{c.desc}</p>
          </Link>
        ))}
      </div>

      {/* Latest updates */}
      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-navy">Latest Updates</h2>
          <Link href="/portal/updates" className="text-sm font-semibold text-primary hover:text-medium">View all</Link>
        </div>
        <div className="mt-4 space-y-3">
          {(updates ?? []).length === 0 ? (
            <p className="rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-4 text-sm text-charcoal/60">No updates yet.</p>
          ) : (
            updates!.map((u) => (
              <article key={u.id} className="rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card">
                <div className="flex items-center gap-2">
                  {u.pinned && <Pin className="h-4 w-4 text-primary" aria-hidden="true" />}
                  <span className="rounded-full bg-ice px-2.5 py-0.5 text-xs font-semibold text-navy">{u.category}</span>
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
          <h2 className="text-lg font-bold text-navy">Upcoming Live Sessions</h2>
          <Link href="/portal/live" className="text-sm font-semibold text-primary hover:text-medium">Full schedule</Link>
        </div>
        <div className="mt-4 space-y-3">
          {(sessions ?? []).length === 0 ? (
            <p className="rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-4 text-sm text-charcoal/60">No upcoming sessions available at your tier right now.</p>
          ) : (
            sessions!.map((s) => (
              <article key={s.id} className="flex items-center justify-between gap-4 rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card">
                <div>
                  <h3 className="font-bold text-navy">{s.title}</h3>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-medium">
                    <Calendar className="h-3.5 w-3.5" aria-hidden="true" /> {fmtDateTime(s.starts_at)} · {s.host}
                  </p>
                </div>
                {s.join_url && (
                  <a href={s.join_url} target="_blank" rel="noopener noreferrer" className="flex-shrink-0 rounded-full bg-gradient-primary px-4 py-2 text-sm font-semibold text-cream">Join</a>
                )}
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
