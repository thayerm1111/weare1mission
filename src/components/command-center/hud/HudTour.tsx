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

const KEY = "cc-tour-done-v1";
export const tourSeen = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return true; } };
const markSeen = () => { try { localStorage.setItem(KEY, "1"); } catch { /* private mode */ } };

type Step = { id: string; title: string; body: string; tip?: string };

const STEPS: Step[] = [
  { id: "price", title: "Gold, right now", body: "The live XAUUSD price from the feed ATLAS reads, with the move against today's open, a sparkline of the last stretch, and the day's high, low, range and spread. Everything else on the desk is built from this number.", tip: "Green and red flashes are ticks up and down — not signals." },
  { id: "mode", title: "Market mode, session, confidence", body: "ATLAS's one-line read of what kind of market this is (trending, ranging, breaking out…), which trading session is active, and how confident ATLAS is in its own current thesis. When the border turns green or red, ATLAS has a side.", tip: "Low confidence is information too: it means ATLAS is standing aside on purpose." },
  { id: "thesis", title: "The thesis", body: "ATLAS's working story for the session: what it thinks price is trying to do and what would prove it wrong. Read this before anything else — every panel below is evidence for or against it." },
  { id: "core", title: "The ATLAS core", body: "This is ATLAS itself. It glows and speaks when something matters, and you can tap it to open a voice line. It is the same engine that produces every read on this screen — there is no separate 'chat bot'." },
  { id: "pulse", title: "Market pulse", body: "The last few minutes measured: what changed, how fast, and whether the feed is live. If the pill says STALE or CLOSED, treat everything on the desk as a snapshot, not a live read." },
  { id: "tf", title: "Timeframe alignment", body: "Whether the 1-hour, 4-hour and daily charts agree with the 15-minute one. Trades taken with the timeframes lined up have room to run; trades taken against them are fighting the bigger picture.", tip: "Ask ATLAS 'where do the timeframes disagree?' — that is usually the risk." },
  { id: "levels", title: "Key levels", body: "The prices ATLAS is actually watching: support, resistance, invalidation points and the next level it expects price to reach. Tap one to pin it on the chart; ATLAS will tell you when price gets there.", tip: "The → marks where price is now." },
  { id: "chart", title: "The chart", body: "Candles on the timeframe you pick, with key levels and liquidity zones drawn over them so you can see ATLAS's read on the price itself. Switch timeframes with the buttons at the top of the panel." },
  { id: "gauges", title: "Pressure, volatility, momentum, conviction", body: "Five dials: how hard sellers and buyers are pushing, how big the swings are (15-minute ATR), which way momentum is leaning, and ATLAS's conviction in its current side. When conviction is high and pressure agrees with the thesis, ATLAS is closest to acting." },
  { id: "scenarios", title: "Scenario analysis", body: "The primary scenario, the alternative, and what would flip ATLAS from one to the other — ranked, not given percentages, because ATLAS has no probability model and won't pretend to." },
  { id: "liquidity", title: "Liquidity radar", body: "Where stops and resting orders are most likely sitting above and below price, estimated from structure (gold is over-the-counter, so no feed shows real orders). Price is often pulled toward these zones before it turns. 'Show on chart' draws them." },
  { id: "structure", title: "Market structure", body: "Higher highs and higher lows, or lower highs and lower lows — the skeleton of the trend. A break of structure is one of the first things that changes ATLAS's thesis." },
  { id: "context", title: "Global context", body: "The dollar, yields, equities and other markets that move gold, refreshed every 15 minutes. Display only: ATLAS and GENX do not trade off these — they are here so you understand the weather." },
  { id: "talk", title: "Talk with ATLAS", body: "Two ways in. Chat: type, or hold space to speak, and get a written answer with the same read the engine trades on. Voice: an open line where ATLAS listens and talks back in real time. The quick buttons ask the questions that matter most.", tip: "Try: 'What would make you take a trade right now?'" },
  { id: "stream", title: "Intelligence stream", body: "ATLAS's running log: every read, level touch, thesis change and alert as it happens. If you step away, this is where you catch up." },
  { id: "nav", title: "Strategy, backtest, alerts, journal", body: "STRATEGY shows the rules ATLAS trades by. BACKTEST replays past sessions so you can watch how it read them. ALERTS lets you set price and level alerts. JOURNAL keeps your notes next to the trades." },
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
