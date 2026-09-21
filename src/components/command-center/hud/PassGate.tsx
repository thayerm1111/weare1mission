"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { H } from "./theme";
import { EntrySequence, primeAudio } from "./EntrySequence";

/**
 * COMMAND CENTER ACCESS — 5 credits opens it for 30 minutes, the clock starting when you open it.
 *
 * Nothing renews on its own: when the window ends, the screen asks. Admins pass straight through.
 * The data routes enforce the same rule on the server, so this screen is the explanation, not the lock.
 */
type Pass = { active: boolean; admin: boolean; expiresAt: string | null; cost: number; minutes: number; balance: number | null };

/** Admins can replay the entrance for a recording: /command-center?replay=1 */
function replayWanted(): boolean {
  try { return new URLSearchParams(window.location.search).get("replay") === "1"; } catch { return false; }
}

export function PassGate({ children }: { children: React.ReactNode }) {
  const [pass, setPass] = useState<Pass | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [intro, setIntro] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/command-center/pass", { cache: "no-store" });
      if (r.ok) setPass(await r.json());
    } catch { /* retried by the timer */ }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const exp = pass?.expiresAt ? Date.parse(pass.expiresAt) : null;
  const open = !!pass && (pass.admin || (pass.active && exp != null && exp > now));

  /*
   * THE ENTRANCE (owner 09-21): the animation and ATLAS's spoken welcome — their name, their accounts,
   * the gold update — play when they open the Command Center, but only if it has been two hours since
   * the last welcome. Renewing the 30-minute window inside that goes straight to the desk. The server
   * decides (GET /api/command-center/greet), so the rule holds across devices.
   */
  const checked = useRef(false);
  const paidNow = useRef(false); // this window was opened by a tap here, so sound is allowed
  useEffect(() => {
    if (!open || checked.current) return;
    checked.current = true;
    fetch(`/api/command-center/greet${replayWanted() ? "?replay=1" : ""}`, { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (j?.eligible) setIntro(true); }).catch(() => {});
  }, [open]);
  // A window that expires and is renewed re-checks (it will usually be inside the two hours).
  useEffect(() => { if (!open) checked.current = false; }, [open]);

  const buy = useCallback(async () => {
    primeAudio(); // inside the tap, so ATLAS may speak once the room is up
    paidNow.current = true;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/command-center/pass", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (j?.active) setPass(j as Pass);
      else setMsg(j?.error === "insufficient" ? `You need ${j.cost ?? 5} credits and have ${j.balance ?? 0}. Top up credits, then open it.` : "Could not open it. Try again in a moment.");
    } catch { setMsg("Could not reach the server. Check your connection."); }
    setBusy(false);
  }, []);

  if (!pass) {
    return <div className="grid min-h-screen place-items-center text-[13px]" style={{ background: H.bg0, color: H.mut }}>Checking your access…</div>;
  }

  if (!open) {
    const expired = exp != null && exp <= now;
    return (
      <div className="grid min-h-screen place-items-center px-4" style={{ background: H.bg0, color: H.text }}>
        <div className="w-full max-w-[420px] rounded-2xl p-6" style={{ border: `1px solid ${H.lineHi}`, background: H.bg1 }}>
          <p className="text-[11px] font-bold uppercase tracking-[0.2em]" style={{ color: H.gold3 }}>Command Center XAUUSD</p>
          <h1 className="mt-2 text-[22px] font-semibold">{expired ? "Your 30 minutes are up" : "Open the Command Center"}</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed" style={{ color: H.mut }}>
            {pass.cost} credits opens the live desk with ATLAS for {pass.minutes} minutes. The clock starts when you press open, and nothing renews without you.
          </p>
          {typeof pass.balance === "number" && (
            <p className="mt-3 text-[12.5px] tabular-nums" style={{ color: pass.balance >= pass.cost ? H.mut : H.red }}>You have {pass.balance} credits.</p>
          )}
          <button onClick={buy} disabled={busy}
            className="mt-4 w-full rounded-lg px-4 py-3 text-[14px] font-semibold transition disabled:opacity-60"
            style={{ background: H.gold2, color: "#10131A" }}>
            {busy ? "Opening…" : `Open for ${pass.minutes} min — ${pass.cost} credits`}
          </button>
          {msg && <p className="mt-3 text-[12.5px]" style={{ color: H.red }}>{msg}</p>}
          <a href="/portal/credits" className="mt-3 block text-center text-[12px] underline" style={{ color: H.mut }}>Buy credits</a>
        </div>
      </div>
    );
  }

  const left = exp ? Math.max(0, exp - now) : null;
  const mm = left != null ? Math.floor(left / 60_000) : 0, ss = left != null ? Math.floor((left % 60_000) / 1000) : 0;
  return (
    <>
      {children}
      {intro && <EntrySequence speak awaitTap={!!pass.admin && !paidNow.current} replay={replayWanted()} onDone={() => setIntro(false)} />}
      {!pass.admin && left != null && (
        <div className="pointer-events-none fixed bottom-3 left-3 z-50 rounded-full px-3 py-1 text-[11px] tabular-nums"
          style={{ background: "rgba(7,16,26,0.9)", border: `1px solid ${left < 5 * 60_000 ? H.gold2 : H.line}`, color: left < 5 * 60_000 ? H.gold3 : H.mut }}>
          Command Center · {mm}:{String(ss).padStart(2, "0")} left
        </div>
      )}
    </>
  );
}
