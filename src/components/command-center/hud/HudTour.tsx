"use client";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { H } from "./theme";

/**
 * GUIDED WALKTHROUGH OF THE COMMAND CENTER (owner 09-22).
 *
 * Purely additive: it draws a spotlight over the panel each step talks about and a small card that
 * says what that panel is for and how to use it. Nothing on the desk is moved, restyled or hidden.
 * Anchors are `data-tour` attributes (HudPanel's `tour` prop). A step whose anchor is not on screen
 * (mobile layouts hide some panels) is skipped, so the tour never points at empty space.
 *
 * It opens once per browser (localStorage) and any time from the GUIDE button in the header.
 */

// v2: the ATLAS layout (read, scenarios, folded indicators, copilot dock) — shown once more to everyone.
const KEY = "cc-tour-done-v2";
export const tourSeen = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return true; } };
const markSeen = () => { try { localStorage.setItem(KEY, "1"); } catch { /* private mode */ } };

type Step = { id: string; title: string; body: string; tip?: string };

const STEPS: Step[] = [
  { id: "price", title: "Gold, right now — and how fresh it is", body: "The XAUUSD price, whose it is (Twelve Data's composite mid, not a broker's bid or ask), when the quote arrived, how old the analysis is, the session, and how the price is reaching you. The quote and the analysis carry their own times: a price moves faster than a conclusion.", tip: "The status pill is green LIVE only while streamed ticks are arriving. DELAYED, RECONNECTING, STALE, MARKET CLOSED and DEMO mean exactly that." },
  { id: "automation", title: "Automation", body: "What you've asked ATLAS to do on its own. The server's autopilot setting isn't reported to this screen, so a request for auto-entry is labelled as a request — never as ARMED." },
  { id: "generate", title: "Generate with ATLAS", body: "One press and ATLAS's engine names a side and a trade, every time: which way, where to enter, the stop, the targets and why. It is the setup engine's trade when it has one ready, a plan at the levels its read stands on when the lean is clear, and otherwise a forced read — the side the evidence tilts to, labelled FORCED READ with its conviction shown.", tip: "A forced read is not a trade ATLAS would take on its own, so taking it is your call. Nothing is sent from there: taking any idea goes through the same confirm screen as every other trade." },
  { id: "read", title: "ATLAS's read", body: "Which way ATLAS leans and why: the evidence for and against (tap any underlined line to see it on the chart), what it's watching next and what would prove it wrong. The evidence balance measures agreement — it is not a probability.", tip: "A lean is not an entry. Setup stage and entry sit in their own box, and only the setup engine can confirm an entry." },
  { id: "tf", title: "Timeframe alignment", body: "Whether the daily, 4-hour, 1-hour, 15-minute and 5-minute charts agree. Disagreement is shown, not hidden — it is usually the risk." },
  { id: "levels", title: "Key levels", body: "The prices ATLAS is actually watching: support, resistance and invalidation points. Tap one to pin it on the chart.", tip: "The → marks the price at the last analysis." },
  { id: "chart", title: "The chart — where ATLAS points", body: "Live candles on the timeframe you pick — the forming candle moves with each streamed tick. When ATLAS answers, it marks what it is talking about as it says it: a level, a zone, a candle, a swing, how far price is from the level it is watching. Tap one of its marks to ask why it matters.", tip: "The ATLAS row above the chart: Show me steps through the last answer; Explain this candle asks about the candle you tapped; Clear Atlas drawings removes its marks and never your own lines. A dashed path labelled CONDITIONAL SCENARIO is a condition, not a forecast." },
  { id: "indicators", title: "Indicators (folded)", body: "Pressure, volatility, momentum and conviction, folded into one line. Open it for the gauges; each ⓘ says what the number measures, from what, and how fresh it is.", tip: "Pressure is derived from price action — a proxy, not order flow. Conviction is not a win probability." },
  { id: "scenarios", title: "Scenarios", body: "The base case, the alternative, and what would change ATLAS's view — each with its trigger, its invalidation and a status (watching → developing → confirmed, or invalidated / expired). ‘Show on chart’ draws one as a conditional projection." },
  { id: "core", title: "The ATLAS core", body: "Tap it to open a voice line; tap again to end it. Its ring shows what the line is really doing — listening, hearing you, thinking, speaking, or muted." },
  { id: "talk", title: "Talk with ATLAS", body: "Chat (type, or press space to speak) or Voice. ATLAS answers from the same read and feed the screen shows, and points at the chart as it explains. SETTINGS sets how much it volunteers: Quiet, Watch or Session copilot." },
  { id: "dock", title: "Talk to ATLAS from anywhere", body: "On a phone the copilot lives behind this dock: tap ‘Talk to ATLAS’ to chat, or the microphone to open a voice line. The chart stays on screen while ATLAS talks; TRANSCRIPT opens the words, and the arrow makes them full height." },
  { id: "stream", title: "Intelligence timeline", body: "One timestamped line per thing worth knowing: structure, price, news, trade events, and what ATLAS volunteered (🔊 when it was spoken). Tap a line to read all of it." },
  { id: "deeper", title: "Deeper analysis", body: "The lean journal (every change of lean and why), candidate liquidity zones (inferred from structure — there is no order book), market structure, and global context." },
  { id: "nav", title: "Strategy, backtest, alerts, journal", body: "STRATEGY shows the rules ATLAS trades by. BACKTEST replays recorded sessions. ALERTS lists the levels you've asked ATLAS to watch. JOURNAL keeps the day's engine theses." },
];

type Rect = { top: number; left: number; width: number; height: number } | null;

export function HudTour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect>(null);
  const [avail, setAvail] = useState<Step[]>(STEPS);

  // Only steps whose anchor exists and is visible on this layout.
  useEffect(() => {
    const ok = STEPS.filter((s) => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${s.id}"]`);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8;
    });
    setAvail(ok.length ? ok : STEPS.slice(0, 1));
  }, []);

  const step = avail[Math.min(i, avail.length - 1)];

  const measure = useCallback(() => {
    if (!step) return;
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.id}"]`);
    if (!el) { setRect(null); return; }
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    setRect({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
  }, [step]);

  useLayoutEffect(() => { measure(); }, [measure]);
  useEffect(() => {
    const on = () => measure();
    window.addEventListener("resize", on); window.addEventListener("scroll", on, true);
    return () => { window.removeEventListener("resize", on); window.removeEventListener("scroll", on, true); };
  }, [measure]);

  const finish = useCallback(() => { markSeen(); onClose(); }, [onClose]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") finish(); if (e.key === "ArrowRight") setI((x) => Math.min(avail.length - 1, x + 1)); if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1)); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [avail.length, finish]);

  if (!step) return null;
  const last = i >= avail.length - 1;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200, vh = typeof window !== "undefined" ? window.innerHeight : 800;
  // Card placement: below the target if there is room, else above, else centered; clamped to the viewport.
  const cardW = Math.min(380, vw - 24);
  let cardTop = 24, cardLeft = 12;
  if (rect) {
    const below = rect.top + rect.height + 12, above = rect.top - 12;
    cardTop = below + 220 < vh ? below : above - 220 > 0 ? above - 220 : Math.max(12, vh / 2 - 110);
    cardLeft = Math.min(Math.max(12, rect.left), vw - cardW - 12);
  }

  return (
    <div className="fixed inset-0 z-[80]" style={{ pointerEvents: "auto" }} aria-modal role="dialog" aria-label="Command Center guide">
      {/* dim everything except the target (the spotlight is a huge box-shadow) */}
      {rect ? (
        <div className="absolute rounded-[12px] transition-all duration-300" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, boxShadow: "0 0 0 9999px rgba(3,8,14,0.78)", border: `1px solid ${H.gold3}`, outline: "1px solid rgba(0,199,232,0.35)", outlineOffset: 3, pointerEvents: "none" }} />
      ) : (
        <div className="absolute inset-0" style={{ background: "rgba(3,8,14,0.78)" }} />
      )}
      <div className="absolute rounded-[12px] p-4" style={{ top: cardTop, left: cardLeft, width: cardW, background: `linear-gradient(180deg, ${H.panel2} 0%, ${H.panel} 100%)`, border: `1px solid ${H.lineHi}`, boxShadow: "0 18px 50px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,199,232,0.08)", color: H.text }}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[9.5px] font-bold uppercase tracking-[0.2em]" style={{ color: H.gold3 }}>Command Center guide · {i + 1} / {avail.length}</p>
          <button onClick={finish} className="text-[10px] tracking-[0.12em]" style={{ color: H.mut }}>SKIP</button>
        </div>
        <h3 className="mt-2 text-[15px] font-semibold">{step.title}</h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: H.mut }}>{step.body}</p>
        {step.tip && <p className="mt-2 rounded-[8px] px-2.5 py-2 text-[11.5px]" style={{ background: "rgba(213,169,61,0.08)", border: "1px solid rgba(231,196,103,0.3)", color: H.text }}>{step.tip}</p>}
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex gap-1">{avail.map((s, k) => <span key={s.id} className="h-1 w-3 rounded-full" style={{ background: k <= i ? H.gold2 : "rgba(255,255,255,0.12)" }} />)}</div>
          <div className="flex gap-2">
            <button onClick={() => setI((x) => Math.max(0, x - 1))} disabled={i === 0} className="rounded-[7px] px-3 py-1.5 text-[11px] font-semibold disabled:opacity-30" style={{ color: H.text, border: `1px solid ${H.line}` }}>Back</button>
            <button onClick={() => (last ? finish() : setI((x) => x + 1))} className="rounded-[7px] px-3.5 py-1.5 text-[11px] font-bold" style={{ background: H.gold2, color: "#10131A" }}>{last ? "Done" : "Next"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
