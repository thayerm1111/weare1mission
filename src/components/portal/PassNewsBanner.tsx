"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * ONE-TIME NEWS: WHAT THE FLOW PASS COVERS (owner 11-02: "make sure that this is advertised to the customers
 * so they know"). A slim banner at the top of the portal — not a pop-up, so it never stacks on the low-balance
 * flyer, the ATLAS announcement or the risk disclosure. Shown until the member closes it or follows it, then
 * never again, on any device (the server remembers, the same as the ATLAS announcement; the phone app reads the
 * same key).
 *
 * Pass holders are told what changed for them (OM AI Plays now free, and where Pause/Cancel and the next charge
 * date live); everyone else sees the offer.
 */
export const PASS_NEWS_KEY = "flow_pass_2026_11";

type Sub = { pass?: { active?: boolean; price?: number; credits?: number } };

export function PassNewsBanner() {
  const [sub, setSub] = useState<Sub | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const seen = await fetch(`/api/portal/announcement?key=${PASS_NEWS_KEY}`, { cache: "no-store" }).then((r) => r.json());
        if (!alive || !seen || seen.seen !== false) return;
        const s = await fetch("/api/subscription", { cache: "no-store" }).then((r) => r.json());
        if (alive && s && s.ok && s.pass) setSub(s as Sub);
      } catch { /* best-effort */ }
    })();
    return () => { alive = false; };
  }, []);

  const dismiss = () => {
    setSub(null);
    fetch("/api/portal/announcement", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: PASS_NEWS_KEY }) }).catch(() => {});
  };

  if (!sub?.pass) return null;
  const holder = !!sub.pass.active;
  const price = sub.pass.price ?? 99;
  const credits = sub.pass.credits ?? 50;
  return (
    <div className="mt-6 flex flex-col gap-3 rounded-xl px-4 py-3 sm:flex-row sm:items-center" role="status"
      style={{ background: "linear-gradient(120deg, rgba(231,196,103,0.14), rgba(9,19,29,0.6))", border: "1px solid rgba(231,196,103,0.4)", color: "#F0F4F7" }}>
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
        <span className="mr-2 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ background: "rgba(231,196,103,0.2)", color: "#FFD875" }}>∞ FLOW Pass</span>
        {holder ? (
          <>Your Pass now covers <b>OM AI Plays</b> too: GENX, GEN FX, OM AI Plays and FLOW never take credits. ATLAS and the other tools still use your {credits} monthly credits. Your next charge date, Pause and Cancel are on the Credits page.</>
        ) : (
          <><b>Unlimited GENX, GEN FX, OM AI Plays and FLOW</b> for ${price}/mo, plus {credits} credits a month for ATLAS and the other tools. Cancel or pause anytime.</>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link href="/portal/credits" onClick={dismiss} className="rounded-lg px-3.5 py-2 text-[13px] font-semibold" style={{ background: "#E7C467", color: "#10131A" }}>
          {holder ? "Manage my Pass" : "See the FLOW Pass"}
        </Link>
        <button onClick={dismiss} aria-label="Close" className="rounded-lg px-2.5 py-2 text-[13px]" style={{ color: "#B7C2CC", border: "1px solid rgba(89,175,255,0.2)" }}>✕</button>
      </div>
    </div>
  );
}
