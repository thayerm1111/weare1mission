"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Users2, UserCheck, BadgeCheck, TrendingUp, DollarSign, Coins,
  Search, Network, LayoutGrid, ListTree, SlidersHorizontal, Loader2, ChevronRight,
  Wallet, Play, Pencil, Plus, Trash2, X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";

type Kpis = {
  total_reps: number; active_reps: number; distributors: number; new_30d: number;
  sales_total: number; sales_30d: number; cv_total: number; cv_30d: number;
};
type Rank = {
  id: number; position: number; name: string; volume_per_side: number;
  enrollment_line_max_pct: number | null; weekly_cap: number; monthly_cap: number;
  active_requirement: string | null; override_pct: number; qualification: string | null;
};
type Tier = {
  id: number; sort: number; name: string; price: number; renewal: number; cv: number;
  referral_bonus: number; renewal_bonus: number; upgrade_bonus: number;
};
type Rep = {
  id: string; rep_code: string; full_name: string | null; email: string | null;
  tier: string | null; rank: string | null; rank_position: number | null;
  status: "active" | "inactive" | "pending"; is_distributor: boolean;
  enroller_id: string | null; enroller: string | null; placement_side: "L" | "R" | null;
  joined_at: string; personal_enrollees: number; personal_cv: number;
};
type Snapshot = {
  kpis: Kpis; rank_dist: { rank: string; count: number }[];
  ranks: Rank[]; tiers: Tier[]; reps: Rep[];
};

const money = (n: number) => "$" + Math.round(n).toLocaleString();
const num = (n: number) => Math.round(n).toLocaleString();
const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

const TABS = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "reps", label: "Reps", icon: Users2 },
  { id: "tree", label: "Genealogy", icon: ListTree },
  { id: "earnings", label: "Earnings", icon: Wallet },
  { id: "plan", label: "Comp Plan", icon: SlidersHorizontal },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function MlmAdmin() {
  const supabase = useMemo(() => createClient(), []);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>("overview");

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data } = await supabase.rpc("mlm_snapshot");
    setSnap((data as Snapshot) ?? null);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  if (!supabase) return <PortalNotConfigured />;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow inline-flex items-center gap-2"><Network className="h-3.5 w-3.5" /> Network marketing</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-navy">Network HQ</h1>
          <p className="mt-2 text-charcoal/70">Sales, rep IDs, genealogy, and your comp plan — owner view.</p>
        </div>
        <span className="rounded-full bg-ice px-3 py-1.5 text-xs font-bold text-charcoal/70">Private · Owner only</span>
      </header>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-[#E4DCCB] bg-offwhite/60 p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex flex-shrink-0 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                active ? "bg-primary text-cream" : "text-charcoal/60 hover:bg-ice"
              }`}
            >
              <Icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {loading || !snap ? (
        <div className="grid place-items-center rounded-2xl border border-[#E4DCCB] bg-offwhite/40 py-20">
          <Loader2 className="h-6 w-6 animate-spin text-medium" />
        </div>
      ) : (
        <>
          {tab === "overview" && <Overview snap={snap} onJump={() => setTab("reps")} />}
          {tab === "reps" && <Reps reps={snap.reps} />}
          {tab === "tree" && <Tree reps={snap.reps} />}
          {tab === "earnings" && <Earnings />}
          {tab === "plan" && <CompPlan ranks={snap.ranks} tiers={snap.tiers} onChanged={load} />}
        </>
      )}
    </div>
  );
}

/* ---------------- Overview ---------------- */

function Kpi({ icon: Icon, label, value, tint }: { icon: typeof Users2; label: string; value: string; tint: string }) {
  return (
    <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-4 shadow-card">
      <div className="flex items-center gap-2">
        <span className={`grid h-8 w-8 place-items-center rounded-lg ${tint}`}><Icon className="h-4 w-4" /></span>
        <p className="text-xs font-semibold uppercase tracking-wide text-medium">{label}</p>
      </div>
      <p className="mt-2 text-2xl font-extrabold text-navy">{value}</p>
    </div>
  );
}

function Overview({ snap, onJump }: { snap: Snapshot; onJump: () => void }) {
  const k = snap.kpis;
  const maxRank = Math.max(1, ...snap.rank_dist.map((r) => r.count));
  const recent = snap.reps.slice(0, 6);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={Users2} label="Total reps" value={num(k.total_reps)} tint="bg-ice text-navy" />
        <Kpi icon={UserCheck} label="Active" value={num(k.active_reps)} tint="bg-[#e1f5ee] text-[#0f6e56]" />
        <Kpi icon={BadgeCheck} label="Distributors" value={num(k.distributors)} tint="bg-[#faeeda] text-gold-deep" />
        <Kpi icon={TrendingUp} label="New (30d)" value={num(k.new_30d)} tint="bg-[#e6f0ff] text-[#3a6ea5]" />
        <Kpi icon={DollarSign} label="Sales (all)" value={money(k.sales_total)} tint="bg-[#e1f5ee] text-[#0f6e56]" />
        <Kpi icon={DollarSign} label="Sales (30d)" value={money(k.sales_30d)} tint="bg-ice text-navy" />
        <Kpi icon={Coins} label="CV (all)" value={num(k.cv_total)} tint="bg-[#faeeda] text-gold-deep" />
        <Kpi icon={Coins} label="CV (30d)" value={num(k.cv_30d)} tint="bg-[#e6f0ff] text-[#3a6ea5]" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* rank distribution */}
        <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card">
          <h2 className="text-sm font-bold uppercase tracking-wide text-charcoal/70">Rank distribution</h2>
          <div className="mt-4 space-y-2.5">
            {snap.rank_dist.map((r) => (
              <div key={r.rank} className="flex items-center gap-3">
                <span className="w-48 flex-shrink-0 truncate text-sm text-navy">{r.rank}</span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-ice">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(r.count / maxRank) * 100}%` }} />
                </div>
                <span className="w-6 text-right text-sm font-bold text-navy">{r.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* recent joins */}
        <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-charcoal/70">Newest reps</h2>
            <button onClick={onJump} className="inline-flex items-center gap-1 text-xs font-bold text-gold-deep hover:opacity-80">
              View all <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-3 divide-y divide-[#EFE7D6]">
            {recent.map((r) => (
              <div key={r.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-navy">{r.full_name}</p>
                  <p className="text-xs text-medium">{r.rep_code} · {r.tier} · joined {date(r.joined_at)}</p>
                </div>
                <StatusPill status={r.status} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: Rep["status"] }) {
  const map = {
    active: "bg-[#e1f5ee] text-[#0f6e56]",
    inactive: "bg-[#fdeceb] text-[#b5382f]",
    pending: "bg-[#faeeda] text-gold-deep",
  };
  return <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold capitalize ${map[status]}`}>{status}</span>;
}

/* ---------------- Reps ---------------- */

function Reps({ reps }: { reps: Rep[] }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return reps;
    return reps.filter((r) =>
      (r.full_name ?? "").toLowerCase().includes(s) ||
      r.rep_code.toLowerCase().includes(s) ||
      (r.rank ?? "").toLowerCase().includes(s) ||
      (r.email ?? "").toLowerCase().includes(s)
    );
  }, [q, reps]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-medium" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, rep ID, rank, email…"
          className="w-full rounded-xl border border-[#E4DCCB] bg-cream py-3 pl-11 pr-4 text-sm text-navy placeholder:text-medium focus:border-primary focus:outline-none"
        />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-[#E4DCCB] bg-cream shadow-card">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#E4DCCB] text-xs uppercase tracking-wide text-medium">
              <th className="px-4 py-3 font-semibold">Rep ID</th>
              <th className="px-4 py-3 font-semibold">Name</th>
              <th className="px-4 py-3 font-semibold">Tier</th>
              <th className="px-4 py-3 font-semibold">Rank</th>
              <th className="px-4 py-3 font-semibold">Enroller</th>
              <th className="px-4 py-3 text-center font-semibold">Team</th>
              <th className="px-4 py-3 text-right font-semibold">Line CV</th>
              <th className="px-4 py-3 font-semibold">Joined</th>
              <th className="px-4 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EFE7D6]">
            {list.map((r) => (
              <tr key={r.id} className="hover:bg-offwhite/60">
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs font-bold text-gold-deep">{r.rep_code}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5 font-semibold text-navy">
                    {r.full_name}
                    {r.is_distributor && <BadgeCheck className="h-3.5 w-3.5 text-gold-deep" />}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-charcoal/80">{r.tier}</td>
                <td className="whitespace-nowrap px-4 py-3 text-charcoal/80">{r.rank}</td>
                <td className="whitespace-nowrap px-4 py-3 text-charcoal/70">{r.enroller ?? "—"}</td>
                <td className="px-4 py-3 text-center text-charcoal/80">{r.personal_enrollees}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-navy">{num(r.personal_cv)}</td>
                <td className="whitespace-nowrap px-4 py-3 text-charcoal/70">{date(r.joined_at)}</td>
                <td className="px-4 py-3"><StatusPill status={r.status} /></td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-sm text-medium">No reps match “{q}”.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Genealogy (enrollment tree) ---------------- */

function Tree({ reps }: { reps: Rep[] }) {
  const byParent = useMemo(() => {
    const m = new Map<string | null, Rep[]>();
    reps.forEach((r) => {
      const key = r.enroller_id;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(r);
    });
    return m;
  }, [reps]);

  const roots = reps.filter((r) => !r.enroller_id || !reps.some((x) => x.id === r.enroller_id));

  return (
    <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card">
      <h2 className="text-sm font-bold uppercase tracking-wide text-charcoal/70">Enrollment tree</h2>
      <p className="mt-1 text-xs text-medium">Who personally enrolled whom. Team counts in parentheses.</p>
      <div className="mt-4 space-y-1">
        {roots.map((r) => <Node key={r.id} rep={r} byParent={byParent} depth={0} />)}
      </div>
    </div>
  );
}

function Node({ rep, byParent, depth }: { rep: Rep; byParent: Map<string | null, Rep[]>; depth: number }) {
  const children = byParent.get(rep.id) ?? [];
  const [open, setOpen] = useState(depth < 1);
  return (
    <div>
      <div
        className="flex items-center gap-2 rounded-lg py-1.5 pr-2 hover:bg-offwhite/60"
        style={{ paddingLeft: `${depth * 20 + 4}px` }}
      >
        {children.length > 0 ? (
          <button onClick={() => setOpen((o) => !o)} className="grid h-5 w-5 flex-shrink-0 place-items-center rounded text-medium hover:bg-ice">
            <ChevronRight className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`} />
          </button>
        ) : (
          <span className="inline-block h-5 w-5 flex-shrink-0" />
        )}
        <span className={`grid h-7 w-7 flex-shrink-0 place-items-center rounded-full text-[10px] font-bold text-cream ${depth === 0 ? "bg-gold-deep" : "bg-primary"}`}>
          {(rep.full_name ?? "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
        </span>
        <span className="truncate text-sm font-semibold text-navy">{rep.full_name}</span>
        <span className="hidden font-mono text-[11px] text-gold-deep sm:inline">{rep.rep_code}</span>
        <span className="truncate text-xs text-medium">· {rep.rank}</span>
        {children.length > 0 && <span className="ml-auto flex-shrink-0 text-xs font-bold text-charcoal/60">({children.length})</span>}
      </div>
      {open && children.map((c) => <Node key={c.id} rep={c} byParent={byParent} depth={depth + 1} />)}
    </div>
  );
}

/* ---------------- Earnings (commission run) ---------------- */

type EarnRow = {
  rep_code: string; name: string | null; rank: string | null;
  left_cv: number; right_cv: number; referral: number; renewal: number;
  upgrade: number; override: number; rank_pay: number; membership_credit: number; total: number;
};
type EarningsData = {
  run: {
    total: number; reps: number; period_end: string | null;
    referral: number; renewal: number; override: number; rank_pay: number; credit: number;
  } | null;
  rows: EarnRow[];
};

function Earnings() {
  const supabase = useMemo(() => createClient(), []);
  const [data, setData] = useState<EarningsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data } = await supabase.rpc("mlm_earnings");
    setData((data as EarningsData) ?? null);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const run = async () => {
    if (!supabase) return;
    setRunning(true);
    await supabase.rpc("mlm_run_commissions");
    await load();
    setRunning(false);
  };

  if (loading) {
    return (
      <div className="grid place-items-center rounded-2xl border border-[#E4DCCB] bg-offwhite/40 py-16">
        <Loader2 className="h-6 w-6 animate-spin text-medium" />
      </div>
    );
  }

  const run0 = data?.run;
  const rows = data?.rows ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E4DCCB] bg-offwhite/50 p-4">
        <div className="text-sm text-charcoal/75">
          Commission run over the rolling 4-week window
          {run0?.period_end && <> · last run {date(run0.period_end)}</>}.
          <span className="ml-1 text-medium">Placeholder $ — verify against real numbers before paying.</span>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-cream transition hover:opacity-90 disabled:opacity-60"
        >
          {running ? <><Loader2 className="h-4 w-4 animate-spin" /> Running…</> : <><Play className="h-4 w-4" /> Run commissions</>}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={DollarSign} label="Total payout" value={money(run0?.total ?? 0)} tint="bg-[#e1f5ee] text-[#0f6e56]" />
        <Kpi icon={Wallet} label="Rank pay" value={money(run0?.rank_pay ?? 0)} tint="bg-ice text-navy" />
        <Kpi icon={UserCheck} label="Referral + renewal" value={money((run0?.referral ?? 0) + (run0?.renewal ?? 0))} tint="bg-[#e6f0ff] text-[#3a6ea5]" />
        <Kpi icon={Coins} label="Override + credit" value={money((run0?.override ?? 0) + (run0?.credit ?? 0))} tint="bg-[#faeeda] text-gold-deep" />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-[#E4DCCB] bg-cream shadow-card">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#E4DCCB] text-xs uppercase tracking-wide text-medium">
              <th className="px-4 py-3 font-semibold">Rep</th>
              <th className="px-4 py-3 font-semibold">Rank (period)</th>
              <th className="px-4 py-3 text-right font-semibold">L / R CV</th>
              <th className="px-4 py-3 text-right font-semibold">Referral</th>
              <th className="px-4 py-3 text-right font-semibold">Renewal</th>
              <th className="px-4 py-3 text-right font-semibold">Override</th>
              <th className="px-4 py-3 text-right font-semibold">Rank pay</th>
              <th className="px-4 py-3 text-right font-semibold">Credit</th>
              <th className="px-4 py-3 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EFE7D6]">
            {rows.map((r) => (
              <tr key={r.rep_code} className="hover:bg-offwhite/60">
                <td className="whitespace-nowrap px-4 py-3">
                  <span className="font-semibold text-navy">{r.name}</span>
                  <span className="ml-1.5 font-mono text-[11px] text-gold-deep">{r.rep_code}</span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-charcoal/80">{r.rank ?? "—"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-charcoal/70">{num(r.left_cv)} / {num(r.right_cv)}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{r.referral ? money(r.referral) : "—"}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{r.renewal ? money(r.renewal) : "—"}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{r.override ? money(r.override) : "—"}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{r.rank_pay ? money(r.rank_pay) : "—"}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{r.membership_credit ? money(r.membership_credit) : "—"}</td>
                <td className="px-4 py-3 text-right font-extrabold text-navy">{money(r.total)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-sm text-medium">No run yet — press “Run commissions”.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Comp Plan ---------------- */

type EditField = { key: string; label: string; type: "text" | "number"; value: string };

function CompPlan({ ranks, tiers, onChanged }: { ranks: Rank[]; tiers: Tier[]; onChanged: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [editRank, setEditRank] = useState<Rank | null>(null);
  const [editTier, setEditTier] = useState<Tier | null>(null);
  const [busy, setBusy] = useState(false);

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (!supabase) return;
    setBusy(true);
    await supabase.rpc(fn, args);
    setBusy(false);
    onChanged();
  };

  const saveRank = async (rec: Record<string, string>) => {
    if (!supabase || !editRank) return;
    setBusy(true);
    await supabase.rpc("mlm_update_rank", { p_id: editRank.id, p_patch: rec });
    setBusy(false); setEditRank(null); onChanged();
  };
  const saveTier = async (rec: Record<string, string>) => {
    if (!supabase || !editTier) return;
    setBusy(true);
    await supabase.rpc("mlm_update_tier", { p_id: editTier.id, p_patch: rec });
    setBusy(false); setEditTier(null); onChanged();
  };

  const rankFields = (r: Rank): EditField[] => [
    { key: "position", label: "Ladder position", type: "number", value: String(r.position) },
    { key: "name", label: "Rank name", type: "text", value: r.name },
    { key: "volume_per_side", label: "Volume / side", type: "number", value: String(r.volume_per_side) },
    { key: "enrollment_line_max_pct", label: "Enrollment line max %", type: "number", value: r.enrollment_line_max_pct != null ? String(r.enrollment_line_max_pct) : "" },
    { key: "weekly_cap", label: "Max weekly rank bonus", type: "number", value: String(r.weekly_cap) },
    { key: "monthly_cap", label: "Max monthly rank bonus", type: "number", value: String(r.monthly_cap) },
    { key: "active_requirement", label: "Active requirement", type: "text", value: r.active_requirement ?? "" },
    { key: "override_pct", label: "Override %", type: "number", value: String(r.override_pct) },
    { key: "qualification", label: "Qualification note", type: "text", value: r.qualification ?? "" },
  ];
  const tierFields = (t: Tier): EditField[] => [
    { key: "name", label: "Tier name", type: "text", value: t.name },
    { key: "price", label: "Price", type: "number", value: String(t.price) },
    { key: "renewal", label: "Monthly renewal", type: "number", value: String(t.renewal) },
    { key: "cv", label: "Commissionable volume (CV)", type: "number", value: String(t.cv) },
    { key: "referral_bonus", label: "Referral bonus", type: "number", value: String(t.referral_bonus) },
    { key: "renewal_bonus", label: "Renewal bonus", type: "number", value: String(t.renewal_bonus) },
    { key: "upgrade_bonus", label: "Upgrade bonus", type: "number", value: String(t.upgrade_bonus) },
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-4 text-sm text-charcoal/75">
        Your live comp-plan configuration. Edit any rank or tier, add or remove them — changes save straight to the
        engine, no rebuild. <span className="text-medium">Tier $ are placeholders; replace with your real numbers.</span>
      </div>

      {/* Ranks */}
      <div className="overflow-x-auto rounded-2xl border border-[#E4DCCB] bg-cream shadow-card">
        <div className="flex items-center justify-between border-b border-[#E4DCCB] px-4 py-3">
          <span className="text-sm font-bold text-navy">Ranks ({ranks.length})</span>
          <button onClick={() => rpc("mlm_add_rank", {})} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-cream hover:opacity-90 disabled:opacity-60">
            <Plus className="h-3.5 w-3.5" /> Add rank
          </button>
        </div>
        <table className="w-full min-w-[880px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#E4DCCB] text-xs uppercase tracking-wide text-medium">
              <th className="px-4 py-3 font-semibold">#</th>
              <th className="px-4 py-3 font-semibold">Rank</th>
              <th className="px-4 py-3 text-right font-semibold">Vol / side</th>
              <th className="px-4 py-3 text-right font-semibold">Line max %</th>
              <th className="px-4 py-3 text-right font-semibold">Weekly cap</th>
              <th className="px-4 py-3 text-right font-semibold">Monthly cap</th>
              <th className="px-4 py-3 font-semibold">Active req.</th>
              <th className="px-4 py-3 text-right font-semibold">Override</th>
              <th className="px-4 py-3 text-right font-semibold"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EFE7D6]">
            {ranks.map((r) => (
              <tr key={r.id} className="hover:bg-offwhite/60">
                <td className="px-4 py-3 text-medium">{r.position}</td>
                <td className="whitespace-nowrap px-4 py-3 font-semibold text-navy">{r.name}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{r.volume_per_side ? num(r.volume_per_side) : "—"}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{r.enrollment_line_max_pct != null ? `${r.enrollment_line_max_pct}%` : "—"}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{money(r.weekly_cap)}</td>
                <td className="px-4 py-3 text-right font-semibold text-navy">{money(r.monthly_cap)}</td>
                <td className="whitespace-nowrap px-4 py-3 text-charcoal/70">{r.active_requirement ?? "—"}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{r.override_pct ? `${r.override_pct}%` : "—"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <button onClick={() => setEditRank(r)} className="mr-1 rounded-md p-1.5 text-charcoal/60 hover:bg-ice hover:text-navy" aria-label="Edit"><Pencil className="h-4 w-4" /></button>
                  <button onClick={() => { if (confirm(`Delete rank “${r.name}”?`)) rpc("mlm_delete_rank", { p_id: r.id }); }} className="rounded-md p-1.5 text-charcoal/60 hover:bg-[#fdeceb] hover:text-red-500" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Tiers */}
      <div className="overflow-x-auto rounded-2xl border border-[#E4DCCB] bg-cream shadow-card">
        <div className="flex items-center justify-between border-b border-[#E4DCCB] px-4 py-3">
          <span className="text-sm font-bold text-navy">Membership tiers ({tiers.length})</span>
          <button onClick={() => rpc("mlm_add_tier", {})} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-cream hover:opacity-90 disabled:opacity-60">
            <Plus className="h-3.5 w-3.5" /> Add tier
          </button>
        </div>
        <table className="w-full min-w-[780px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#E4DCCB] text-xs uppercase tracking-wide text-medium">
              <th className="px-4 py-3 font-semibold">Tier</th>
              <th className="px-4 py-3 text-right font-semibold">Price</th>
              <th className="px-4 py-3 text-right font-semibold">Renewal</th>
              <th className="px-4 py-3 text-right font-semibold">CV</th>
              <th className="px-4 py-3 text-right font-semibold">Referral</th>
              <th className="px-4 py-3 text-right font-semibold">Renewal bonus</th>
              <th className="px-4 py-3 text-right font-semibold">Upgrade bonus</th>
              <th className="px-4 py-3 text-right font-semibold"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EFE7D6]">
            {tiers.map((t) => (
              <tr key={t.id} className="hover:bg-offwhite/60">
                <td className="whitespace-nowrap px-4 py-3 font-semibold text-navy">{t.name}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{money(t.price)}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{t.renewal ? money(t.renewal) : "—"}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{num(t.cv)}</td>
                <td className="px-4 py-3 text-right font-semibold text-[#0f6e56]">{money(t.referral_bonus)}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{money(t.renewal_bonus)}</td>
                <td className="px-4 py-3 text-right text-charcoal/80">{t.upgrade_bonus ? money(t.upgrade_bonus) : "—"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <button onClick={() => setEditTier(t)} className="mr-1 rounded-md p-1.5 text-charcoal/60 hover:bg-ice hover:text-navy" aria-label="Edit"><Pencil className="h-4 w-4" /></button>
                  <button onClick={() => { if (confirm(`Delete tier “${t.name}”?`)) rpc("mlm_delete_tier", { p_id: t.id }); }} className="rounded-md p-1.5 text-charcoal/60 hover:bg-[#fdeceb] hover:text-red-500" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editRank && <EditModal title={`Edit rank · ${editRank.name}`} fields={rankFields(editRank)} busy={busy} onClose={() => setEditRank(null)} onSave={saveRank} />}
      {editTier && <EditModal title={`Edit tier · ${editTier.name}`} fields={tierFields(editTier)} busy={busy} onClose={() => setEditTier(null)} onSave={saveTier} />}
    </div>
  );
}

function EditModal({
  title, fields, busy, onClose, onSave,
}: {
  title: string; fields: EditField[]; busy: boolean;
  onClose: () => void; onSave: (rec: Record<string, string>) => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.value])));

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-extrabold text-navy">{title}</h2>
          <button onClick={onClose} className="text-medium hover:text-navy"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <label key={f.key} className="block text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-medium">{f.label}</span>
              <input
                type={f.type}
                value={vals[f.key]}
                onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                className="w-full rounded-lg border border-[#E4DCCB] bg-offwhite/50 px-3 py-2 text-sm text-navy focus:border-primary focus:outline-none"
              />
            </label>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-[#E4DCCB] px-4 py-2.5 text-sm font-bold text-navy hover:bg-ice">Cancel</button>
          <button onClick={() => onSave(vals)} disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-cream hover:opacity-90 disabled:opacity-60">
            {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
