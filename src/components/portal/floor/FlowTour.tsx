"use client";

/**
 * FLOW GUIDED TOUR — a video-game style onboarding system (owner directive 08-31).
 *
 * Three pieces:
 *  1. <FlowIntro/>  — first-visit popup on The Floor: "Connect to FLOW". One button takes
 *     them to the FLOW tab where the guide takes over. Never shown again once seen,
 *     and never shown to members who are already connected.
 *  2. <FlowTour/>   — the spotlight walkthrough, mounted inside FlowConnect:
 *     · NOT connected → walks the connect form field by field (Demo/Live, Server,
 *       Email, Password, Connect button).
 *     · Connected     → walks every control: Trading toggle, Follow every GENX signal,
 *       Risk %, Manage trades, Safety mode, Gold breakeven pips, Default risk,
 *       Auto-run FLOW, Connect another account — then the credits reminder finale.
 *  3. A floating "? Guide" chip so anyone can replay the tour any time.
 *
 * Targets are found by [data-tour="…"] attributes in FlowConnect. Steps whose target
 * isn't on screen are skipped automatically, so the tour never strands anyone.
 * Progress is remembered in localStorage per browser.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Step = { sel: string; title: string; body: string };

const LS_INTRO = "w1m_flow_intro_seen_v1";
const LS_CONNECT = "w1m_flow_tour_connect_v1";
const LS_CONTROLS = "w1m_flow_tour_controls_v1";

const lsGet = (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string) => { try { window.localStorage.setItem(k, "1"); } catch { /* private mode */ } };

const CONNECT_STEPS: Step[] = [
  {
    sel: "ft-env",
    title: "Step 1 · Pick your environment",
    body: "Demo is a practice account with fake money — perfect for testing FLOW risk-free. Live is your real funded account. Not sure? Start on Demo. You can connect both later.",
  },
  {
    sel: "ft-server",
    title: "Step 2 · Your broker server",
    body: "Type the server name from your TradeLocker welcome email — for most of the community that's GENFX. It's the same server name you use to log in to TradeLocker itself.",
  },
  {
    sel: "ft-email",
    title: "Step 3 · Your TradeLocker email",
    body: "The email you registered your TradeLocker account with — not your 1 Mission login (unless they're the same).",
  },
  {
    sel: "ft-password",
    title: "Step 4 · Your TradeLocker password",
    body: "Your TradeLocker password goes straight to the broker over an encrypted connection and is never stored in plain text. Never share your withdrawal password with anyone.",
  },
  {
    sel: "ft-connect",
    title: "Step 5 · Hit Connect!",
    body: "That's it — press this button and FLOW links to your broker. The moment you're connected, this guide continues automatically and shows you what every switch does.",
  },
];

const CONTROL_STEPS: Step[] = [
  {
    sel: "ft-account",
    title: "Your trading account",
    body: "You're connected! This card is one of your broker accounts — its number, currency, and live balance. Every switch below controls THIS account only, so different accounts can run different settings.",
  },
  {
    sel: "ft-trading",
    title: "The Trading switch",
    body: "The master switch for this account. ON (green) = FLOW copies trades onto this account automatically. OFF = this account sits out. Nothing trades unless this is on.",
  },
  {
    sel: "ft-genx",
    title: "Follow every GENX signal",
    body: "GENX is the gold engine. Flip this ON and this account takes every GENX gold call the moment it fires — entries, stops, and targets included, sized to the Risk % below. This works separately from FLOW's forex trades.",
  },
  {
    sel: "ft-risk",
    title: "Risk % — how big each trade is",
    body: "This decides how much of the account is risked on each trade. 0.5% is cautious, 1–2% is standard, 5% is aggressive. Example: at 1% on a $10,000 account, a losing trade costs about $100. Start small — you can raise it any time.",
  },
  {
    sel: "ft-manage",
    title: "Manage trades",
    body: "ON = FLOW protects your winners for you: when a trade moves in your favor it banks a 50% partial and moves your stop to breakeven, so a winner can't turn into a loser. OFF = the trade rides the original stop and target untouched. We recommend ON.",
  },
  {
    sel: "ft-safety",
    title: "Safety mode",
    body: "🛡 Conservative pauses THIS account for 4 hours after 2 losses in a row — a built-in cooldown on rough days. ⚡ Aggressive has no cap and keeps trading through losses. New to this? Stay Conservative.",
  },
  {
    sel: "ft-bepips",
    title: "Gold breakeven pips",
    body: "Gold only: how many pips into profit before FLOW banks the partial and moves your stop to breakeven. Leave it blank and the AI picks the moment for you — that's the recommended setting. Forex trades are always AI-managed.",
  },
  {
    sel: "ft-defaultrisk",
    title: "Default risk per trade",
    body: "The fallback size for any account that doesn't have its own Risk % chosen above. Lock one in so every account always has a size.",
  },
  {
    sel: "ft-autorun",
    title: "Auto-run FLOW",
    body: "The forex engine's on-switch. With this ON, FLOW watches the market and places forex/index setups on your armed accounts automatically — no clicking, day and night while the market is open.",
  },
  {
    sel: "ft-addaccount",
    title: "More than one account?",
    body: "Tap here to link another TradeLocker login — a second broker, a funded account, whatever you run. FLOW trades every account you switch on, each with its own risk and settings.",
  },
];

/* ─────────────────────────────── Intro popup (The Floor, first visit) ─────────────────────────────── */

export function FlowIntro({ onGo }: { onGo: () => void }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (lsGet(LS_INTRO) || lsGet(LS_CONTROLS)) return; // seen it, or already toured the controls
    let alive = true;
    (async () => {
      try {
        // Already connected members never see the connect pitch.
        const r = await fetch("/api/flow/autorun", { cache: "no-store" });
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (d?.connected) { lsSet(LS_INTRO); return; }
      } catch { /* offline → still offer */ }
      if (alive) setShow(true);
    })();
    return () => { alive = false; };
  }, []);

  if (!show) return null;
  const dismiss = () => { lsSet(LS_INTRO); setShow(false); };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-emerald-500/40 bg-[#0c1220] p-6 text-white shadow-[0_0_60px_rgba(16,185,129,0.25)]">
        <div className="text-4xl">⚡</div>
        <h2 className="mt-3 text-xl font-extrabold tracking-tight">Connect to FLOW</h2>
        <p className="mt-2 text-sm leading-relaxed text-white/70">
          FLOW links to your broker and copies the desk&apos;s trades onto your account automatically —
          entries, stops, targets, and trade management, hands-free.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-white/70">
          It takes about <b className="text-emerald-400">2 minutes</b> to set up, and this guide will walk
          you through every step and every switch.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            onClick={() => { lsSet(LS_INTRO); setShow(false); onGo(); }}
            className="w-full rounded-xl bg-gradient-to-r from-emerald-400 to-emerald-600 px-4 py-3 text-sm font-extrabold text-white shadow-[0_0_20px_rgba(16,185,129,0.4)] transition hover:brightness-110"
          >
            🎮 Show me how — let&apos;s connect
          </button>
          <button onClick={dismiss} className="w-full rounded-xl px-4 py-2 text-xs font-semibold text-white/40 hover:text-white/70">
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────── The spotlight tour ─────────────────────────────────── */

type Phase = "idle" | "welcome" | "steps" | "finale";

export function FlowTour({ connected }: { connected: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<"connect" | "controls">("connect");
  const [i, setI] = useState(0);
  // Snoozed = closed without completing. The tour stays quiet for THIS visit but comes
  // back next time — only pressing "Completed" at the finale dismisses it for good
  // (owner directive 08-31: they have to select completed).
  const [snoozed, setSnoozed] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const wasConnected = useRef(connected);

  const steps = mode === "connect" ? CONNECT_STEPS : CONTROL_STEPS;

  // Auto-launch rules.
  useEffect(() => {
    if (phase !== "idle" || snoozed) return;
    if (!connected && !lsGet(LS_CONNECT)) { setMode("connect"); setPhase("welcome"); return; }
    if (connected && !lsGet(LS_CONTROLS)) { setMode("controls"); setPhase("welcome"); }
  }, [connected, phase, snoozed]);

  // The magic hand-off: the moment the member connects mid-tour, jump straight into the controls tour.
  useEffect(() => {
    if (connected && !wasConnected.current) {
      lsSet(LS_CONNECT);
      if (!lsGet(LS_CONTROLS)) {
        setMode("controls"); setI(0);
        setPhase("steps");
      } else {
        setPhase("idle");
      }
    }
    wasConnected.current = connected;
  }, [connected]);

  // Track the highlighted element's rectangle (follows scroll/resize/layout shifts).
  useEffect(() => {
    if (phase !== "steps") { setRect(null); return; }
    let raf = 0; let alive = true;
    const track = () => {
      if (!alive) return;
      const el = document.querySelector(`[data-tour="${steps[i]?.sel}"]`);
      if (el) {
        const r = (el as HTMLElement).getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      } else {
        setRect(null);
      }
      raf = window.requestAnimationFrame(track);
    };
    // Bring the target into view once per step.
    const el = document.querySelector(`[data-tour="${steps[i]?.sel}"]`);
    if (el) (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
    raf = window.requestAnimationFrame(track);
    return () => { alive = false; window.cancelAnimationFrame(raf); };
  }, [phase, i, steps]);

  // COMPLETE — the only path that dismisses the tour permanently.
  const complete = useCallback(() => {
    lsSet(mode === "connect" ? LS_CONNECT : LS_CONTROLS);
    setPhase("idle"); setI(0); setSnoozed(true);
  }, [mode]);

  // Close without completing — quiet for this visit, offered again next time.
  const snooze = useCallback(() => {
    setPhase("idle"); setI(0); setSnoozed(true);
  }, []);

  const next = useCallback(() => {
    // Skip any step whose target isn't rendered (e.g. breakeven pips when Manage trades is off).
    let n = i + 1;
    while (n < steps.length && !document.querySelector(`[data-tour="${steps[n].sel}"]`)) n++;
    if (n >= steps.length) {
      if (mode === "controls") { setPhase("finale"); }
      else { snooze(); } // connect walkthrough ends when they actually connect — not before
    } else setI(n);
  }, [i, steps, mode, snooze]);

  const back = useCallback(() => {
    let p = i - 1;
    while (p >= 0 && !document.querySelector(`[data-tour="${steps[p].sel}"]`)) p--;
    if (p >= 0) setI(p);
  }, [i, steps]);

  const start = () => {
    let n = 0;
    while (n < steps.length && !document.querySelector(`[data-tour="${steps[n].sel}"]`)) n++;
    if (n >= steps.length) { snooze(); return; }
    setI(n); setPhase("steps");
  };

  const replay = () => {
    setMode(connected ? "controls" : "connect");
    setSnoozed(false);
    setI(0); setPhase("welcome");
  };

  /* Replay chip — always available on the FLOW screen. */
  const chip = phase === "idle" && (
    <button
      onClick={replay}
      className="fixed bottom-5 right-5 z-[90] inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-[#0c1220]/95 px-4 py-2 text-xs font-bold text-emerald-400 shadow-lg backdrop-blur transition hover:bg-emerald-500/10"
    >
      ❓ FLOW Guide
    </button>
  );

  if (phase === "idle") return <>{chip}</>;

  /* Welcome cards. */
  if (phase === "welcome") {
    const isConnect = mode === "connect";
    return (
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
        <div className="w-full max-w-md rounded-2xl border border-emerald-500/40 bg-[#0c1220] p-6 text-white shadow-[0_0_60px_rgba(16,185,129,0.25)]">
          <div className="text-4xl">{isConnect ? "🔗" : "🎛️"}</div>
          <h2 className="mt-3 text-xl font-extrabold tracking-tight">
            {isConnect ? "Let's connect your broker" : "You're connected — quick tour?"}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-white/70">
            {isConnect
              ? "5 quick steps. I'll point at each field and tell you exactly what goes in it. Have your TradeLocker login handy."
              : "60 seconds. I'll point at every switch on this screen and tell you in plain English what it does — GENX, risk %, trade management, all of it."}
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <button
              onClick={start}
              className="w-full rounded-xl bg-gradient-to-r from-emerald-400 to-emerald-600 px-4 py-3 text-sm font-extrabold text-white shadow-[0_0_20px_rgba(16,185,129,0.4)] transition hover:brightness-110"
            >
              {isConnect ? "▶ Start the walkthrough" : "▶ Show me the switches"}
            </button>
            <button onClick={snooze} className="w-full rounded-xl px-4 py-2 text-xs font-semibold text-white/40 hover:text-white/70">
              Not now — remind me next time
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* Finale — the credits reminder. */
  if (phase === "finale") {
    return (
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
        <div className="w-full max-w-md rounded-2xl border border-amber-500/50 bg-[#0c1220] p-6 text-white shadow-[0_0_60px_rgba(245,158,11,0.25)]">
          <div className="text-4xl">🏆</div>
          <h2 className="mt-3 text-xl font-extrabold tracking-tight">You&apos;re all set — one last thing</h2>
          <p className="mt-2 text-sm leading-relaxed text-white/70">
            While auto-run is watching the market for an entry, FLOW uses{" "}
            <b className="text-amber-400">1 credit every 30 minutes</b> — you&apos;re only charged while
            it&apos;s actively working for you, never while the market is closed.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-white/70">
            If your credits hit zero, your trading pauses. Add a card on the Credits page and it{" "}
            <b className="text-emerald-400">auto-refills</b> before that ever happens — set it once,
            never think about it again.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <a
              href="/portal/credits"
              className="w-full rounded-xl bg-gradient-to-r from-amber-400 to-amber-600 px-4 py-3 text-center text-sm font-extrabold text-white shadow-[0_0_20px_rgba(245,158,11,0.35)] transition hover:brightness-110"
            >
              💳 Set up auto-refill →
            </a>
            <button
              onClick={complete}
              className="w-full rounded-xl bg-gradient-to-r from-emerald-400 to-emerald-600 px-4 py-3 text-sm font-extrabold text-white shadow-[0_0_20px_rgba(16,185,129,0.4)] transition hover:brightness-110"
            >
              ✓ Completed — I&apos;m ready to trade
            </button>
            <p className="text-center text-[10px] text-white/35">Pressing Completed is what closes this guide for good — until then it&apos;ll offer again next visit.</p>
          </div>
        </div>
      </div>
    );
  }

  /* Spotlight step. */
  const step = steps[i];
  const done = steps.slice(0, i).filter((s) => document.querySelector(`[data-tour="${s.sel}"]`)).length;
  const total = steps.filter((s) => document.querySelector(`[data-tour="${s.sel}"]`)).length || steps.length;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const pad = 8;
  const below = rect ? rect.top + rect.height + 16 : vh / 2;
  const cardTop = rect && below + 230 > vh ? Math.max(16, rect.top - 246) : below;
  const cardLeft = rect ? Math.min(Math.max(16, rect.left), Math.max(16, vw - 356)) : vw / 2 - 170;

  return (
    <div className="fixed inset-0 z-[120]" style={{ pointerEvents: "auto" }}>
      {/* Spotlight hole — the giant shadow darkens everything except the target. */}
      {rect ? (
        <div
          className="absolute rounded-xl border-2 border-emerald-400 transition-all duration-200"
          style={{
            top: rect.top - pad, left: rect.left - pad,
            width: rect.width + pad * 2, height: rect.height + pad * 2,
            boxShadow: "0 0 0 9999px rgba(3,7,18,0.82), 0 0 24px rgba(52,211,153,0.6)",
            pointerEvents: "none",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-[rgba(3,7,18,0.82)]" style={{ pointerEvents: "none" }} />
      )}

      {/* Step card. */}
      <div
        className="absolute w-[340px] max-w-[calc(100vw-32px)] rounded-2xl border border-emerald-500/40 bg-[#0c1220] p-4 text-white shadow-2xl"
        style={{ top: cardTop, left: cardLeft }}
      >
        <div className="flex items-center justify-between">
          <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-emerald-400">
            {done + 1} / {total}
          </span>
          <button onClick={snooze} className="text-[11px] font-semibold text-white/35 hover:text-white/70">✕ Exit tour</button>
        </div>
        <h3 className="mt-2 text-sm font-extrabold">{step.title}</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-white/70">{step.body}</p>
        {/* Progress bar. */}
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-all" style={{ width: `${((done + 1) / total) * 100}%` }} />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <button onClick={back} disabled={done === 0} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-bold text-white/70 hover:bg-white/5 disabled:opacity-30">
            ‹ Back
          </button>
          {mode === "connect" && done + 1 === total ? (
            <button onClick={snooze} className="rounded-lg bg-gradient-to-r from-emerald-400 to-emerald-600 px-4 py-1.5 text-xs font-extrabold text-white hover:brightness-110">
              Got it — connecting now ✓
            </button>
          ) : (
            <button onClick={next} className="rounded-lg bg-gradient-to-r from-emerald-400 to-emerald-600 px-4 py-1.5 text-xs font-extrabold text-white hover:brightness-110">
              Next ›
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
