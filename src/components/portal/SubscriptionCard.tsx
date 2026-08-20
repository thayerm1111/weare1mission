"use client";

import { useEffect, useState } from "react";
import { Sparkles, Check, Loader2 } from "lucide-react";

type SubView = {
  active: boolean;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  price: number;
  credits: number;
};

function fmt(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Trading Suite membership panel for the account (Backoffice) page. Shows status
 * and lets the member subscribe, cancel (at period end), or resume — all on their
 * own subscription. Payment + entitlement changes happen through Stripe + webhook.
 */
export function SubscriptionCard() {
  const [sub, setSub] = useState<SubView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function load() {
    try {
      const r = await fetch("/api/subscription", { cache: "no-store" });
      const d = await r.json();
      if (d?.ok) setSub(d as SubView);
    } catch { /* offline */ }
  }
  useEffect(() => { load(); }, []);

  async function act(action: "subscribe" | "cancel" | "resume") {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/subscription", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const d = await r.json();
      if (d?.url) { window.location.href = d.url as string; return; }
      if (d?.error === "stripe_not_configured") setMsg("Payments aren't switched on yet.");
      else if (d?.error) setMsg("Something went wrong — please try again.");
      else await load();
    } catch { setMsg("Network error — please try again."); }
    setBusy(false);
  }

  const price = sub?.price ?? 39;
  const credits = sub?.credits ?? 250;
  const active = !!sub?.active;

  return (
    <section className="rounded-2xl border border-[#E4DCCB] bg-gradient-to-br from-navy to-[#12294b] p-6 text-white shadow-card">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <Sparkles className="h-4 w-4 text-amber-300" aria-hidden="true" /> Trading Suite
        </h2>
        {active && (
          <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300">
            {sub?.cancelAtPeriodEnd ? "Ends " + fmt(sub?.currentPeriodEnd ?? null) : "Active"}
          </span>
        )}
      </div>

      {active ? (
        <div className="mt-4">
          <ul className="space-y-1.5 text-sm text-white/85">
            <li className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-300" /> Auto-run free — every 5 min, no per-run credit</li>
            <li className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-300" /> {credits} credits refresh each month</li>
            <li className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-300" /> GENX, FLOW, OM AI Plays &amp; trade-manager unlocked</li>
          </ul>
          {sub?.cancelAtPeriodEnd ? (
            <div className="mt-4 flex flex-col gap-2">
              <p className="text-xs text-amber-200">Your subscription is set to end on {fmt(sub?.currentPeriodEnd ?? null)}. You keep access until then.</p>
              <button onClick={() => act("resume")} disabled={busy} className="inline-flex w-fit items-center gap-2 rounded-xl bg-amber-400 px-4 py-2 text-sm font-bold text-[#20160a] disabled:opacity-60">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Keep my subscription
              </button>
            </div>
          ) : (
            <div className="mt-4">
              <p className="text-xs text-white/55">Renews at ${price}/mo on {fmt(sub?.currentPeriodEnd ?? null)}.</p>
              <button onClick={() => act("cancel")} disabled={busy} className="mt-2 inline-flex items-center gap-2 rounded-xl border border-white/25 px-4 py-2 text-sm font-semibold text-white/80 hover:bg-white/10 disabled:opacity-60">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Cancel subscription
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-4">
          <p className="text-sm text-white/80">Let the platform trade for you — auto-run every 5 minutes (free for members), the pro trade-manager on every fill, {credits} credits a month, and every tool unlocked.</p>
          <div className="mt-4 flex items-center gap-3">
            <button onClick={() => act("subscribe")} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-300 to-amber-500 px-5 py-2.5 text-sm font-extrabold text-[#20160a] disabled:opacity-60">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Add for ${price}/mo
            </button>
            <span className="text-xs text-white/55">Cancel anytime, right here.</span>
          </div>
        </div>
      )}
      {msg && <p className="mt-3 text-xs text-amber-200">{msg}</p>}
    </section>
  );
}
