"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, PauseCircle, RotateCcw, Star, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { TIERS, TIER_LABELS } from "@/lib/access";

export interface MemberRow {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  tier: string;
  status: string;
  is_creator: boolean;
  created_at: string;
  conectiv_username: string | null;
  conectiv_id: string | null;
  access_expires_at: string | null;
}

const statusStyle: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-700",
  suspended: "bg-red-100 text-red-700",
};

// PROMO CODE: a member who signed up with this Conectiv "ID" gets a time-limited trial rather
// than unlimited access. Approving them stamps access_expires_at; getProfile() pauses them the
// moment it lapses. Change the code or the number of days here.
const PROMO_ID = "rich";
const PROMO_DAYS = 7;
function isPromoMember(m: MemberRow): boolean {
  return (m.conectiv_id ?? "").trim().toLowerCase() === PROMO_ID;
}
/** What to write when Approve is clicked: promo members get a 7-day clock; everyone else unlimited. */
function approvePatch(m: MemberRow): Record<string, unknown> {
  return isPromoMember(m)
    ? { status: "active", access_expires_at: new Date(Date.now() + PROMO_DAYS * 86400000).toISOString() }
    : { status: "active", access_expires_at: null };
}
/** Whole days left on a promo grant (negative once expired); null when there's no expiry. */
function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

export function AdminMembers({ members }: { members: MemberRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function update(id: string, patch: Record<string, unknown>) {
    const supabase = createClient();
    if (!supabase) return;
    setBusy(id);
    await supabase.from("profiles").update(patch).eq("id", id);
    setBusy(null);
    router.refresh();
  }

  // Permanently remove a member (auth user + profile). Admin-only server route.
  async function remove(id: string, label: string) {
    if (!window.confirm(`Permanently delete ${label}?\n\nThis removes their account and access and cannot be undone.`)) return;
    setBusy(id);
    try {
      const res = await fetch("/api/admin/delete-member", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        window.alert(`Couldn't delete this member: ${d.error || res.status}`);
      }
    } finally {
      setBusy(null);
    }
  }

  const pending = members.filter((m) => m.status === "pending");
  const others = members.filter((m) => m.status !== "pending");

  return (
    <div className="space-y-8">
      <Section title={`Pending approval (${pending.length})`} rows={pending} onUpdate={update} onRemove={remove} busy={busy} highlight />
      <Section title={`All members (${others.length})`} rows={others} onUpdate={update} onRemove={remove} busy={busy} />
    </div>
  );
}

function Section({
  title, rows, onUpdate, onRemove, busy, highlight = false,
}: {
  title: string; rows: MemberRow[]; busy: string | null; highlight?: boolean;
  onUpdate: (id: string, patch: Record<string, unknown>) => void;
  onRemove: (id: string, label: string) => void;
}) {
  return (
    <section>
      <h2 className="text-lg font-bold text-navy">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-4 text-sm text-charcoal/60">Nobody here right now.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {rows.map((m) => (
            <div key={m.id} className={`flex flex-col gap-3 rounded-2xl border p-5 shadow-card lg:flex-row lg:items-center lg:justify-between ${highlight ? "border-amber-200 bg-amber-50/40" : "border-[#E4DCCB] bg-cream"}`}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-navy">{m.full_name || "(no name)"}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusStyle[m.status] ?? "bg-ice text-navy"}`}>{m.status}</span>
                  {m.role === "admin" && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">admin</span>}
                </div>
                <p className="mt-0.5 truncate text-sm text-charcoal/60">{m.email}</p>
                {(m.conectiv_username || m.conectiv_id) && (
                  <p className="mt-0.5 truncate text-xs text-charcoal/55">
                    Conectiv: {m.conectiv_username || "—"}
                    {m.conectiv_id ? ` · ID ${m.conectiv_id}` : ""}
                    {isPromoMember(m) ? ` · promo (${PROMO_DAYS}-day)` : ""}
                  </p>
                )}
                {m.access_expires_at && (() => {
                  const d = daysLeft(m.access_expires_at);
                  return (
                    <p className={`mt-0.5 text-xs font-medium ${d != null && d <= 0 ? "text-red-600" : "text-amber-700"}`}>
                      {d != null && d <= 0 ? "Promo access expired" : `Promo access — ${d} day${d === 1 ? "" : "s"} left`}
                    </p>
                  );
                })()}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`tier-${m.id}`}>Tier</label>
                <select
                  id={`tier-${m.id}`}
                  value={m.tier}
                  disabled={busy === m.id}
                  onChange={(e) => onUpdate(m.id, { tier: e.target.value })}
                  className="rounded-lg border border-[#E4DCCB] bg-cream px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  {TIERS.map((t) => <option key={t} value={t}>{TIER_LABELS[t]}</option>)}
                </select>

                {m.status !== "active" ? (
                  <button disabled={busy === m.id} onClick={() => onUpdate(m.id, approvePatch(m))}
                    className="inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-sm font-semibold text-cream disabled:opacity-60">
                    <Check className="h-4 w-4" aria-hidden="true" /> {isPromoMember(m) ? `Approve · ${PROMO_DAYS}d` : "Approve"}
                  </button>
                ) : (
                  <button disabled={busy === m.id} onClick={() => onUpdate(m.id, { status: "suspended" })}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#E4DCCB] px-4 py-2 text-sm font-semibold text-charcoal/75 hover:border-red-300 hover:text-red-600 disabled:opacity-60">
                    <PauseCircle className="h-4 w-4" aria-hidden="true" /> Suspend
                  </button>
                )}
                {m.status === "suspended" && (
                  <button disabled={busy === m.id} onClick={() => onUpdate(m.id, { status: "active" })}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#E4DCCB] px-4 py-2 text-sm font-semibold text-charcoal/75 hover:border-primary hover:text-primary disabled:opacity-60">
                    <RotateCcw className="h-4 w-4" aria-hidden="true" /> Reactivate
                  </button>
                )}

                {/* Grant / revoke Inner Circle creator access */}
                <button
                  disabled={busy === m.id}
                  onClick={() => onUpdate(m.id, { is_creator: !m.is_creator })}
                  title="Inner Circle creator access"
                  className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-60 ${
                    m.is_creator
                      ? "bg-gold text-cream"
                      : "border border-[#E4DCCB] text-charcoal/75 hover:border-gold hover:text-gold"
                  }`}
                >
                  <Star className="h-4 w-4" aria-hidden="true" /> {m.is_creator ? "Creator" : "Make creator"}
                </button>

                {/* Permanently delete a member */}
                {m.role !== "admin" && (
                  <button
                    disabled={busy === m.id}
                    onClick={() => onRemove(m.id, m.full_name || m.email || "this member")}
                    title="Delete member"
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#E4DCCB] px-4 py-2 text-sm font-semibold text-charcoal/75 hover:border-red-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
