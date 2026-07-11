"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, PauseCircle, RotateCcw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { TIERS, TIER_LABELS } from "@/lib/access";

export interface MemberRow {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  tier: string;
  status: string;
  created_at: string;
}

const statusStyle: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-700",
  suspended: "bg-red-100 text-red-700",
};

export function AdminMembers({ members }: { members: MemberRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function update(id: string, patch: Record<string, string>) {
    const supabase = createClient();
    if (!supabase) return;
    setBusy(id);
    await supabase.from("profiles").update(patch).eq("id", id);
    setBusy(null);
    router.refresh();
  }

  const pending = members.filter((m) => m.status === "pending");
  const others = members.filter((m) => m.status !== "pending");

  return (
    <div className="space-y-8">
      <Section title={`Pending approval (${pending.length})`} rows={pending} onUpdate={update} busy={busy} highlight />
      <Section title={`All members (${others.length})`} rows={others} onUpdate={update} busy={busy} />
    </div>
  );
}

function Section({
  title, rows, onUpdate, busy, highlight = false,
}: {
  title: string; rows: MemberRow[]; busy: string | null; highlight?: boolean;
  onUpdate: (id: string, patch: Record<string, string>) => void;
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
                  <button disabled={busy === m.id} onClick={() => onUpdate(m.id, { status: "active" })}
                    className="inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-sm font-semibold text-cream disabled:opacity-60">
                    <Check className="h-4 w-4" aria-hidden="true" /> Approve
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
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
