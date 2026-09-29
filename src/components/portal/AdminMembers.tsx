"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Check, Coins, Infinity as InfinityIcon, KeyRound, Loader2, PauseCircle, RotateCcw, Search, ShoppingBag, Star, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { TIERS, TIER_LABELS } from "@/lib/access";
import { PACK_LABELS, type MemberBilling, type PackKey } from "@/lib/adminBilling";

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
/** Whole days left on a time-limited grant (negative once expired); null when there's no expiry. */
function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}
/** Extend access by N days, measured from whatever is later: now, or the member's current
 *  expiry — so extending someone mid-trial ADDS days instead of restarting the clock, and
 *  extending someone already expired starts from today. Always reactivates. */
function extendPatch(m: MemberRow, days: number): Record<string, unknown> {
  const cur = m.access_expires_at ? Date.parse(m.access_expires_at) : NaN;
  const base = Number.isFinite(cur) && cur > Date.now() ? cur : Date.now();
  return { status: "active", access_expires_at: new Date(base + days * 86400000).toISOString() };
}

type SortKey = "newest" | "name" | "email" | "expiring" | "status" | "spent";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "newest", label: "Newest first" },
  { key: "name", label: "Name A–Z" },
  { key: "email", label: "Email A–Z" },
  { key: "expiring", label: "Expiring soonest" },
  { key: "status", label: "Status" },
  { key: "spent", label: "Biggest buyers" },
];

/** WHO BOUGHT WHAT (owner 09-29): narrow the list to members with money in. */
type BuyerFilter = "all" | "buyers" | "subscribers" | "none";
const BUYER_FILTERS: { key: BuyerFilter; label: string }[] = [
  { key: "all", label: "Everyone" },
  { key: "buyers", label: "Bought a pack" },
  { key: "subscribers", label: "On a subscription" },
  { key: "none", label: "Never paid" },
];
const PACK_ORDER: PackKey[] = ["pro", "trader", "starter", "autorefill"];
const hasBought = (b: MemberBilling | undefined) => !!b && b.creditsBought > 0;
const hasSub = (b: MemberBilling | undefined) => !!b?.sub?.active;
const fmtDay = (iso: string | null) => {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
};

export function AdminMembers({ members, billing = {} }: { members: MemberRow[]; billing?: Record<string, MemberBilling> }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [buyers, setBuyers] = useState<BuyerFilter>("all");

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

  // SEARCH: one box matches name, email, and Conectiv username/ID, case-insensitive.
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    let list = members;
    if (buyers === "buyers") list = list.filter((m) => hasBought(billing[m.id]));
    else if (buyers === "subscribers") list = list.filter((m) => hasSub(billing[m.id]));
    else if (buyers === "none") list = list.filter((m) => !hasBought(billing[m.id]) && !hasSub(billing[m.id]));
    if (!needle) return list;
    return list.filter((m) =>
      [m.full_name, m.email, m.conectiv_username, m.conectiv_id]
        .some((v) => (v ?? "").toLowerCase().includes(needle)),
    );
  }, [members, needle, buyers, billing]);

  // Headline for the page: how many members have paid, and how much of it is packs vs subscriptions.
  const totals = useMemo(() => {
    let buyersN = 0, subsN = 0, credits = 0;
    for (const m of members) {
      const b = billing[m.id];
      if (hasBought(b)) { buyersN++; credits += b!.creditsBought; }
      if (hasSub(b)) subsN++;
    }
    return { buyers: buyersN, subs: subsN, credits };
  }, [members, billing]);

  // SORT: applied inside each section so "Pending approval" always stays on top.
  const sorted = useMemo(() => {
    const arr = [...filtered];
    const name = (m: MemberRow) => (m.full_name || m.email || "").toLowerCase();
    switch (sort) {
      case "name": arr.sort((a, b) => name(a).localeCompare(name(b))); break;
      case "email": arr.sort((a, b) => (a.email ?? "").localeCompare(b.email ?? "")); break;
      case "expiring": arr.sort((a, b) => {
        const ta = a.access_expires_at ? Date.parse(a.access_expires_at) : Infinity;
        const tb = b.access_expires_at ? Date.parse(b.access_expires_at) : Infinity;
        return ta - tb; // soonest (and already-expired) first; permanent (no expiry) last
      }); break;
      case "status": arr.sort((a, b) => a.status.localeCompare(b.status) || name(a).localeCompare(name(b))); break;
      case "spent": arr.sort((a, b) => (billing[b.id]?.creditsBought ?? 0) - (billing[a.id]?.creditsBought ?? 0) || name(a).localeCompare(name(b))); break;
      default: arr.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    }
    return arr;
  }, [filtered, sort, billing]);

  const pending = sorted.filter((m) => m.status === "pending");
  const others = sorted.filter((m) => m.status !== "pending");

  return (
    <div className="space-y-6">
      {/* SEARCH + SORT BAR */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal/40" aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by email, name, or Conectiv…"
            aria-label="Search members"
            className="w-full rounded-xl border border-[#E4DCCB] bg-cream py-2.5 pl-9 pr-3 text-sm outline-none focus:border-primary"
          />
        </div>
        <label className="sr-only" htmlFor="member-sort">Sort members</label>
        <select
          id="member-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-xl border border-[#E4DCCB] bg-cream px-3 py-2.5 text-sm outline-none focus:border-primary"
        >
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <label className="sr-only" htmlFor="member-buyers">Show</label>
        <select
          id="member-buyers"
          value={buyers}
          onChange={(e) => setBuyers(e.target.value as BuyerFilter)}
          className="rounded-xl border border-[#E4DCCB] bg-cream px-3 py-2.5 text-sm outline-none focus:border-primary"
        >
          {BUYER_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        {(needle || buyers !== "all") && (
          <p className="text-xs text-charcoal/60 sm:whitespace-nowrap">{sorted.length} match{sorted.length === 1 ? "" : "es"}</p>
        )}
      </div>

      {/* WHO BOUGHT WHAT (owner 09-29) — the headline, then the detail sits on every card below. */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-charcoal/70">
        <ShoppingBag className="h-4 w-4 text-primary" aria-hidden="true" />
        <span><strong className="text-navy">{totals.buyers}</strong> member{totals.buyers === 1 ? " has" : "s have"} bought a pack ({totals.credits.toLocaleString()} credits)</span>
        <span aria-hidden="true">·</span>
        <span><strong className="text-navy">{totals.subs}</strong> on an active subscription</span>
      </p>

      <div className="space-y-8">
        <Section title={`Pending approval (${pending.length})`} rows={pending} billing={billing} onUpdate={update} onRemove={remove} busy={busy} highlight />
        <Section title={`All members (${others.length})`} rows={others} billing={billing} onUpdate={update} onRemove={remove} busy={busy} />
      </div>
    </div>
  );
}

/**
 * One line per member: which packs they bought (and how many times), the credits that came with
 * them, the last purchase date, auto-refill if it is on — and a pill for the subscription. A member
 * with nothing in the ledger reads "No purchases" so the absence is visible, not just blank.
 */
function PurchasesLine({ b }: { b: MemberBilling | undefined }) {
  const bought = PACK_ORDER.filter((k) => (b?.packs[k] ?? 0) > 0).map((k) => `${PACK_LABELS[k]}${b!.packs[k] > 1 ? ` ×${b!.packs[k]}` : ""}`);
  const sub = b?.sub ?? null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <ShoppingBag className="h-3.5 w-3.5 text-charcoal/45" aria-hidden="true" />
      {bought.length ? (
        <span className="text-charcoal/75">
          <span className="font-semibold text-navy">Bought:</span> {bought.join(", ")}
          <span className="text-charcoal/55"> · {b!.creditsBought.toLocaleString()} credits{b!.lastPurchaseAt ? ` · last ${fmtDay(b!.lastPurchaseAt)}` : ""}</span>
        </span>
      ) : (
        <span className="text-charcoal/50">No purchases</span>
      )}
      {b?.autoRefill?.enabled && (
        <span className="rounded-full bg-ice px-2 py-0.5 text-[11px] font-semibold text-navy" title={b.autoRefill.last4 ? `Card ending ${b.autoRefill.last4}` : undefined}>
          Auto-refill on{b.autoRefill.credits ? ` · ${b.autoRefill.credits}` : ""}
        </span>
      )}
      {sub && (
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${sub.active ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}
          title={sub.periodEnd ? `${sub.cancelAtPeriodEnd ? "Ends" : "Renews"} ${fmtDay(sub.periodEnd)}` : undefined}
        >
          {sub.label} · {sub.active ? (sub.cancelAtPeriodEnd ? `ends ${fmtDay(sub.periodEnd)}` : sub.status) : sub.status}
        </span>
      )}
    </div>
  );
}

function Section({
  title, rows, billing, onUpdate, onRemove, busy, highlight = false,
}: {
  title: string; rows: MemberRow[]; billing: Record<string, MemberBilling>; busy: string | null; highlight?: boolean;
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
                {/* ACCESS CLOCK — expired reads red; a live clock shows days left; no line = permanent. */}
                {m.access_expires_at ? (() => {
                  const d = daysLeft(m.access_expires_at);
                  return (
                    <p className={`mt-0.5 text-xs font-medium ${d != null && d <= 0 ? "text-red-600" : "text-amber-700"}`}>
                      {d != null && d <= 0 ? "Access expired" : `Access — ${d} day${d === 1 ? "" : "s"} left`}
                    </p>
                  );
                })() : m.status === "active" ? (
                  <p className="mt-0.5 text-xs font-medium text-emerald-700">Permanent access</p>
                ) : null}
                {/* WHO BOUGHT WHAT (owner 09-29): packs, auto-refill and subscription, right on the card. */}
                <PurchasesLine b={billing[m.id]} />
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

                {/* ACCESS GRANTS (owner 09-07): extend a member's clock, or make them permanent.
                    +14d/+30d add to whatever time is left (or start from today if lapsed) and
                    reactivate an expired member in the same click. Permanent clears the clock. */}
                <div className="flex items-center gap-1 rounded-full border border-[#E4DCCB] p-1" role="group" aria-label={`Access grants for ${m.full_name || m.email || "member"}`}>
                  <button disabled={busy === m.id} onClick={() => onUpdate(m.id, extendPatch(m, 14))}
                    title="Extend access 14 days"
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold text-charcoal/75 hover:bg-primary/10 hover:text-primary disabled:opacity-60">
                    <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" /> +14d
                  </button>
                  <button disabled={busy === m.id} onClick={() => onUpdate(m.id, extendPatch(m, 30))}
                    title="Extend access 30 days"
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold text-charcoal/75 hover:bg-primary/10 hover:text-primary disabled:opacity-60">
                    <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" /> +30d
                  </button>
                  <button disabled={busy === m.id} onClick={() => onUpdate(m.id, { status: "active", access_expires_at: null })}
                    title="Give permanent access"
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold disabled:opacity-60 ${
                      m.status === "active" && !m.access_expires_at
                        ? "bg-emerald-100 text-emerald-700"
                        : "text-charcoal/75 hover:bg-emerald-50 hover:text-emerald-700"
                    }`}>
                    <InfinityIcon className="h-3.5 w-3.5" aria-hidden="true" /> Permanent
                  </button>
                </div>

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

                {/* Owner credit grants (owner 09-08): add credits right from this page. */}
                <CreditsControl id={m.id} label={m.full_name || m.email || "member"} />

                {/* Owner password set (owner 09-10): change a member's password right here. */}
                {m.role !== "admin" && (
                  <PasswordControl id={m.id} label={m.full_name || m.email || "member"} />
                )}

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

/**
 * CREDIT GRANTS (owner 09-08: "make it so on the admin side I can add credits to
 * peoples accounts"). One compact button per member; opening it shows the member's
 * live balance plus quick +100 / +250 / +500 grants and a custom amount. Grants go
 * through /api/admin/credits (admin-authed, add_purchased_credits under the hood —
 * same ledger every other grant uses). Grants only; nothing here can deduct.
 */
/**
 * MEMBER PASSWORD SET (owner 09-10: "a admin spot on the approvals where i can change
 * their password to what i want"). One compact button per non-admin member; opening it
 * shows a password field — type the new password (6+ chars) and Set. Goes through
 * /api/admin/password (admin-authed, Supabase Auth admin API — same mechanism the
 * Supabase dashboard uses). Admin accounts never show this control, and the server
 * refuses them independently. The password is sent once over HTTPS and never stored,
 * logged, or echoed anywhere.
 */
function PasswordControl({ id, label }: { id: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function setPassword() {
    if (pw.length < 6) { setMsg("At least 6 characters."); return; }
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/admin/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, password: pw }),
      });
      const d = (await r.json()) as { ok?: boolean; detail?: string; error?: string };
      if (d?.ok) { setPw(""); setMsg("Password updated ✓"); }
      else setMsg(d?.detail || d?.error || "Couldn't update — try again.");
    } catch { setMsg("Network error — try again."); }
    setBusy(false);
  }

  return (
    <div className="relative">
      <button
        onClick={() => { setOpen(!open); setMsg(""); }}
        title={`Set a new password for ${label}`}
        className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold ${
          open ? "bg-gold/15 text-gold border border-gold/40" : "border border-[#E4DCCB] text-charcoal/75 hover:border-gold hover:text-gold"
        }`}
      >
        <KeyRound className="h-4 w-4" aria-hidden="true" /> Password
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-64 rounded-2xl border border-[#E4DCCB] bg-cream p-4 shadow-card">
          <p className="text-xs text-charcoal/60">New password for <span className="font-bold text-navy">{label}</span></p>
          <div className="mt-2 flex items-center gap-1.5">
            <input
              type="text" value={pw} disabled={busy} autoComplete="off" spellCheck={false}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") setPassword(); }}
              placeholder="New password (6+ chars)"
              aria-label={`New password for ${label}`}
              className="w-full rounded-lg border border-[#E4DCCB] bg-offwhite/60 px-2.5 py-1.5 text-sm outline-none focus:border-gold"
            />
            <button disabled={busy || pw.length < 6} onClick={setPassword}
              className="inline-flex items-center gap-1 rounded-lg bg-gradient-primary px-3 py-1.5 text-sm font-bold text-cream disabled:opacity-60">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null} Set
            </button>
          </div>
          {msg && <p className={`mt-2 text-xs font-medium ${msg.endsWith("✓") ? "text-emerald-700" : "text-red-600"}`}>{msg}</p>}
        </div>
      )}
    </div>
  );
}

function CreditsControl({ id, label }: { id: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [bal, setBal] = useState<number | null>(null);
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function loadBalance() {
    try {
      const r = await fetch(`/api/admin/credits?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const d = (await r.json()) as { ok?: boolean; balance?: number };
      if (d?.ok) setBal(d.balance ?? 0);
    } catch { /* balance is display-only */ }
  }

  async function grant(amount: number) {
    if (!Number.isFinite(amount) || amount < 1) { setMsg("Enter a whole number of credits."); return; }
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/admin/credits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, amount }),
      });
      const d = (await r.json()) as { ok?: boolean; balance?: number; detail?: string; error?: string };
      if (d?.ok) { setBal(d.balance ?? null); setAmt(""); setMsg(`+${amount} added ✓`); }
      else setMsg(d?.detail || d?.error || "Couldn't add credits — try again.");
    } catch { setMsg("Network error — try again."); }
    setBusy(false);
  }

  return (
    <div className="relative">
      <button
        onClick={() => { const next = !open; setOpen(next); if (next && bal == null) loadBalance(); }}
        title={`Add credits for ${label}`}
        className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold ${
          open ? "bg-gold/15 text-gold border border-gold/40" : "border border-[#E4DCCB] text-charcoal/75 hover:border-gold hover:text-gold"
        }`}
      >
        <Coins className="h-4 w-4" aria-hidden="true" /> Credits
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-64 rounded-2xl border border-[#E4DCCB] bg-cream p-4 shadow-card">
          <p className="text-xs text-charcoal/60">
            Balance: <span className="font-bold text-navy">{bal == null ? "…" : bal.toLocaleString()}</span> credits
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            {[100, 250, 500].map((n) => (
              <button key={n} disabled={busy} onClick={() => grant(n)}
                className="rounded-full border border-[#E4DCCB] px-2.5 py-1 text-xs font-semibold text-charcoal/75 hover:border-gold hover:text-gold disabled:opacity-60">
                +{n}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <input
              type="number" min={1} max={100000} step={1} value={amt} disabled={busy}
              onChange={(e) => setAmt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") grant(Math.floor(Number(amt))); }}
              placeholder="Custom amount"
              aria-label={`Custom credit amount for ${label}`}
              className="w-full rounded-lg border border-[#E4DCCB] bg-offwhite/60 px-2.5 py-1.5 text-sm outline-none focus:border-gold"
            />
            <button disabled={busy || !amt} onClick={() => grant(Math.floor(Number(amt)))}
              className="inline-flex items-center gap-1 rounded-lg bg-gradient-primary px-3 py-1.5 text-sm font-bold text-cream disabled:opacity-60">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null} Add
            </button>
          </div>
          {msg && <p className={`mt-2 text-xs font-medium ${msg.endsWith("✓") ? "text-emerald-700" : "text-red-600"}`}>{msg}</p>}
        </div>
      )}
    </div>
  );
}
