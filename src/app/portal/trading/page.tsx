import { LineChart, PlayCircle, Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { TIER_LABELS } from "@/lib/access";

export default async function TradingPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile();

  // RLS returns only content at or below the member's tier (admins see all).
  const { data: items } = await supabase
    .from("trading_content").select("*").eq("published", true)
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Members Only</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <LineChart className="h-7 w-7 text-primary" aria-hidden="true" /> Trading Education
        </h1>
        <p className="mt-2 text-charcoal/70">
          Your tier: <span className="font-semibold text-navy">{profile ? (TIER_LABELS[profile.tier] ?? profile.tier) : "—"}</span>.
          Higher tiers unlock more advanced material.
        </p>
      </header>

      <DisclaimerBanner tone="warning">
        Educational content only — not individualized financial advice. Trading involves risk,
        including loss of capital. Past performance does not guarantee future results.
      </DisclaimerBanner>

      <div className="grid gap-4 sm:grid-cols-2">
        {(items ?? []).length === 0 ? (
          <p className="rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-6 text-sm text-charcoal/60 sm:col-span-2">
            No lessons available at your tier yet. Check back soon.
          </p>
        ) : (
          items!.map((it) => (
            <article key={it.id} className="flex flex-col rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card">
              <div className="flex items-center justify-between">
                <span className="rounded-full bg-ice px-2.5 py-0.5 text-xs font-semibold text-navy">{it.category}</span>
                <span className="text-[11px] font-medium uppercase tracking-wide text-medium">{TIER_LABELS[it.required_tier as keyof typeof TIER_LABELS] ?? it.required_tier}+</span>
              </div>
              <h2 className="mt-3 text-base font-bold text-navy">{it.title}</h2>
              <p className="mt-1 flex-1 text-sm leading-relaxed text-charcoal/70">{it.description}</p>
              {it.video_url ? (
                <a href={it.video_url} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-medium">
                  <PlayCircle className="h-4 w-4" aria-hidden="true" /> Watch lesson
                </a>
              ) : (
                <span className="mt-4 text-sm font-medium text-medium">Lesson content available</span>
              )}
            </article>
          ))
        )}
      </div>

      {/* Upsell for higher tiers */}
      <div className="flex items-start gap-3 rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-5">
        <Lock className="mt-0.5 h-5 w-5 text-medium" aria-hidden="true" />
        <p className="text-sm text-charcoal/70">
          Some advanced material is reserved for higher membership tiers. Talk to your mentor about
          leveling up your access.
        </p>
      </div>
    </div>
  );
}
