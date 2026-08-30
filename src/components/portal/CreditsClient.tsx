"use client";

/**
 * Credits — balance + buy page, in the One Mission palette. Shows the member's
 * weekly free credits and purchased balance, what each action costs, and the
 * buyable packs (Stripe checkout). Free credits reset weekly; purchased stack.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Zap, Sparkles, TrendingUp, Search, Activity, Check, Loader2, AlertTriangle, CreditCard,
} from "lucide-react";
import { AutoRefillCard } from "@/components/portal/AutoRefillCard";

type Balance = { dailyLeft: number; purchased: number; dailyAllowance: number };
type Pack = { id: string; label: string; credits: number; priceUsd: number; blurb: string; best?: boolean };
type Costs = Record<string, number>;

const COST_ROWS: { key: string; label: string; icon: typeof Zap }[] = [
  { key: "chat", label: "OM AI chat message", icon: Sparkles },
  { key: "signal", label: "Generate a play", icon: TrendingUp },
  { key: "deepdive", label: "Deep dive breakdown", icon: Search },
  { key: "scan", label: "Market Pulse scan", icon: Activity },
];

export function CreditsClient() {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [costs, setCosts] = useState<Costs>({});
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [banner, setBanner] = useState<"success" | "canceled" | "">("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/credits", { cache: "no-store" });
      const d = await r.json();
      if (d.balance) setBalance(d.balance);
      if (Array.isArray(d.packs)) setPacks(d.packs);
      if (d.costs) setCosts(d.costs);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    try {
      const p = new URLSearchParams(window.location.search);
      if (p.get("success")) { setBanner("success"); window.history.replaceState({}, "", "/portal/credits"); }
      else if (p.get("canceled")) { setBanner("canceled"); window.history.replaceState({}, "", "/portal/credits"); }
    } catch { /* ignore */ }
  }, [load]);

  async function buy(packId: string) {
    setBuying(packId); setMsg("");
    try {
      const r = await fetch("/api/stripe/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packId }) });
      const d = await r.json();
      if (d.url) { window.location.href = d.url; return; }
      if (d.error === "stripe_not_configured") setMsg("Payments aren't switched on yet — check back soon.");
      else setMsg("Couldn't start checkout — try again shortly.");
    } catch { setMsg("Couldn't start checkout — try again shortly."); }
    finally { setBuying(null); }
  }

  const dailyLeft = balance?.dailyLeft ?? 0;
  const allowance = balance?.dailyAllowance ?? 0;
  const purchased = balance?.purchased ?? 0;
  const total = dailyLeft + purchased;

  return (
    <div className="space-y-6">
      <div>
        <span className="eyebrow">Your Account</span>
        <h1 className="mt-2 font-serif text-2xl font-semibold uppercase tracking-[0.02em] text-navy">Credits</h1>
        <p className="mt-1 text-sm text-charcoal/60">Free credits reset every week. Buy more anytime — purchased credits never expire.</p>
      </div>

      {banner === "success" && (
        <div className="flex items-center gap-2 rounded-xl border border-navy/15 bg-navy/[0.04] px-4 py-3 text-sm text-navy">
          <Check className="h-4 w-4" /> Payment received — your credits have been added. Thanks!
        </div>
      )}
      {banner === "canceled" && (
        <div className="rounded-xl border border-ice bg-offwhite px-4 py-3 text-sm text-charcoal/70">
          Checkout canceled — no charge was made.
          <span className="mt-1 block text-[13px] text-charcoal/55">If your card was declined, your bank may have flagged it as an unusual charge. Call the number on the back of your card to approve it, then try again.</span>
        </div>
      )}

      {/* Balance */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-[#E7E4DD] bg-white p-5 shadow-card">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-charcoal/45"><Zap className="h-3.5 w-3.5 text-primary" /> Available now</div>
          <div className="mt-1 font-serif text-3xl font-bold text-navy">{loading ? "—" : total.toLocaleString()}</div>
          <p className="mt-0.5 text-[11px] text-charcoal/45">credits ready to use</p>
        </div>
        <div className="rounded-2xl border border-[#E7E4DD] bg-white p-5 shadow-card">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">Free today</div>
          <div className="mt-1 font-serif text-3xl font-bold text-navy">{loading ? "—" : dailyLeft}<span className="text-base font-normal text-charcoal/40">/{allowance}</span></div>
          <p className="mt-0.5 text-[11px] text-charcoal/45">resets at midnight UTC</p>
        </div>
        <div className="rounded-2xl border border-[#E7E4DD] bg-white p-5 shadow-card">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">Purchased</div>
          <div className="mt-1 font-serif text-3xl font-bold text-navy">{loading ? "—" : purchased.toLocaleString()}</div>
          <p className="mt-0.5 text-[11px] text-charcoal/45">never expires</p>
        </div>
      </div>

      {/* Auto-refill — FRONT AND CENTER (owner directive 08-30): every member who lands on the
          credits page sees the card-on-file option before the one-time packs. The card itself
          handles setup, toggle, and status; it links to Stripe's hosted page for the card. */}
      <AutoRefillCard />

      {/* What costs what */}
      <div className="rounded-2xl border border-[#E7E4DD] bg-white p-5 shadow-card">
        <h2 className="text-[11px] font-bold uppercase tracking-wide text-charcoal/45">What each action costs</h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {COST_ROWS.map((c) => {
            const Icon = c.icon; const cost = costs[c.key];
            return (
              <li key={c.key} className="flex items-center justify-between rounded-lg bg-offwhite/60 px-3 py-2">
                <span className="flex items-center gap-2 text-sm text-charcoal/75"><Icon className="h-4 w-4 text-primary" /> {c.label}</span>
                <span className="text-sm font-bold text-navy">{cost ?? "—"} {cost === 1 ? "credit" : "credits"}</span>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[11px] text-charcoal/45">Plays of the Week and the Daily Market Brief are free — they’re shared across the whole community.</p>
      </div>

      {/* Packs */}
      <div>
        <h2 className="text-[11px] font-bold uppercase tracking-wide text-charcoal/45">Buy more credits</h2>
        {msg && (
          <div className="mt-2 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4" /> {msg}
          </div>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {packs.map((p) => (
            <div key={p.id} className={`relative rounded-2xl border bg-white p-5 shadow-card ${p.best ? "border-gold/50" : "border-[#E7E4DD]"}`}>
              {p.best && <span className="absolute -top-2 left-5 rounded-full bg-gold px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">Best value</span>}
              <div className="font-serif text-sm font-semibold uppercase tracking-[0.12em] text-navy">{p.label}</div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="font-serif text-3xl font-bold text-navy">{p.credits.toLocaleString()}</span>
                <span className="text-sm text-charcoal/45">credits</span>
              </div>
              <p className="mt-1 text-[11px] text-charcoal/50">{p.blurb}</p>
              <button onClick={() => void buy(p.id)} disabled={buying === p.id}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-cream transition-colors hover:bg-navy focus-ring disabled:opacity-50">
                {buying === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />} ${p.priceUsd}
              </button>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-charcoal/40">Secure checkout by Stripe · one-time purchase, no subscription.</p>
        <p className="mt-1 text-[11px] text-charcoal/40">Card declined? Some banks automatically block first-time or online charges — a quick call to the number on your card to approve it usually clears it. Then try again.</p>
      </div>
    </div>
  );
}
