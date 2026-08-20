"use client";

/**
 * SuiteFlyer — a one-time welcome modal that introduces the $39/mo Trading Suite
 * the first time a member reaches the portal. Shows ONCE per device (persistent
 * localStorage flag), never again after they dismiss or subscribe, and never to a
 * member who already has an active subscription. Skipped inside the mobile-app
 * embed frame. Force it any time with `?suiteflyer=1` for preview.
 *
 * The CTA starts the real Stripe subscription checkout via /api/subscription.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Sparkles, Check, Loader2, ShieldCheck, Zap } from "lucide-react";

const SEEN_KEY = "om-suite-flyer-v1"; // persistent: only ever show this once per device
const GOLD = "#ffc24b";
const BULL = "#2ee88f";

export function SuiteFlyer() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [price, setPrice] = useState(39);
  const [credits, setCredits] = useState(250);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Never inside the app's embedded tool frames.
    if (document.documentElement.classList.contains("om-embed")) return;
    let forced = false;
    try { forced = new URLSearchParams(window.location.search).get("suiteflyer") === "1"; } catch { /* */ }
    let seen = false;
    try { seen = localStorage.getItem(SEEN_KEY) === "1"; } catch { /* */ }
    if (seen && !forced) return;

    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/subscription", { cache: "no-store" });
        const d = await r.json();
        if (cancelled) return;
        if (typeof d?.price === "number") setPrice(d.price);
        if (typeof d?.credits === "number") setCredits(d.credits);
        // Already a member → don't pitch it; remember so we don't re-check every load.
        if (d?.active && !forced) { markSeen(); return; }
      } catch { /* show anyway on a network hiccup */ }
      if (!cancelled) setOpen(true);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  function markSeen() { try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* */ } }
  function dismiss() { markSeen(); setOpen(false); }

  async function subscribe() {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/subscription", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "subscribe" }) });
      const d = await r.json();
      if (d?.url) { markSeen(); window.location.href = d.url as string; return; }
      if (d?.error === "stripe_not_configured") setMsg("Payments aren't switched on yet — check back soon.");
      else setMsg("Couldn't start checkout — please try again.");
    } catch { setMsg("Couldn't start checkout — please try again."); }
    setBusy(false);
  }

  if (!mounted || !open) return null;

  const flyer = (
    <div
      className="fixed inset-0 z-[95] flex items-end justify-center overflow-y-auto bg-black/75 p-0 backdrop-blur-md sm:items-center sm:p-4"
      role="dialog" aria-modal="true" aria-label="Trading Suite"
      onClick={dismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg overflow-hidden rounded-t-3xl border shadow-2xl sm:rounded-3xl"
        style={{ background: "linear-gradient(165deg,#111319 0%,#0b0c10 46%,#14110a 100%)", borderColor: "rgba(255,194,75,0.28)" }}
      >
        <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full opacity-40 blur-3xl" style={{ background: "radial-gradient(circle,#ffc24b55,transparent 70%)" }} />

        <button onClick={dismiss} aria-label="Close"
          className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-white/55 transition hover:bg-white/10 hover:text-white">
          <X className="h-4 w-4" />
        </button>

        <div className="relative px-6 pt-7 sm:px-8">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: GOLD }}>
            <Sparkles className="h-3.5 w-3.5" /> One Mission · New
          </div>
          <h2 className="mt-3 font-serif text-[26px] font-extrabold leading-tight text-white sm:text-[30px]">
            Let the platform <span style={{ color: GOLD }}>trade for you</span>.
          </h2>
          <p className="mt-2 text-[14px] leading-relaxed text-white/60">
            The Trading Suite runs your accounts on autopilot — takes the setups, moves your stop to breakeven, banks partials, and trails the runner like a pro. Add it to your membership for just <span className="font-semibold text-white">${price}/mo</span>.
          </p>
        </div>

        <div className="relative mt-5 px-6 sm:px-8">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <ul className="space-y-2 text-[13.5px] text-white/85">
              <li className="flex items-start gap-2.5"><Check className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: BULL }} /> <span><b className="text-white">Free auto-run every 5 minutes</b> — no per-run credit charge (others pay a credit each run).</span></li>
              <li className="flex items-start gap-2.5"><Check className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: BULL }} /> <span>The pro trade-manager on every fill — breakeven, partials, trailing stop.</span></li>
              <li className="flex items-start gap-2.5"><Check className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: BULL }} /> <span>GENX Gold engine, FLOW, and OM AI Plays — trade every connected account at once.</span></li>
              <li className="flex items-start gap-2.5"><Check className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: BULL }} /> <span><b className="text-white">{credits} credits every month</b> for AI chat, deep dives &amp; chart reads.</span></li>
            </ul>
          </div>
        </div>

        <div className="relative mt-5 px-6 pb-7 sm:px-8">
          {msg && <div className="mb-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-200">{msg}</div>}
          <button onClick={subscribe} disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-[16px] font-extrabold text-[#20160a] transition disabled:opacity-60"
            style={{ background: "linear-gradient(135deg,#ffd77a,#e0a83c)" }}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />} Add the Trading Suite — ${price}/mo
          </button>
          <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-white/40">
            <ShieldCheck className="h-3.5 w-3.5" style={{ color: BULL }} /> Cancel anytime in your Backoffice · secure checkout by Stripe
          </div>
          <button onClick={dismiss} className="mx-auto mt-3 block text-[12px] font-medium text-white/40 transition hover:text-white/70">
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(flyer, document.body);
}
