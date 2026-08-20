import { UserCircle, Receipt } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { SignOutButton } from "@/components/portal/SignOutButton";
import { AccountForm } from "@/components/portal/AccountForm";
import { PasswordForm } from "@/components/portal/PasswordForm";
import { SubscriptionCard } from "@/components/portal/SubscriptionCard";
import { TIER_LABELS } from "@/lib/access";
import { packById } from "@/lib/creditConfig";

type Purchase = { amount: number; feature: string | null; created_at: string };

// Turn a stored credit-add feature into a friendly label + price. Real pack
// purchases ("pack_starter") show their price; team/bonus grants show no price.
function describePurchase(feature: string | null) {
  const f = feature ?? "";
  if (f.startsWith("pack_")) {
    const pack = packById(f.replace(/^pack_/, ""));
    return { label: pack ? `${pack.label} pack` : "Credit pack", price: pack ? `$${pack.priceUsd}` : null };
  }
  if (f.includes("admin_grant") || f.includes("grant")) return { label: "Team grant", price: null };
  return { label: "Credits added", price: null };
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function AccountPage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;
  const profile = await getProfile();
  if (!profile) return <PortalNotConfigured />;

  // Purchase history — the member's own credit-pack purchases (RLS: own rows only).
  const { data: purchaseData } = await supabase
    .from("credit_transactions")
    .select("amount, feature, created_at")
    .eq("user_id", profile.id)
    .eq("kind", "purchase")
    .order("created_at", { ascending: false })
    .limit(50);
  const purchases = (purchaseData ?? []) as Purchase[];

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
        <div className="mt-4">
          <AccountForm
            id={profile.id}
            initialName={profile.full_name ?? ""}
            initialUsername={profile.username ?? ""}
            initialPhone={profile.phone ?? ""}
          />
        </div>
      </section>

      <section className="rounded-2xl border border-[#E4DCCB] bg-cream p-6 shadow-card">
        <h2 className="text-base font-bold text-navy">Password</h2>
        <p className="mt-1 text-sm text-charcoal/60">
          Set a password so you can log in with your email and password — no reset link needed.
        </p>
        <div className="mt-4">
          <PasswordForm />
        </div>
      </section>

      <SubscriptionCard />

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

      <section className="rounded-2xl border border-[#E4DCCB] bg-cream p-6 shadow-card">
        <h2 className="flex items-center gap-2 text-base font-bold text-navy">
          <Receipt className="h-4 w-4 text-primary" aria-hidden="true" /> Purchase history
        </h2>
        <p className="mt-1 text-sm text-charcoal/60">Credit packs you&apos;ve bought and credits added to your account.</p>
        {purchases.length === 0 ? (
          <p className="mt-4 rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-4 text-sm text-charcoal/60">
            No purchases yet. You can buy credit packs on the{" "}
            <a href="/portal/credits" className="font-semibold text-primary hover:text-medium">Credits</a> page.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-[#E4DCCB]">
            {purchases.map((p, i) => {
              const { label, price } = describePurchase(p.feature);
              return (
                <li key={i} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-navy">{label}</p>
                    <p className="text-xs text-charcoal/55">{formatDate(p.created_at)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-emerald-700">+{p.amount.toLocaleString()} credits</p>
                    {price && <p className="text-xs text-charcoal/55">{price}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
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
