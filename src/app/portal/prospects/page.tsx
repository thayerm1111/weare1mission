import { Video, Mail, MessageSquare } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { fmtDateTime } from "@/lib/format";

interface Lead {
  id: string; name: string | null; email: string | null; phone: string | null;
  video_percent: number; video_seconds: number; video_duration: number | null;
  created_at: string; updated_at: string;
}

export const metadata = { title: "Prospects", robots: { index: false, follow: false } };

export default async function ProspectsPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;

  const { data } = await supabase
    .from("leads")
    .select("id, name, email, phone, video_percent, video_seconds, video_duration, created_at, updated_at")
    .order("updated_at", { ascending: false });
  const leads = (data ?? []) as Lead[];

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Members Only</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <Video className="h-7 w-7 text-primary" aria-hidden="true" /> Prospects
        </h1>
        <p className="mt-2 text-charcoal/70">
          People who watched your community video through your invite link — and how much they watched.
        </p>
      </header>

      {leads.length === 0 ? (
        <p className="rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-6 text-sm text-charcoal/60">
          No prospects yet. Share your invite link (see <a href="/portal/team" className="font-semibold text-primary">My Team</a>) — anyone who enters
          their details to watch the video shows up here.
        </p>
      ) : (
        <div className="space-y-3">
          {leads.map((l) => (
            <article key={l.id} className="rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="font-bold text-navy">{l.name || "(no name)"}</p>
                  <p className="mt-0.5 truncate text-sm text-charcoal/60">{l.email}{l.phone ? ` · ${l.phone}` : ""}</p>
                  <p className="mt-1 text-xs text-medium">First watched {fmtDateTime(l.created_at)}</p>
                </div>

                <div className="flex flex-col gap-2 sm:w-64">
                  <div className="flex items-center justify-between text-xs font-medium text-charcoal/70">
                    <span>Video watched</span>
                    <span className="text-primary">{l.video_percent}%</span>
                  </div>
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-ice" role="progressbar" aria-valuenow={l.video_percent} aria-valuemin={0} aria-valuemax={100}>
                    <div className="h-full rounded-full bg-gradient-primary" style={{ width: `${Math.min(100, l.video_percent)}%` }} />
                  </div>
                </div>

                <div className="flex flex-shrink-0 items-center gap-2">
                  {l.email && <a href={`mailto:${l.email}`} className="inline-flex items-center gap-1.5 rounded-full border border-[#E4DCCB] px-3.5 py-2 text-sm font-semibold text-navy hover:border-primary hover:text-primary"><Mail className="h-4 w-4" aria-hidden="true" /> Email</a>}
                  {l.phone && <a href={`sms:${l.phone}`} className="inline-flex items-center gap-1.5 rounded-full border border-[#E4DCCB] px-3.5 py-2 text-sm font-semibold text-navy hover:border-primary hover:text-primary"><MessageSquare className="h-4 w-4" aria-hidden="true" /> Text</a>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
