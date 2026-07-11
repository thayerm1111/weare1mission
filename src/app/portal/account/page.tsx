import { UserCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { SignOutButton } from "@/components/portal/SignOutButton";
import { AccountForm } from "@/components/portal/AccountForm";
import { TIER_LABELS } from "@/lib/access";

export default async function AccountPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile();
  if (!profile) return <PortalNotConfigured />;

  const rows: [string, string][] = [
    ["Email", profile.email ?? "—"],
    ["Membership tier", TIER_LABELS[profile.tier] ?? profile.tier],
    ["Role", profile.role === "admin" ? "Admin" : "Member"],
    ["Status", profile.status.charAt(0).toUpperCase() + profile.status.slice(1)],
  ];

  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <p className="eyebrow">Your Account</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <UserCircle className="h-7 w-7 text-primary" aria-hidden="true" /> Account
        </h1>
      </header>

      <section className="rounded-2xl border border-[#E4DCCB] bg-cream p-6 shadow-card">
        <h2 className="text-base font-bold text-navy">Profile</h2>
        <div className="mt-4"><AccountForm id={profile.id} initialName={profile.full_name ?? ""} /></div>
      </section>

      <section className="rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-6">
        <h2 className="text-base font-bold text-navy">Membership</h2>
        <dl className="mt-4 divide-y divide-[#E4DCCB]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between py-2.5">
              <dt className="text-sm text-charcoal/60">{k}</dt>
              <dd className="text-sm font-semibold text-navy">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-charcoal/55">
          Membership tier and role are managed by the 1 Mission team. Contact your mentor to change your access level.
        </p>
      </section>

      <div className="flex items-center justify-between rounded-2xl border border-[#E4DCCB] bg-cream p-6 shadow-card">
        <div>
          <h2 className="text-base font-bold text-navy">Sign out</h2>
          <p className="text-sm text-charcoal/60">End your session on this device.</p>
        </div>
        <SignOutButton />
      </div>
    </div>
  );
}
