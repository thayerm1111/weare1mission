"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import RiskConsent, { type ConsentView } from "./RiskConsent";
import { reserveDisclosure } from "@/lib/onboarding/entry";

/**
 * EVERY MEMBER SEES THE DISCLOSURE, AND KEEPS SEEING IT UNTIL THEY SIGN.
 *
 * Mounted in the portal shell rather than only in the Command Center, because the point is that
 * nobody arrives at the moment they want to trade and discovers a legal document standing in the way.
 * They read it on the way in, once, calmly, before any of it is urgent.
 *
 * "LATER" DEFERS, IT DOES NOT DISMISS. Closing it returns to the portal and the sheet comes back on
 * the next visit — every visit — until it is signed. That is the honest reading of "at least once":
 * a member who never signs is asked every time rather than asked once and quietly forgotten.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is lock the portal. Members pay for the community, the training
 * and the tools, and holding those hostage behind a TRADING disclosure would punish people for
 * something they may never do. The consent is what gates trading, and that gate is server-side and
 * absolute — it does not need this component to exist, and it would refuse with this file deleted.
 *
 * It renders nothing at all for a member who has already signed, which is almost everyone after the
 * first week.
 */
export function RiskConsentGate({ memberId = "" }: { memberId?: string } = {}) {
  const [consent, setConsent] = useState<ConsentView | null>(null);
  const [open, setOpen] = useState(false);
  const release = useRef<(() => void) | null>(null);
  const finishPrompt = useCallback(() => { release.current?.(); release.current = null; }, []);
  const deferKey = memberId ? `cc.consent.later.${memberId}` : "cc.consent.later";

  useEffect(() => {
    let alive = true, expired = false;
    const controller = new AbortController(), done = reserveDisclosure(memberId);
    release.current = done;
    setConsent(null); setOpen(false);
    // An unavailable presentation must not hold the welcome forever; server-side consent still gates trading.
    const timeout = setTimeout(() => { expired = true; controller.abort(); done(); }, 12_000);
    fetch("/api/command-center/consent", { cache: "no-store", signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || expired) return;
        if (!j?.ok || typeof j.consent?.signed !== "boolean") { done(); return; }
        setConsent(j.consent);
        /*
         * Deferred within a session, not across them.
         *
         * sessionStorage rather than localStorage on purpose: "later" should mean the rest of this
         * visit, not for ever. A member who closes the tab and comes back tomorrow is asked again.
         */
        let deferred = false;
        try { deferred = sessionStorage.getItem(deferKey) === "1"; } catch { /* private window */ }
        if (!j.consent?.signed && !deferred) setOpen(true);
        else done();
      })
      .catch(() => { done(); /* unauthenticated or offline: the server still gates trading */ })
      .finally(() => clearTimeout(timeout));
    return () => { alive = false; clearTimeout(timeout); controller.abort(); done(); if (release.current === done) release.current = null; };
  }, [memberId, deferKey]);

  if (!consent || consent.signed) return null;

  return (
    <RiskConsent
      open={open}
      onClose={() => {
        try { sessionStorage.setItem(deferKey, "1"); } catch { /* private window */ }
        setOpen(false);
        finishPrompt();
      }}
      onSigned={(c) => { setConsent(c); if (c.signed) { setOpen(false); finishPrompt(); } }}
    />
  );
}

export default RiskConsentGate;
