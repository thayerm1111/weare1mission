"use client";

import { useEffect, useState } from "react";
import { Zap, CreditCard, Loader2 } from "lucide-react";

type AutoRefillView = {
  ok: boolean;
  enabled: boolean;
  status: string; // "active" | "paused" | ...
  hasCard: boolean;
  card?: { brand?: string | null; last4?: string | null } | null;
  threshold: number;
  refillCredits: number;
  refillPriceCents: number;
  manualCredits: number;
  manualPriceCents: number;
  options?: { credits: number; priceCents: number }[];
};

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Auto-refill credits panel for the account (Backoffice) page — the website twin of the
 * mobile app's Account-screen card. Lets a member keep a card on file so credits top up
 * automatically below the threshold, replace the card, or buy a one-time manual top-up.
 * All payment + card capture happens on Stripe's hosted page via /api/autorefill.
 */
export function AutoRefillCard() {
  const [d, setD] = useState<AutoRefillView | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = await fetch("/api/autorefill", { cache: "no-store" });
      const j = await r.json();
      if (j?.ok) setD(j as AutoRefillView);
    } catch { /* offline */ }
  }
  useEffect(() => { load(); }, []);

  async function go(action: "setup" | "manual" | "removecard") {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/autorefill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const j = await r.json();
      if (j?.url) { window.location.href = j.url as string; return; }
      await load();
    } catch { /* ignore */ }
    setBusy(false);
  }

  async function pickPlan(credits: number) {
    if (busy || d?.refillCredits === credits) return;
    setBusy(true);
    try {
      await fetch("/api/autorefill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "plan", credits }) });
      await load();
    } catch { /* ignore */ }
    setBusy(false);
  }

  async function toggle(on: boolean) {
    if (busy) return;
    if (on && !d?.hasCard) { go("setup"); return; } // no card yet → Stripe to add one
    setBusy(true);
    try {
      const r = await fetch("/api/autorefill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "toggle", enabled: on }) });
      const j = await r.json();
      if (j?.error === "needs_card") { setBusy(false); go("setup"); return; }
      await load();
    } catch { /* ignore */ }
    setBusy(false);
  }

  if (!d) return null;
  const on = !!d.enabled;
  const paused = d.status === "paused";
  const priceRefill = dollars(d.refillPriceCents);
  const priceManual = dollars(d.manualPriceCents);

  return (
    <section id="autorefill" className="scroll-mt-24 rounded-2xl border border-[#E4DCCB] bg-cream p-6 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-bold text-navy">
            <Zap className="h-4 w-4 text-emerald-600" aria-hidden="true" /> Auto-refill credits
          </h2>
          <p className="mt-1 text-sm text-charcoal/60">Keep FLOW auto-trading running — never miss a play.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => toggle(!on)}
          disabled={busy}
          className={`relative h-7 w-12 flex-none rounded-full transition-colors disabled:opacity-60 ${on ? "bg-emerald-500" : "bg-charcoal/20"}`}
        >
          <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-6" : "left-1"}`} />
        </button>
      </div>

      {paused && (
        <div className="mt-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          Auto-refill paused — we couldn&apos;t charge your card. Re-add it below to turn it back on.
        </div>
      )}

      <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2.5 text-sm leading-relaxed text-charcoal/75">
        <b className="text-emerald-700">Why keep a card on file?</b> FLOW spends 1 credit each auto-run. Hit 0 and auto-trading{" "}
        <b className="text-navy">pauses</b> — the desk keeps taking plays without you until you top up. With auto-refill on, credits top up by
        themselves the moment you run low, so FLOW never stops and you never miss a trade.
      </div>

      <p className="mt-2 text-sm text-charcoal/70">
        When your balance drops below <b className="text-navy">{d.threshold}</b> credits, we charge your card{" "}
        <b className="text-navy">{priceRefill}</b> for <b className="text-navy">{d.refillCredits}</b> credits — automatically, until you turn this off.
      </p>

      {/* Refill size — the member's choice of how much each automatic top-up adds. */}
      {(d.options?.length ?? 0) > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-charcoal/45">Refill amount</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {d.options!.map((o) => {
              const selected = d.refillCredits === o.credits;
              return (
                <button
                  key={o.credits}
                  type="button"
                  onClick={() => void pickPlan(o.credits)}
                  disabled={busy}
                  aria-pressed={selected}
                  className={`rounded-xl border px-3 py-2.5 text-sm font-bold transition-colors disabled:opacity-60 ${
                    selected
                      ? "border-emerald-500 bg-emerald-500/10 text-navy ring-1 ring-emerald-500"
                      : "border-[#E4DCCB] bg-offwhite/60 text-charcoal/70 hover:bg-offwhite"
                  }`}
                >
                  {o.credits} credits
                  <span className={`block text-[11px] font-semibold ${selected ? "text-emerald-700" : "text-charcoal/45"}`}>{dollars(o.priceCents)} per refill</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        {d.hasCard ? (
          <>
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-[#E4DCCB] bg-offwhite/60 px-3 py-2.5 text-sm font-semibold text-navy">
              <CreditCard className="h-4 w-4 text-charcoal/50" aria-hidden="true" />
              {(d.card?.brand ? d.card.brand.toUpperCase() : "Card")} ···· {d.card?.last4 ?? "••••"}
            </div>
            <button type="button" onClick={() => go("setup")} disabled={busy} className="rounded-xl border border-[#E4DCCB] px-4 py-2.5 text-sm font-semibold text-navy hover:bg-offwhite disabled:opacity-60">
              Replace
            </button>
          </>
        ) : (
          <button type="button" onClick={() => go("setup")} disabled={busy} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-400 to-emerald-600 px-5 py-2.5 text-sm font-extrabold text-white disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />} Add a card
          </button>
        )}
      </div>

      <button type="button" onClick={() => go("manual")} disabled={busy} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[#E4DCCB] bg-offwhite/60 px-4 py-3 text-sm font-bold text-navy hover:bg-offwhite disabled:opacity-60">
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Add {d.manualCredits} credits now — {priceManual}
      </button>

      <p className="mt-3 text-center text-[11px] text-charcoal/45">Secure checkout by Stripe · cancel anytime</p>
    </section>
  );
}
