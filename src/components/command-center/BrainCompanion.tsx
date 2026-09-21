"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, Maximize2, Pin, PinOff } from "lucide-react";
import { BrainCore } from "./BrainCore";
import { VoiceSession, type VoiceStatus } from "./VoiceSession";
import { isDesktop, onSummoned, openCommandCenter, setAlwaysOnTop, setCompanionSize, followEverywhere } from "@/lib/desktop";

/**
 * ATLAS COMPANION.
 *
 * A small presence that sits in the corner of a working day and knows one instrument extremely well.
 * It is not a second Command Center and it is emphatically not a miniature broker terminal: it shows
 * the few things worth interrupting someone for, and opens the real thing when there is more to see.
 *
 * IT IS THE SAME BRAIN. Every number here comes from the same endpoint the full screen reads, on the
 * same cadence, through the same account. There is no local reasoning, no second copy of the state and
 * nothing cached across a disconnect — when the feed goes, this says so rather than continuing to
 * display the last thing it believed.
 *
 * WHAT IT REFUSES TO DO. It never shows a live state while connecting (§24), never animates on a timer
 * rather than on the market (§10), and never acts on a position through any path but the one the full
 * application uses. Taking a trade from here is the same call, the same permissions and the same risk
 * checks; the companion is a surface, never a shortcut.
 */

const C = {
  panel: "rgba(10,14,21,0.92)", raised: "#0E131C", line: "rgba(255,255,255,0.08)",
  text: "#E8EFF7", mut: "rgba(232,239,247,0.56)", mut2: "rgba(232,239,247,0.34)",
  gold: "#F0C475", up: "#3FD9A0", down: "#F4737B", cold: "#6FA8DC", amber: "#E9B949",
};

type Brain = { presence: string; headline: string; focus: string[]; question: string; intensity: number; lean: number };
type Trade = {
  active: boolean; side: "buy" | "sell" | null; style: string | null; entry: number | null;
  metrics: { pips: number; money: number | null; r: number | null } | null;
  character: { state: string; headline: string } | null;
  health: { score: number; verdict: string } | null;
  protection: { action: string; urgency: string; say: string } | null;
};
type Setup = {
  state: string; side: string | null; style: string | null; confidence: number;
  headline: string; say: string; expectedMovePips: [number, number] | null;
};
type Live = {
  ok: boolean; connected: boolean; marketOpen: boolean; price: number | null; reason: string | null;
  intensity: number; summary: string;
  pressure: { net: number } | null;
  brain: Brain | null; trade?: Trade; setup?: Setup;
  events?: { key: string }[];
};

/* ── the state, as one word ───────────────────────────────────────────────── */

/**
 * WHAT THE COMPANION IS DOING, DERIVED — never stored.
 *
 * The specification lists fifteen states. They are not a field on the payload and should not become
 * one: every one of them is already implied by what the system knows, and a second authority on "what
 * state are we in" is a second thing that can disagree with the first.
 */
function stateOf(d: Live | null, booting: boolean): { word: string; tone: string; alive: boolean } {
  if (booting) return { word: "CONNECTING", tone: C.mut2, alive: false };
  if (!d || !d.ok) return { word: "BACKEND DISCONNECTED", tone: C.down, alive: false };
  /*
   * CLOSED IS CHECKED BEFORE DISCONNECTED, AND THE ORDER IS THE WHOLE POINT.
   *
   * There is no live feed at the weekend, so `connected` is false every Saturday — and testing that
   * first reports a perfectly healthy system as broken, in red, next to a line correctly explaining
   * that gold is shut. A market that is closed is not a fault, and the companion must never raise an
   * alarm about one; only a feed that has gone missing while the market is OPEN is worth a red word.
   */
  if (!d.marketOpen) return { word: "MARKET CLOSED", tone: C.mut2, alive: false };
  if (!d.connected) return { word: "DISCONNECTED", tone: C.down, alive: false };

  const t = d.trade;
  if (t?.active) {
    if (t.protection && t.protection.urgency !== "none") return { word: "PROTECTING", tone: C.amber, alive: true };
    if (t.character?.state === "change_of_character") return { word: "CHANGE OF CHARACTER", tone: C.down, alive: true };
    return { word: "TRADE ACTIVE", tone: C.gold, alive: true };
  }

  const s = d.setup;
  if (s?.state === "ready" || s?.state === "armed") return { word: "TRADE READY", tone: C.up, alive: true };
  if (s?.state === "developing") return { word: "SETUP DEVELOPING", tone: C.amber, alive: true };

  const p = d.brain?.presence ?? "observing";
  const word = ({
    observing: "OBSERVING", calm: "OBSERVING", watching_level: "WATCHING", attention: "SCANNING",
    market_shift: "SCANNING", setup_developing: "SETUP DEVELOPING", setup_armed: "TRADE READY",
    trade_active: "TRADE ACTIVE", protecting_trade: "PROTECTING", high_news_risk: "SCANNING",
    market_unclear: "SCANNING", market_closed: "MARKET CLOSED", offline: "DEGRADED",
  } as Record<string, string>)[p] ?? "OBSERVING";
  return { word, tone: word === "DEGRADED" ? C.down : C.cold, alive: true };
}

/** The single line the companion says. One, chosen by what matters most right now. */
function oneLine(d: Live | null, booting: boolean): string {
  if (booting) return "Reaching ATLAS…";
  if (!d || !d.ok) return "I can't reach the server. Nothing here is live.";
  if (!d.connected || !d.marketOpen) return d.reason ?? d.summary ?? "Nothing live to read.";
  const t = d.trade;
  if (t?.active) return t.protection?.say || t.character?.headline || t.health?.verdict || "Following the trade.";
  if (d.setup?.say) return d.setup.say;
  return d.brain?.headline || d.summary || "Watching.";
}

const pip = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n)}`;

/** §12 — the line's own state, in the companion's vocabulary. */
const VOICE_WORD: Record<string, string> = {
  connecting: "CONNECTING", awaiting_mic: "WAITING FOR MIC", listening: "LISTENING",
  speaking: "SPEAKING", muted: "MUTED", disconnected: "DISCONNECTED", error: "VOICE ERROR",
};
const VOICE_TONE: Record<string, string> = {
  connecting: C.mut2, awaiting_mic: C.amber, listening: C.up,
  speaking: C.gold, muted: C.amber, disconnected: C.down, error: C.down,
};

export default function BrainCompanion() {
  const [d, setD] = useState<Live | null>(null);
  const [booting, setBooting] = useState(true);
  /*
   * ALWAYS ON TOP IS A SETTING, NOT A BEHAVIOUR.
   *
   * §4 is explicit that it must not be forced, and a window that quietly reasserts itself over
   * everything else every time it is reopened is forcing it. The choice is read before the first paint
   * and written the moment it changes, so it survives a restart the way a setting should.
   */
  const [pinned, setPinned] = useState(() => {
    try { return localStorage.getItem("cc.companion.pinned") !== "0"; } catch { return true; }
  });
  const [open, setOpen] = useState(false);
  const [voice, setVoice] = useState<VoiceStatus>("idle");
  const desktop = useMemo(() => isDesktop(), []);
  const lastHeight = useRef(0);

  /* ── the same feed the full screen reads ───────────────────────────────── */
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/command-center/live", { cache: "no-store" });
        const j = (await r.json()) as Live;
        if (alive) { setD(j); setBooting(false); }
      } catch {
        // A failed poll is a disconnection, and is shown as one rather than as the last good state.
        if (alive) { setD(null); setBooting(false); }
      }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  /* ── always on top, which is the member's choice and not ours ──────────── */
  useEffect(() => {
    try { localStorage.setItem("cc.companion.pinned", pinned ? "1" : "0"); } catch { /* private window */ }
    if (!desktop) return;
    void setAlwaysOnTop(pinned);
    void followEverywhere(pinned);
  }, [desktop, pinned]);

  /*
   * Summoned by the keyboard.
   *
   * Reaching for a shortcut is not an ambiguous act — nobody presses it to look at a small window.
   * So the line opens in the same gesture, and the member can simply start talking.
   */
  useEffect(() => {
    let stop: (() => void) | null = null;
    void onSummoned(() => setOpen(true)).then((off) => { stop = off; });
    return () => { stop?.(); };
  }, []);

  const st = stateOf(d, booting);
  const trade = d?.trade?.active ? d.trade : null;
  const setup = !trade && (d?.setup?.state === "ready" || d?.setup?.state === "armed") ? d?.setup : null;

  /*
   * The window grows only for the two things worth growing for: a trade that is running, and a trade
   * that is ready to be taken. Everything else stays small enough to ignore.
   */
  const height = open ? 560 : trade || setup ? 340 : 232;
  useEffect(() => {
    if (!desktop || height === lastHeight.current) return;
    lastHeight.current = height;
    void setCompanionSize(360, height);
  }, [desktop, height]);

  const expand = useCallback(() => { void openCommandCenter(); }, []);

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden rounded-2xl border backdrop-blur-xl"
      style={{ borderColor: "rgba(240,196,117,0.20)", background: C.panel, color: C.text }}
    >
      {/* Drag handle. On the web it is simply a header; the attribute means nothing outside the shell. */}
      <div data-tauri-drag-region className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5 select-none">
        <p data-tauri-drag-region className="flex items-baseline gap-2 text-[9.5px] font-bold uppercase tracking-[0.2em]" style={{ color: C.gold }}>
          Atlas
          {/* The line's own state, reported by the session rather than guessed at from out here. */}
          {open && voice !== "idle" && (
            <span style={{ color: VOICE_TONE[voice] ?? C.mut2 }}>{VOICE_WORD[voice] ?? ""}</span>
          )}
        </p>
        <div className="flex items-center gap-1">
          {desktop && (
            <button onClick={() => setPinned((p) => !p)} title={pinned ? "Stop floating on top" : "Float on top"}
              className="rounded-lg p-1.5" style={{ color: pinned ? C.gold : C.mut2 }}>
              {pinned ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
            </button>
          )}
          <button onClick={expand} title="Open Command Center" className="rounded-lg p-1.5" style={{ color: C.mut }}>
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
        {/* ── the orb, the state, the price ── */}
        <div className="flex items-center gap-3">
          <BrainCore
            intensity={d?.brain?.intensity ?? d?.intensity ?? 0}
            lean={d?.brain?.lean ?? d?.pressure?.net ?? 0}
            load={d?.events?.length ?? 0}
            alive={st.alive}
            size={64}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: st.tone }}>
              {st.word}
            </p>
            <p className="mt-0.5 text-[22px] font-semibold tabular-nums leading-none"
              style={{ color: d?.price ? C.text : C.mut2 }}>
              {d?.price ? d.price.toFixed(2) : "—"}
            </p>
            {d?.brain?.focus?.length ? (
              <p className="mt-1 truncate text-[10px]" style={{ color: C.mut2 }}>{d.brain.focus.slice(0, 2).join(" · ")}</p>
            ) : null}
          </div>
        </div>

        {/* ── the one line ── */}
        <p className="text-[12px] leading-snug" style={{ color: C.mut }}>{oneLine(d, booting)}</p>

        {/*
          * THE QUESTION.
          *
          * The thing ATLAS is actually trying to answer about gold right now, and the most
          * revealing sentence on the full screen — it says what the system is uncertain about, which
          * is more useful than any number it is certain of. Shown only while there is a market to be
          * uncertain about.
          */}
        {st.alive && d?.brain?.question && !trade && (
          <p className="text-[11px] italic leading-snug" style={{ color: C.mut2 }}>{d.brain.question}</p>
        )}

        {/* ── a trade that is running ── */}
        {trade && (
          <div className="rounded-xl border px-2.5 py-2" style={{ borderColor: C.line, background: C.raised }}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em]"
                style={{ color: trade.side === "buy" ? C.up : C.down }}>
                {trade.side === "buy" ? "Long" : "Short"} XAUUSD{trade.style ? ` · ${trade.style}` : ""}
              </span>
              {trade.health && (
                <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>{trade.health.verdict}</span>
              )}
            </div>
            <div className="mt-1 flex items-baseline gap-3 tabular-nums">
              <span className="text-[18px] font-semibold"
                style={{ color: (trade.metrics?.pips ?? 0) >= 0 ? C.up : C.down }}>
                {trade.metrics ? `${pip(trade.metrics.pips)} pips` : "—"}
              </span>
              {trade.metrics?.r != null && (
                <span className="text-[12px]" style={{ color: C.mut }}>{trade.metrics.r.toFixed(2)}R</span>
              )}
            </div>
          </div>
        )}

        {/* ── a trade that is ready ── */}
        {setup && (
          <div className="rounded-xl border px-2.5 py-2" style={{ borderColor: "rgba(63,217,160,0.28)", background: "rgba(63,217,160,0.06)" }}>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.up }}>
              {setup.side === "buy" ? "Buy" : "Sell"} XAUUSD{setup.style ? ` · ${setup.style}` : ""}
            </p>
            <p className="mt-1 text-[11.5px] leading-snug" style={{ color: C.mut }}>{setup.headline}</p>
            {/*
              * DETAILS, NOT EXECUTION.
              *
              * Taking a trade means risk, permissions and a live order, and all three of those live in
              * the full application. A button here that skipped any of them would be the single most
              * dangerous control in the product, so this one opens the place where the decision is
              * made properly.
              */}
            <button onClick={expand}
              className="mt-2 w-full rounded-lg px-3 py-2 text-[10.5px] font-bold uppercase tracking-[0.14em]"
              style={{ background: "rgba(63,217,160,0.14)", color: C.up, border: "1px solid rgba(63,217,160,0.30)" }}>
              Review it in Command Center
            </button>
          </div>
        )}

        {/* ── the voice, which is the point of the companion ── */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {open ? <VoiceSession onStatus={setVoice} /> : null}
        </div>

        <button onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[10.5px] font-bold uppercase tracking-[0.14em]"
          style={{ background: open ? "rgba(255,255,255,0.04)" : "rgba(240,196,117,0.14)", color: open ? C.mut : C.gold, border: `1px solid ${open ? C.line : "rgba(240,196,117,0.30)"}` }}>
          <ChevronUp className="h-3.5 w-3.5" style={{ transform: open ? "rotate(180deg)" : undefined }} />
          {open ? "Close the line" : "Talk to ATLAS"}
        </button>
      </div>
    </div>
  );
}
