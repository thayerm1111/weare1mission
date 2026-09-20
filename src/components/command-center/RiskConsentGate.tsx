"use client";

import { useEffect, useState } from "react";
import RiskConsent, { type ConsentView } from "./RiskConsent";

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
export function RiskConsentGate() {
  const [consent, setConsent] = useState<ConsentView | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/command-center/consent", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j?.ok) return;
        setConsent(j.consent);
        /*
         * Deferred within a session, not across them.
         *
         * sessionStorage rather than localStorage on purpose: "later" should mean the rest of this
         * visit, not for ever. A member who closes the tab and comes back tomorrow is asked again.
         */
        let deferred = false;
        try { deferred = sessionStorage.getItem("cc.consent.later") === "1"; } catch { /* private window */ }
        if (!j.consent?.signed && !deferred) setOpen(true);
      })
      .catch(() => { /* unauthenticated or offline: the server still gates trading */ });
    return () => { alive = false; };
  }, []);

  if (!consent || consent.signed) return null;

  return (
    <RiskConsent
      open={open}
      onClose={() => {
        try { sessionStorage.setItem("cc.consent.later", "1"); } catch { /* private window */ }
        setOpen(false);
      }}
      onSigned={(c) => setConsent(c)}
    />
  );
}

export default RiskConsentGate;
