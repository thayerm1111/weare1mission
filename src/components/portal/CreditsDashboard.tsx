"use client";

/**
 * Admin credits & conversion dashboard. Calls the admin-only
 * `admin_credits_overview` RPC (self-gated on admin, SECURITY DEFINER) and
 * refreshes on demand + every 60s. Built to answer one question: who is
 * running low and therefore ready to buy a pack?
 */

import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw, Flame, Coins, ShoppingCart, Users, Sparkles, TrendingUp, AlertCircle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { DAILY_FREE } from "@/lib/creditConfig";

type Watch = { name: string; email: string; balance: number; last_active: string; lifetime_spent: number };
type Spender = { name: string; email: string; spent: number; actions: number };
type Feat = { feature: string; uses: number; users: number };
type Overview = {
  generated_at: string;
  totals: { used_all: number; used_24h: number; used_7d: number; actions_24h: number; actions_7d: number; spenders: number };
  sold: { credits_purchased: number; pack_count: number; buyers: number };
  members: { total: number; active_24h: number; active_7d: number };
  watchlist: Watch[];
  untapped: number;
  top_spenders: Spender[];
  features: Feat[];
};

const FEAT_LABEL: Record<string, string> = {
  signal: "OM AI Plays", ghost: "MFXGHOST", scan: "Strategy Scanner", deepdive: "Deep Dive",
  command: "Market Command", chat: "OM AI Chat", chartread: "Chart Read",
};

const nf = (n: number) => (n ?? 0).toLocaleString();

function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function CreditsDashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) { setErr("Supabase isn't configured."); setLoading(false); return; }
    setErr("");
    const { data: d, error } = await supabase.rpc("admin_credits_overview");
    if (error) { setErr(error.message || "Couldn't load the dashboard."); setLoading(false); return; }
    setData(d as Overview);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60000);
    return () => clearInterval(t);
  }, [load]);

  if (loading && !data) {
    return <div className="grid place-items-center rounded-2xl border border-[#E4DCCB] bg-cream/60 py-16 text-charcoal/50"><RefreshCw className="h-5 w-5 animate-spin" /></div>;
  }
  if (err && !data) {
    return <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-800"><AlertCircle className="mr-1 inline h-4 w-4" /> {err}</div>;
  }
  if (!data) return null;

  const lowFloor = data.watchlist.filter((w) => w.balance <= DAILY_FREE).length;

  return (
    <div className="space-y-6">
      {/* Refresh row */}
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.14em] text-charcoal/45">
          Live · updated {ago(data.generated_at)}
        </p>
        <button onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#E4DCCB] bg-offwhite/60 px-3 py-1.5 text-xs font-semibold text-charcoal/70 transition-colors hover:bg-ice disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {/* Headline stat tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<Coins className="h-4 w-4" />} label="Credits used · 7d" value={nf(data.totals.used_7d)} sub={`${nf(data.totals.used_24h)} in last 24h`} />
        <Stat icon={<Users className="h-4 w-4" />} label="Active users · 7d" value={nf(data.members.active_7d)} sub={`${nf(data.members.active_24h)} today · ${nf(data.members.total)} members`} />
        <Stat icon={<ShoppingCart className="h-4 w-4" />} label="Packs sold" value={nf(data.sold.pack_count)} sub={`${nf(data.sold.credits_purchased)} credits · ${nf(data.sold.buyers)} buyer${data.sold.buyers === 1 ? "" : "s"}`} tone="gold" />
        <Stat icon={<Flame className="h-4 w-4" />} label="Running low" value={nf(data.watchlist.length)} sub={`${lowFloor} at the free floor`} tone={data.watchlist.length > 0 ? "hot" : undefined} />
      </div>

      {/* Buy-ready watchlist — the star of the show */}
      <section className="rounded-2xl border border-[#E4DCCB] bg-cream shadow-card">
        <div className="flex items-center justify-between border-b border-[#E4DCCB] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-primary"><Flame className="h-4 w-4 text-cream" /></span>
            <div className="leading-tight">
              <h2 className="text-sm font-bold text-navy">Running low — buy-ready</h2>
              <p className="text-[11px] text-charcoal/55">Members who&apos;ve used the tools and are near the {DAILY_FREE}-credit daily floor</p>
            </div>
          </div>
          <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary">{data.watchlist.length}</span>
        </div>
        {data.watchlist.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-charcoal/50">Nobody&apos;s low right now — everyone&apos;s got runway.</p>
        ) : (
          <div className="divide-y divide-[#EFE9DC]">
            {data.watchlist.map((w) => {
              const atFloor = w.balance <= DAILY_FREE;
              return (
                <div key={w.email} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-navy">{w.name}</p>
                    <p className="truncate text-[11px] text-charcoal/50">{w.email} · used {nf(w.lifetime_spent)} so far · {ago(w.last_active)}</p>
                  </div>
                  <span className={`flex-shrink-0 rounded-full px-2.5 py-1 text-xs font-bold tabular-nums ${atFloor ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                    {nf(w.balance)}{atFloor ? " · at floor" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Untapped + secondary panels */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-primary/10"><Sparkles className="h-5 w-5 text-primary" /></span>
            <div>
              <p className="text-2xl font-extrabold text-navy">{nf(data.untapped)}</p>
              <p className="text-sm font-semibold text-navy">Untapped members</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-charcoal/60">
                Signed up, still holding their welcome credits, haven&apos;t run a single tool yet. Getting these to try a play is your first conversion lever — they can&apos;t buy until they see the value.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-5">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-navy"><TrendingUp className="h-4 w-4 text-primary" /> Most-used tools · 7d</h3>
          <div className="mt-3 space-y-2">
            {data.features.map((f) => {
              const max = Math.max(1, ...data.features.map((x) => x.uses));
              return (
                <div key={f.feature}>
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="font-medium text-charcoal/80">{FEAT_LABEL[f.feature] ?? f.feature}</span>
                    <span className="tabular-nums text-charcoal/55">{nf(f.uses)} runs · {nf(f.users)} ppl</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#EADFCB]">
                    <div className="h-full rounded-full bg-gradient-primary" style={{ width: `${Math.round((f.uses / max) * 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Top spenders */}
      <section className="rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-5">
        <h3 className="flex items-center gap-1.5 text-sm font-bold text-navy"><Coins className="h-4 w-4 text-primary" /> Power users — most credits spent</h3>
        {data.top_spenders.length === 0 ? (
          <p className="mt-3 text-sm text-charcoal/50">No spending yet.</p>
        ) : (
          <div className="mt-3 divide-y divide-[#EFE9DC]">
            {data.top_spenders.map((s, i) => (
              <div key={s.email} className="flex items-center justify-between gap-3 py-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="grid h-5 w-5 flex-shrink-0 place-items-center rounded-full bg-navy/5 text-[11px] font-bold text-charcoal/60">{i + 1}</span>
                  <p className="truncate text-sm font-medium text-navy">{s.name}</p>
                </div>
                <span className="flex-shrink-0 text-xs tabular-nums text-charcoal/60">{nf(s.spent)} credits · {nf(s.actions)} runs</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-center text-[11px] text-charcoal/40">
        Refreshes automatically every minute · weekly free floor is {DAILY_FREE} credits, so nobody gets locked out — “running low” means they&apos;re ripe to buy more.
      </p>
    </div>
  );
}

function Stat({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: "gold" | "hot" }) {
  const ring = tone === "hot" ? "border-primary/40 bg-primary/[0.04]" : tone === "gold" ? "border-[#E4DCCB] bg-gradient-to-br from-cream to-offwhite" : "border-[#E4DCCB] bg-cream";
  const ic = tone === "hot" ? "bg-gradient-primary text-cream" : "bg-primary/10 text-primary";
  return (
    <div className={`rounded-2xl border p-4 shadow-card ${ring}`}>
      <div className="flex items-center gap-2">
        <span className={`grid h-7 w-7 place-items-center rounded-full ${ic}`}>{icon}</span>
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-charcoal/50">{label}</p>
      </div>
      <p className="mt-2 text-3xl font-extrabold tabular-nums text-navy">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-charcoal/55">{sub}</p>}
    </div>
  );
}
