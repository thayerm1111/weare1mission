import { Megaphone, Pin } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { fmtDateTime } from "@/lib/format";

export default async function UpdatesPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;

  const { data: updates } = await supabase
    .from("team_updates").select("*").eq("published", true)
    .order("pinned", { ascending: false }).order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Members Only</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <Megaphone className="h-7 w-7 text-primary" aria-hidden="true" /> Team Updates
        </h1>
        <p className="mt-2 text-charcoal/70">News, announcements, and weekly focus from the leadership team.</p>
      </header>

      <div className="space-y-3">
        {(updates ?? []).length === 0 ? (
          <p className="rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-6 text-sm text-charcoal/60">No updates posted yet.</p>
        ) : (
          updates!.map((u) => (
            <article key={u.id} className="rounded-2xl border border-[#E4DCCB] bg-cream p-6 shadow-card">
              <div className="flex flex-wrap items-center gap-2">
                {u.pinned && <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary"><Pin className="h-3 w-3" aria-hidden="true" /> Pinned</span>}
                <span className="rounded-full bg-ice px-2.5 py-0.5 text-xs font-semibold text-navy">{u.category}</span>
                <span className="text-xs text-medium">{fmtDateTime(u.created_at)}</span>
              </div>
              <h2 className="mt-3 text-lg font-bold text-navy">{u.title}</h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-charcoal/75">{u.body}</p>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
