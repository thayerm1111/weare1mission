"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { isDesktop } from "@/lib/desktop";

/**
 * THE BRAIN BRINGING YOU A TRADE, instead of waiting to be asked.
 *
 * Everything needed to find a setup already existed: the engine has always produced one, and the
 * screen has always shown it. What was missing is the part that matters when you are working on
 * something else — being INTERRUPTED, once, at the moment a setup actually becomes takeable.
 *
 * WHAT IT WILL NOT DO, and these are the rules that keep it from becoming a nuisance or a hazard:
 *
 *   IT FIRES ONCE PER SETUP. A signature is taken from the side, the style and the stop, so a setup
 *   that ticks from developing to ready to developing again does not interrupt twice. An alert that
 *   cries wolf is an alert people learn to dismiss without reading, and the one time it mattered they
 *   will dismiss that one too.
 *
 *   IT NEVER APPEARS OVER AN OPEN POSITION. A member managing a live trade does not need a modal
 *   about a different one.
 *
 *   TAKING IT GOES THROUGH THE SAME DOOR AS EVERY OTHER ENTRY. `take_setup` recomputes the whole
 *   trade server-side from a fresh snapshot and refuses if anything has drifted — the risk comes from
 *   the profile, never from this component, and this component could not bypass a permission if it
 *   tried. A one-click button on a popup is exactly where a shortcut would be tempting and exactly
 *   where one would be unforgivable.
 *
 *   PASSING IS RECORDED. It is worth as much to the learning system as a fill, and a member who
 *   silently closes the box has told it nothing.
 */

const C = {
  panel: "#0B1017", raised: "#0E131C", line: "rgba(255,255,255,0.08)",
  text: "#E8EFF7", mut: "rgba(232,239,247,0.56)", mut2: "rgba(232,239,247,0.34)",
  gold: "#F0C475", up: "#3FD9A0", down: "#F4737B",
};

export type AlertSetup = {
  state: string; side: string | null; style: string | null; stop: number | null;
  entryLow: number | null; entryHigh: number | null;
  initialObjective: number | null; stopPips: number | null;
  expectedMovePips: [number, number] | null;
  confidence: number; headline: string; say: string;
  thesis: string | null; invalidationPrice?: number | null;
};

const READY = new Set(["ready", "armed"]);
const px = (n: number | null | undefined) => (n == null ? "—" : n.toFixed(2));

/** What makes this the SAME opportunity rather than a new one. */
function signatureOf(s: AlertSetup): string {
  return [s.side, s.style, s.stop?.toFixed(2), s.entryHigh?.toFixed(2)].join("|");
}

export function TradeAlert({
  setup, riskPct, balance, currency, hasPosition, onChanged, onDetails,
}: {
  setup: AlertSetup | null;
  riskPct: number;
  balance: number | null;
  currency: string | null;
  hasPosition: boolean;
  onChanged: () => void;
  onDetails: () => void;
}) {
  const [shown, setShown] = useState<AlertSetup | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const seen = useRef<Set<string>>(new Set());

  /* ── decide whether to interrupt ───────────────────────────────────────── */
  useEffect(() => {
    if (!setup || hasPosition) return;
    if (!READY.has(setup.state) || !setup.side || setup.stop == null) return;

    const sig = signatureOf(setup);
    if (seen.current.has(sig)) return;
    seen.current.add(sig);
    setShown(setup);
    setMsg("");

    /*
     * The native notification is the point of the desktop build: it reaches a member who is in
     * another application entirely. Asked for only at the moment there is something worth saying —
     * a permission prompt on page load, for a notification that may never come, is how people learn
     * to click Block.
     */
    void (async () => {
      try {
        if (isDesktop()) {
          const { isPermissionGranted, requestPermission, sendNotification } =
            await import("@tauri-apps/plugin-notification");
          const ok = (await isPermissionGranted()) || (await requestPermission()) === "granted";
          if (ok) sendNotification({
            title: `THE BRAIN has a trade ready`,
            body: `${setup.side === "buy" ? "Buy" : "Sell"} XAUUSD · ${setup.style ?? ""} — ${setup.headline}`,
          });
          return;
        }
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("THE BRAIN has a trade ready", {
            body: `${setup.side === "buy" ? "Buy" : "Sell"} XAUUSD · ${setup.style ?? ""} — ${setup.headline}`,
          });
        }
      } catch { /* a missing notification must never break the alert itself */ }
    })();
  }, [setup, hasPosition]);

  // A position opening while the box is up makes the box wrong. It goes.
  useEffect(() => { if (hasPosition) setShown(null); }, [hasPosition]);

  const act = useCallback(async (kind: "take" | "pass") => {
    if (!shown) return;
    setBusy(kind);
    setMsg("");
    try {
      const body = kind === "take"
        ? {
            action: "take_setup",
            approved: {
              side: shown.side, style: shown.style, stop: shown.stop,
              invalidationPrice: shown.invalidationPrice ?? null,
            },
          }
        : { action: "pass_setup", reason: "passed from the alert" };

      const r = await fetch("/api/command-center/trade", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json();
      setBusy("");
      if (kind === "pass" || j?.ok) { setShown(null); onChanged(); return; }
      // A refusal is the system working. It is shown, not swallowed.
      setMsg(j?.message ?? "That didn't go through.");
    } catch {
      setBusy("");
      setMsg("Couldn't reach the Command Center. Nothing was sent.");
    }
  }, [shown, onChanged]);

  if (!shown) return null;

  const long = shown.side === "buy";
  const risk = balance != null ? (balance * riskPct) / 100 : null;
  const move = shown.expectedMovePips;

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center p-3 sm:items-center"
      style={{ background: "rgba(3,6,11,0.72)", backdropFilter: "blur(3px)" }}>
      <section className="w-full max-w-[380px] overflow-hidden rounded-2xl border"
        style={{ borderColor: "rgba(240,196,117,0.30)", background: C.panel, boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}>

        <div className="flex items-center justify-between border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: C.gold }}>
            THE BRAIN · trade ready
          </p>
          <button onClick={() => setShown(null)} className="rounded-lg p-1" style={{ color: C.mut2 }} aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="px-3.5 py-3">
          <p className="text-[17px] font-semibold" style={{ color: long ? C.up : C.down }}>
            {long ? "Buy" : "Sell"} XAUUSD
            <span className="ml-2 text-[11px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>
              {shown.style ?? ""} · {Math.round(shown.confidence)} confidence
            </span>
          </p>

          <p className="mt-1.5 text-[12.5px] leading-snug" style={{ color: C.mut }}>{shown.headline}</p>

          <div className="mt-2.5 grid grid-cols-2 gap-px overflow-hidden rounded-xl" style={{ background: C.line }}>
            {([
              ["Entry", shown.entryLow != null && shown.entryHigh != null && shown.entryLow !== shown.entryHigh
                ? `${px(shown.entryLow)} – ${px(shown.entryHigh)}` : px(shown.entryHigh ?? shown.entryLow)],
              ["Stop", `${px(shown.stop)}${shown.stopPips != null ? ` (${Math.round(shown.stopPips)} pips)` : ""}`],
              ["Objective", px(shown.initialObjective)],
              ["Expected", move ? `${move[0]}–${move[1] ?? "+"} pips` : "—"],
            ] as const).map(([k, v]) => (
              <div key={k} className="px-2.5 py-2" style={{ background: C.raised }}>
                <p className="text-[9.5px] font-bold uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>{k}</p>
                <p className="mt-0.5 text-[12.5px] tabular-nums" style={{ color: C.text }}>{v}</p>
              </div>
            ))}
          </div>

          {/*
            * THE RISK, IN MONEY.
            *
            * A percentage is not a decision. What a member needs in the second before they commit is
            * the number that leaves the account if this one is wrong.
            */}
          <p className="mt-2.5 text-[11.5px]" style={{ color: C.mut2 }}>
            Risking {riskPct}% of the account
            {risk != null ? ` — about ${currency && currency !== "USD" ? "" : "$"}${risk.toFixed(0)}${currency && currency !== "USD" ? ` ${currency}` : ""} if the stop is hit` : ""}.
          </p>

          {msg && <p className="mt-2 text-[12px]" style={{ color: C.down }}>{msg}</p>}

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button onClick={() => void act("take")} disabled={!!busy}
              className="rounded-xl px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] disabled:opacity-40"
              style={{ background: "rgba(63,217,160,0.16)", color: C.up, border: "1px solid rgba(63,217,160,0.34)" }}>
              {busy === "take" ? "Sending…" : "Take this trade"}
            </button>
            <button onClick={() => void act("pass")} disabled={!!busy}
              className="rounded-xl px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] disabled:opacity-40"
              style={{ background: "rgba(255,255,255,0.04)", color: C.mut, border: `1px solid ${C.line}` }}>
              {busy === "pass" ? "…" : "Pass"}
            </button>
          </div>
          <button onClick={() => { setShown(null); onDetails(); }}
            className="mt-2 w-full rounded-xl px-3 py-2 text-[10.5px] font-bold uppercase tracking-[0.14em]"
            style={{ background: "transparent", color: C.mut2, border: `1px solid ${C.line}` }}>
            See the whole setup first
          </button>

          <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: C.mut2 }}>
            Taking this recomputes the trade server-side against a fresh price and refuses if anything
            has moved. Your risk setting and account permissions still apply.
          </p>
        </div>
      </section>
    </div>
  );
}

export default TradeAlert;
