"use client";

/**
 * THE FLOW PASS — $99/mo, unmetered FLOW + GENX (owner 09-23).
 *
 * This is the hero offer on the Credits page, above the one-time packs, because it is the answer to
 * the problem the packs create: at the median member's burn a pack lasts 2–9 days, so a member who
 * wants FLOW running all month has to keep rebuying, and most simply stop. The card leads with that
 * arithmetic rather than a feature list — "a pack lasts about a week" is the reason to switch.
 *
 * Three states: OFFER (no pass), ACTIVE (has one), UPGRADE (legacy $39 Suite member). The upgrade
 * path reuses the same checkout; the webhook cancels their old subscription when the new one lands,
 * so they are never billed twice.
 */
import { useCallback, useEffect, useState } from "react";
import { Infinity as InfinityIcon, Check, Loader2, AlertTriangle, ArrowUpRight } from "lucide-react";

type PassView = {
  active: boolean;
  price: number;
  credits: number;
  label: string;
  canUpgrade: boolean;
};
type SubResp = {
  ok?: boolean;
  pass?: PassView;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: string | null;
};

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function FlowPassCard() {
  const [sub, setSub] = useState<SubResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/subscription", { cache: "no-store" });
      const d = (await r.json()) as SubResp;
      if (d?.ok) setSub(d);
    } catch { /* offline — the card just stays quiet */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function start() {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/subscription", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "subscribe_pass" }),
      });
      const d = await r.json();
      if (d?.url) { window.location.href = d.url as string; return; }
      if (d?.error === "stripe_not_configured") setMsg("Payments aren't switched on yet — check back soon.");
      else if (d?.error === "already_active") { setMsg("Your Pass is already running."); await load(); }
      else setMsg("Couldn't start checkout — try again shortly.");
    } catch { setMsg("Couldn't start checkout — try again shortly."); }
    setBusy(false);
  }

  async function cancel() {
    setBusy(true); setMsg("");
    try {
      await fetch("/api/subscription", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
      await load();
    } catch { setMsg("Network error — please try again."); }
    setBusy(false);
  }

  async function resume() {
    setBusy(true); setMsg("");
    try {
      await fetch("/api/subscription", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resume" }) });
      await load();
    } catch { setMsg("Network error — please try again."); }
    setBusy(false);
  }

  const pass = sub?.pass;
  if (!pass) return null;
  const price = pass.price;
  const credits = pass.credits;

  const benefits = (
    <ul className="mt-4 space-y-1.5 text-sm text-white/85">
      <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> FLOW and GENX run all month — no credits, no pausing, no running out</li>
      <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> Every setup and every fill, on every account you connect</li>
      <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> {credits} credits a month for the rest of the site — OM AI, Market Pulse, MFXGHOST</li>
    </ul>
  );

  return (
    <section className="rounded-2xl border border-[#E4DCCB] bg-gradient-to-br from-navy to-[#12294b] p-6 text-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <InfinityIcon className="h-4 w-4 text-amber-300" aria-hidden="true" /> {pass.label}
        </h2>
        {pass.active && (
          <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300">
            {sub?.cancelAtPeriodEnd ? "Ends " + fmt(sub?.currentPeriodEnd) : "Active"}
          </span>
        )}
        {!pass.active && (
          <span className="rounded-full bg-amber-400/15 px-3 py-1 text-xs font-bold text-amber-200">${price}/mo</span>
        )}
      </div>

      {pass.active ? (
        <div className="mt-1">
          {benefits}
          {sub?.cancelAtPeriodEnd ? (
            <div className="mt-4 flex flex-col gap-2">
              <p className="text-xs text-amber-200">Your Pass ends {fmt(sub?.currentPeriodEnd)}. FLOW keeps running until then, and goes back to costing credits after.</p>
              <button onClick={() => void resume()} disabled={busy} className="inline-flex w-fit items-center gap-2 rounded-xl bg-amber-400 px-4 py-2 text-sm font-bold text-[#20160a] disabled:opacity-60">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Keep my Pass
              </button>
            </div>
          ) : (
            <div className="mt-4">
              <p className="text-xs text-white/55">Renews at ${price}/mo on {fmt(sub?.currentPeriodEnd)}.</p>
              <button onClick={() => void cancel()} disabled={busy} className="mt-2 inline-flex items-center gap-2 rounded-xl border border-white/25 px-4 py-2 text-sm font-semibold text-white/80 hover:bg-white/10 disabled:opacity-60">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Cancel Pass
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-1">
          <p className="text-sm text-white/80">
            {pass.canUpgrade
              ? "You're on the old $39 plan, which still meters FLOW by the credit. The Pass takes the meter off entirely — we'll cancel the $39 automatically so you're never billed twice."
              : "Running FLOW costs most members more than a pack a week. The Pass takes the meter off: one price, it just runs."}
          </p>
          {benefits}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button onClick={() => void start()} disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-300 to-amber-500 px-5 py-2.5 text-sm font-extrabold text-[#20160a] disabled:opacity-60">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}
              {pass.canUpgrade ? `Upgrade to $${price}/mo` : `Get the Pass — $${price}/mo`}
            </button>
            <span className="text-xs text-white/55">Cancel anytime, right here.</span>
          </div>
        </div>
      )}
      {msg && (
        <p className="mt-3 flex items-center gap-2 text-xs text-amber-200"><AlertTriangle className="h-3.5 w-3.5" /> {msg}</p>
      )}
    </section>
  );
}
