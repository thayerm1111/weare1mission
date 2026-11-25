"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CreditCard, Droplets, Loader2, LockKeyhole, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import type { NitrousAddonAccess } from "@/lib/nitrous/addon-policy";

function billingDate(value: string | null | undefined) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
}

/** Billing state comes from the server; returning from Checkout never grants access in the browser. */
export function NitrousAddonPanel({ addon, loading, unavailable, onUpdated }: {
  addon: NitrousAddonAccess | null; loading: boolean; unavailable: boolean; onUpdated: () => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const returned = useRef(false);
  const end = billingDate(addon?.subscription?.currentPeriodEnd);
  const entitled = addon?.entitled === true && !unavailable;
  const renewalScheduled = !!addon?.subscription && ["active", "past_due", "trialing", "unpaid"].includes(addon.subscription.status)
    && !addon.subscription.cancelAtPeriodEnd;

  const action = useCallback(async (name: "checkout" | "sync" | "cancel", sessionId?: string) => {
    setBusy(name); setError(""); setNotice("");
    try {
      const response = await fetch("/api/nitrous/subscription", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: name, ...(sessionId ? { sessionId } : {}) }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.error) throw new Error(result?.detail || "Unable to update your Nitrous add-on. Please try again.");
      if (name === "checkout" && result?.addon?.entitled) { await onUpdated(); return; }
      if (name === "checkout") {
        const url = new URL(result?.url ?? "");
        if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("A secure checkout could not be opened.");
        window.location.assign(url.toString());
        return;
      }
      setConfirmCancel(false);
      if (name === "sync" && window.location.search.includes("nitrous=")) {
        const back = new URL(window.location.href); back.searchParams.delete("nitrous"); back.searchParams.delete("session_id");
        window.history.replaceState(window.history.state, "", `${back.pathname}${back.search}${back.hash}`);
      }
      await onUpdated();
      window.dispatchEvent(new Event("nitrous-account-updated"));
      setNotice(name === "cancel" ? "Nitrous renewal is canceled. Your paid access lasts until the end of this billing period."
        : result?.addon?.entitled ? "Nitrous access is ready." : "Access checked. Complete payment or ask your admin to grant Nitrous.");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to update your add-on."); }
    finally { setBusy(""); }
  }, [onUpdated]);

  useEffect(() => {
    if (returned.current) return;
    const query = new URLSearchParams(window.location.search);
    const state = query.get("nitrous");
    if (state !== "success" && state !== "canceled") return;
    returned.current = true;
    if (state === "success") void action("sync", query.get("session_id") ?? undefined);
    else setNotice("Checkout canceled. No add-on was activated.");
  }, [action]);

  return <section className={`nitrous-panel nitrous-addon ${entitled ? "nitrous-addon-included" : "nitrous-addon-locked"}`} aria-labelledby="nitrous-addon-title">
    <div className="nitrous-addon-heading"><span className="nitrous-icon-disc">{entitled ? <ShieldCheck size={23} /> : <LockKeyhole size={23} />}</span>
      <span className="nitrous-eyebrow">NITROUS ADD-ON</span></div>
    <h2 id="nitrous-addon-title">{loading && !addon ? "Checking your access…" : unavailable ? "Access check unavailable" : addon?.adminGranted ? "Your access is included." : entitled ? "Your Nitrous add-on" : "Two speeds. One gold engine."}</h2>
    {unavailable && <p className="nitrous-addon-intro" role="status">Access check unavailable. Refresh to retry. Existing account controls remain available.</p>}
    {!entitled && <>
      <p className="nitrous-addon-intro">Gold setups, clear charts, and TradeLocker automation. Choose Slow Drip or Nitrous inside your One Mission workspace.</p>
      <div className="nitrous-addon-price"><strong>$19.99</strong><span>USD / month</span></div>
      <div className="nitrous-addon-features"><span><Check size={17} />Gold setups and chart levels</span><span><Check size={17} />Real and demo TradeLocker accounts</span><span><Check size={17} />Balance, results, and account controls</span></div>
      <div className="nitrous-addon-modes"><span><Droplets size={18} /><strong>Slow Drip</strong><small>0.5–1% risk per trade</small></span><span><Zap size={18} /><strong>Nitrous</strong><small>3–5% risk per trade</small></span></div>
      <button type="button" className="nitrous-button nitrous-button-primary" disabled={!!busy || loading || unavailable || !addon} onClick={() => void action("checkout")}>
        {busy === "checkout" ? <Loader2 size={17} className="nitrous-spin" /> : <CreditCard size={17} />}{busy === "checkout" ? "Opening secure checkout…" : "Add Nitrous · $19.99/month"}
      </button>
      <p className="nitrous-addon-terms">Renews monthly. Cancel anytime before renewal. Included when granted by your admin.</p>
      <p className="nitrous-addon-terms">Active One Mission membership is required. Purchasing access does not turn on trading.</p>
    </>}
    {entitled && <p className="nitrous-addon-intro">{addon?.adminGranted ? "Your admin has granted Nitrous at no add-on charge. Both trading modes are included."
      : addon?.subscription?.cancelAtPeriodEnd ? `Renewal canceled.${end ? ` Access continues through ${end}.` : " Your current paid period remains available."}`
        : `$19.99/month${end ? ` · current period ends ${end}` : ""}. Both trading modes are included.`}</p>}
    {addon?.adminGranted && addon.subscription?.cancelAtPeriodEnd && <p className="nitrous-addon-terms">Your previous paid add-on will not renew. Complimentary access remains available.</p>}
    <div className="nitrous-addon-actions"><button type="button" className="nitrous-button nitrous-button-quiet" disabled={!!busy || loading} onClick={() => void action("sync")}>
      <RefreshCw size={15} className={busy === "sync" ? "nitrous-spin" : ""} />{busy === "sync" ? "Checking access…" : "Refresh access"}</button>
      {renewalScheduled && !confirmCancel && <button type="button" className="nitrous-button nitrous-button-quiet" disabled={!!busy} onClick={() => setConfirmCancel(true)}>Cancel renewal</button>}</div>
    {confirmCancel && <div className="nitrous-addon-cancel" role="group" aria-label="Confirm Nitrous cancellation"><p>Cancel only your Nitrous renewal?{end ? ` You keep paid access through ${end}.` : " You keep the remainder of your paid period."} Your other subscriptions stay active.</p>
      <div><button type="button" className="nitrous-button nitrous-button-secondary" disabled={!!busy} onClick={() => setConfirmCancel(false)}>Keep renewal</button><button type="button" className="nitrous-button nitrous-button-secondary" disabled={!!busy} onClick={() => void action("cancel")}>{busy === "cancel" ? "Canceling…" : "Cancel Nitrous renewal"}</button></div></div>}
    {notice && <p className="nitrous-notice" role="status">{notice}</p>}
    {error && <p className="nitrous-error" role="alert">{error}</p>}
  </section>;
}
