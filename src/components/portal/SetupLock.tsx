"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, Loader2 } from "lucide-react";
import { CREDIT_COST } from "@/lib/creditConfig";
import { SETUP_MINUTES, minutesLeft, tapOutcome, type SetupGate, type TapReply } from "@/lib/setupLock";

/*
 * THE LOCKED SETUP (owner 10-05: "Make them use credits to view"; 10-06: "Yes, lock the site").
 *
 * What a member sees where a live setup would be — on The Floor's card, in the GEN FX lists and on
 * the FLOW desk — when their window is not open: that there is a setup, how far along it is, and one
 * button. The play itself is not on the page to be uncovered: the server did not send it
 * (src/lib/setupLock.ts). The button spends one read's credits and opens every live setup on the site
 * for half an hour (/api/setups/pass); the caller then asks for its data again and gets the play.
 */

type TapOutcome = ReturnType<typeof tapOutcome>;

/*
 * ONE PAYMENT AT A TIME, PAGE-WIDE. A card's lock is drawn afresh when the member changes market or
 * horizon, and a fresh lock's button was not mid-payment: a second tap there, while the first payment
 * was still out, sent a second one — and two payments that land on different servers are two spends
 * for one window (each server only knows about its own). So there is one request for the whole page:
 * every button shares the one that is out, and a lock drawn while one is out starts down.
 */
let paying: Promise<TapOutcome> | null = null;
/** Spend the credits — or join the payment that is already out. What it resolves to is what the server said, read once. */
export function seeThePlayOnce(): Promise<TapOutcome> {
  if (paying) return paying;
  const mine: Promise<TapOutcome> = (async () => {
    let status = 0, reply: TapReply | null = null;
    try {
      const r = await fetch("/api/setups/pass", { method: "POST" });
      status = r.status;
      reply = (await r.json().catch(() => null)) as TapReply | null;
    } catch { /* no answer: said below */ }
    const out = tapOutcome(status, reply);
    // Told to the page once, however many buttons were waiting on it. The balance in the header
    // changes only if this payment spent credits.
    if (out.opened && out.charged) { try { window.dispatchEvent(new Event("credits-updated")); } catch { /* the badge catches up on its own */ } }
    if (!out.opened && out.flyer) { try { window.dispatchEvent(new Event("open-credits-flyer")); } catch { /* the message on the card still says it */ } }
    return out;
  })();
  paying = mine;
  void mine.finally(() => { if (paying === mine) paying = null; });
  return mine;
}
/** Is a payment out right now? */
export const seeThePlayIsOut = (): boolean => paying != null;

/**
 * The button's work: spend the credits, then tell the caller to ask for its data again. `phase` is
 * "busy" while the request is out and "opened" once it has come back open — the button stays down
 * until the caller's new data replaces this card (or, if that never arrives, for a few seconds).
 */
export function useSeeThePlay(onOpened: () => void) {
  // The payment that was out when this lock was drawn, if one was. Held here, not looked up again
  // later: it may have landed by the time the effect below runs, and this button must still hear of it.
  const [joined] = useState<Promise<TapOutcome> | null>(() => paying);
  const [phase, setPhase] = useState<"idle" | "busy" | "opened">(joined ? "busy" : "idle");
  const [err, setErr] = useState("");
  // The caller's newest `onOpened`: what to ask for again can change while the payment is out.
  const opened = useRef(onOpened);
  opened.current = onOpened;
  const settle = useCallback((out: TapOutcome) => {
    if (out.opened) { setPhase("opened"); opened.current(); return; }
    setErr(out.message);
    setPhase("idle");
  }, []);
  // Drawn while a payment was already out (the member changed market or horizon mid-payment): wait for that one.
  useEffect(() => {
    if (!joined) return;
    let here = true;
    void joined.then((o) => { if (here) settle(o); });
    return () => { here = false; };
  }, [joined, settle]);
  useEffect(() => {
    if (phase !== "opened") return;
    const t = setTimeout(() => setPhase("idle"), 8000);
    return () => clearTimeout(t);
  }, [phase]);
  const open = useCallback(async () => {
    if (phase !== "idle") return;                       // one tap, one request
    setPhase("busy"); setErr("");
    settle(await seeThePlayOnce());
  }, [phase, settle]);
  return { open, phase, err };
}

const TONE = {
  dark: {
    box: { borderColor: "rgba(255,194,75,0.32)", background: "rgba(11,13,20,0.9)" } as React.CSSProperties,
    what: { color: "#ffd47a" } as React.CSSProperties,
    body: { color: "rgba(255,255,255,0.72)" } as React.CSSProperties,
    foot: { color: "rgba(255,255,255,0.42)" } as React.CSSProperties,
    btn: "bg-[#ffc24b] text-[#1a1204] hover:bg-[#ffd47a]",
    err: "text-[#ff8a94]",
  },
  light: {
    box: { borderColor: "rgba(180,140,40,0.4)", background: "rgba(255,194,75,0.07)" } as React.CSSProperties,
    what: { color: "#8a6410" } as React.CSSProperties,
    body: { color: "rgba(30,34,45,0.72)" } as React.CSSProperties,
    foot: { color: "rgba(30,34,45,0.45)" } as React.CSSProperties,
    btn: "bg-gradient-to-r from-navy to-primary text-cream hover:shadow-cardhover",
    err: "text-red-500",
  },
};

export function SetupLock({ what, gate, tone = "dark", onOpened, className = "" }: {
  /** What is behind it, as a heading with no direction in it: "GENX · INTRADAY — setup forming". */
  what: string;
  gate?: SetupGate | null;
  tone?: "dark" | "light";
  /** The window is open: ask for the data again. */
  onOpened: () => void;
  className?: string;
}) {
  const { open, phase, err } = useSeeThePlay(onOpened);
  const cost = gate?.cost ?? CREDIT_COST.genx, minutes = gate?.minutes ?? SETUP_MINUTES;
  const t = TONE[tone];
  return (
    <div className={`rounded-xl border px-4 py-4 text-center ${className}`} style={t.box}>
      <p className="inline-flex items-center justify-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.12em]" style={t.what}>
        <Lock className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" /> {what}
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed" style={t.body}>Which way, the entry, the stop and the targets open with credits.</p>
      <button type="button" onClick={() => void open()} disabled={phase !== "idle"} aria-busy={phase !== "idle"}
        className={`mt-3 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-bold transition disabled:cursor-not-allowed disabled:opacity-60 ${t.btn}`}>
        {phase !== "idle" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {phase === "busy" ? "Opening…" : phase === "opened" ? "Open — loading the play…" : `See the play · ${cost} credits`}
      </button>
      <p className="mt-2 text-[10.5px] leading-relaxed" style={t.foot}>Opens every live setup on the site for {minutes} minutes. So does a paid GENX, GEN FX or MFX Ghost read.</p>
      {err && <p className={`mt-2 text-[11.5px] font-semibold ${t.err}`} role="alert">{err}</p>}
    </div>
  );
}

type Candle = { o: number; h: number; l: number; c: number };

/** The market's own candles, out of focus: what the card looks like with nothing drawn on it. */
function CandleBackdrop({ candles }: { candles: Candle[] }) {
  const cs = candles.slice(-44).filter((k) => [k.o, k.h, k.l, k.c].every((n) => Number.isFinite(n)));
  if (cs.length < 4) return null;
  const W = 720, H = 360, pad = 24;
  const lo = Math.min(...cs.map((k) => k.l)), hi = Math.max(...cs.map((k) => k.h)), sp = (hi - lo) || 1;
  const y = (p: number) => pad + (1 - (p - lo) / sp) * (H - pad * 2);
  const cw = (W - pad * 2) / cs.length, bw = Math.max(2, cw * 0.6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true" style={{ display: "block", opacity: 0.32, filter: "blur(2.5px)" }}>
      {cs.map((k, i) => {
        const x = pad + i * cw + cw / 2, col = k.c >= k.o ? "#2ee88f" : "#ff5d6c";
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(k.h)} y2={y(k.l)} stroke={col} strokeWidth="1.2" />
            <rect x={x - bw / 2} y={Math.min(y(k.o), y(k.c))} width={bw} height={Math.max(1.5, Math.abs(y(k.c) - y(k.o)))} fill={col} />
          </g>
        );
      })}
    </svg>
  );
}

/** The Floor's setup card with its window closed: the chart behind, the lock in front. */
export function LockedSetupCard({ what, gate, candles, onOpened }: { what: string; gate?: SetupGate | null; candles: Candle[]; onOpened: () => void }) {
  return (
    <div className="relative h-[360px] overflow-hidden">
      <CandleBackdrop candles={candles} />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <SetupLock what={what} gate={gate} onOpened={onOpened} className="w-full max-w-sm" />
      </div>
    </div>
  );
}

/** While a paid window is open: how long is left, so the card going quiet again is not a surprise. */
export function SetupTimer({ gate, tone = "dark" }: { gate?: SetupGate | null; tone?: "dark" | "light" }) {
  // Counts down by itself: not every page that shows it asks for its data again on a clock.
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(iv);
  }, []);
  const left = minutesLeft(gate ?? null, Date.now());
  if (left == null) return null;
  return (
    <span className="rounded-full border px-2 py-0.5 text-[10.5px] font-bold" title="Your window on the live setups"
      style={tone === "dark" ? { borderColor: "rgba(46,232,143,0.3)", background: "rgba(46,232,143,0.08)", color: "#7be8b4" } : { borderColor: "rgba(16,150,90,0.35)", background: "rgba(16,150,90,0.07)", color: "#0f7a4a" }}>
      Open · {left} min left
    </span>
  );
}
