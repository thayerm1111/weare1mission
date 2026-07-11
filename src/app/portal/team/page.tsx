import { Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { TeamClient, type DownlineMember } from "@/components/portal/TeamClient";
import { isEmailConfigured, isSmsConfigured } from "@/lib/messaging";
import { siteSettings } from "@/data/siteSettings";

export const metadata = { title: "My Team", robots: { index: false, follow: false } };

export default async function TeamPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile();

  const { data } = await supabase.rpc("get_my_downline");
  const downline = (data ?? []) as DownlineMember[];

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Members Only</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <Users className="h-7 w-7 text-primary" aria-hidden="true" /> My Team
        </h1>
        <p className="mt-2 text-charcoal/70">Share your invite link, see everyone on your team, and reach out to them.</p>
      </header>
      <TeamClient
        username={profile?.username ?? null}
        siteUrl={siteSettings.url}
        downline={downline}
        emailEnabled={isEmailConfigured}
        smsEnabled={isSmsConfigured}
      />
    </div>
  );
}
