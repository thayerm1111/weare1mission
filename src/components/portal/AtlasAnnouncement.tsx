"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * ONE-TIME ANNOUNCEMENT: ATLAS + THE COMMAND CENTER (owner 09-22).
 *
 * Shown once per member, the first time they land in the portal after it ships, on any device (the
 * server remembers who has seen it). Awareness only — by the owner's instruction it says nothing about
 * pricing, credits or plans; it just tells them the thing exists and where it is.
 */
const KEY = "atlas_command_center_2026_09";

export function AtlasAnnouncement() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/portal/announcement?key=${KEY}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (alive && j && j.seen === false) setOpen(true); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const dismiss = () => {
    setOpen(false);
    fetch("/api/portal/announcement", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: KEY }) }).catch(() => {});
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center px-4" style={{ background: "rgba(3,8,14,0.8)" }} role="dialog" aria-modal aria-label="Meet ATLAS">
      <div className="w-full max-w-[460px] overflow-hidden rounded-2xl" style={{ background: "linear-gradient(180deg, #09131D 0%, #07101A 100%)", border: "1px solid rgba(39,215,242,0.42)", boxShadow: "0 24px 70px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,199,232,0.08)", color: "#F0F4F7" }}>
        <div className="relative px-6 pt-7 pb-2 text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full" style={{ border: "1px solid rgba(39,215,242,0.42)", boxShadow: "0 0 24px rgba(0,199,232,0.3), inset 0 0 14px rgba(213,169,61,0.25)" }}>
            <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden><path d="M12 3 L21 20 H3 Z" fill="none" stroke="#FFD875" strokeWidth="1.6" /><circle cx="12" cy="14" r="2.2" fill="#27D7F2" /></svg>
          </div>
          <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.24em]" style={{ color: "#FFD875" }}>New in The Floor</p>
          <h2 className="mt-2 text-[24px] font-semibold leading-tight">Meet ATLAS.</h2>
          <p className="mt-3 text-[14px] leading-relaxed" style={{ color: "#B7C2CC" }}>
            ATLAS is a living AI that watches gold with you inside the new <b style={{ color: "#F0F4F7" }}>Command Center XAUUSD</b>. It reads the market in real time, shows you what it sees on the chart, explains its thinking, and you can talk to it — by typing or by voice.
          </p>
          <p className="mt-3 text-[13px] leading-relaxed" style={{ color: "#81909E" }}>
            Find it under <b style={{ color: "#F0F4F7" }}>The Floor → Command Center</b>. There is a guided walkthrough waiting the first time you open it.
          </p>
        </div>
        <div className="flex flex-col gap-2 px-6 pb-6 pt-4 sm:flex-row">
          <Link href="/portal/command-center" onClick={dismiss} className="flex-1 rounded-lg px-4 py-3 text-center text-[14px] font-semibold" style={{ background: "#E7C467", color: "#10131A" }}>Open the Command Center</Link>
          <button onClick={dismiss} className="rounded-lg px-4 py-3 text-[13px] font-medium" style={{ color: "#B7C2CC", border: "1px solid rgba(89,175,255,0.2)" }}>Later</button>
        </div>
      </div>
    </div>
  );
}
