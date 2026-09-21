"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, ArrowLeft, BookOpen, Gauge, Radio, Target, Waves } from "lucide-react";
import BrainCore from "./BrainCore";
import PriceMap, { type MapBar, type MapLevel } from "./PriceMap";
import BrainConsole, { type VoiceMode } from "./BrainConsole";
import BrokerBar from "./BrokerBar";
import TradePanel, { CallTradeSheet, UnmanagedNotice, type TradeStateView } from "./TradePanel";
import { BrainTradeCard, ProfileSheet, TradeCompleteCard, type CompletedView, type ProfileView, type SetupView } from "./BrainTrade";
import VoiceSession from "./VoiceSession";
import TradeAlert from "./TradeAlert";
import RiskConsent, { type ConsentView } from "./RiskConsent";

/**
 * COMMAND CENTER XAUUSD.
 *
 * The screen is the physical form of ATLAS: the price map is its vision, the intelligence stream is
 * what it is noticing, the core is its state of mind, and the console is how you talk to it.
 *
 * Every number on this page comes from /api/command-center/live, which serves what the engine measured.
 * The screen computes no market opinion of its own — if it did, it could contradict the engine and the
 * user would have no way to know which one to believe.
 */

const C = {
  bg: "#06090E", panel: "#0A0E15", raised: "#0E131C", line: "rgba(255,255,255,0.07)",
  text: "#E8EFF7", mut: "rgba(232,239,247,0.56)", mut2: "rgba(232,239,247,0.34)",
  gold: "#F0C475", up: "#3FD9A0", down: "#F4737B", cold: "#6FA8DC", amber: "#E9B949",
};

type Tf = { state: string; efficiency: number | null; rsi: number | null; sequence: string | null; positionInRange: number | null };
export type Thesis = {
  id: string; label: string; strength: string; confidence: number; startedAt: number;
  reasonStarted: string[]; reasonStrengthened: string[]; reasonWeakened: string[];
  watching: number[]; invalidationPrice: number | null; priceAtStart: number;
};
export type Ev = {
  key: string; at: number; code: string; detail: string; lean: "bullish" | "bearish" | "neutral";
  channel: string; significance: { score: number; confidence: number };
};
export type Live = {
  ok: boolean; live: boolean; connected: boolean; reason: string | null; at: number | null;
  ageSeconds: number | null; marketOpen: boolean;
  price: number | null; bid: number | null; ask: number | null; spread: number | null;
  session: string | null; regime: string | null;
  pressure: { bullish: number; bearish: number; net: number } | null;
  weather: string | null; velocity: string | null; intensity: number;
  timeframes: Record<string, Tf>; levels: MapLevel[]; bars: MapBar[];
  brain: { presence: string; headline: string; focus: string[]; question: string; intensity: number; lean: number } | null;
  thesis: Thesis | null;
  previousThesis: (Thesis & { endedAt: number | null; reasonEnded: string | null }) | null;
  journal: { id: string; at: number; label: string; strength: string; confidence: number; endedAt: number | null; reasonEnded: string | null }[];
  events: Ev[];
  statements: { at: number; kind: string; text: string; channel: string }[];
  changes: { horizon: string; priceMove: number; pipsMove: number; pressureFrom: number; pressureTo: number }[];
  scenario: { bull: string; bear: string; neutral: string } | null;
  summary: string; warnings: string[]; blockers: { code: string; detail: string }[];
  /** Present once this member has an open position. Everything trade-related hangs off it. */
  trade?: TradeStateView;
  /** What ATLAS currently wants to do about gold. This is the primary trading surface. */
  setup?: SetupView;
  /** Where the Command Center is in its own lifecycle — the screen changes emphasis from this. */
  experience?: {
    state: string; label: string; focus: string; tradeLens: boolean;
    completed: CompletedView | null; note: string | null;
  };
  /** The boundaries ATLAS is working inside. */
  profile?: ProfileView;
  /** What the member asked ATLAS to watch, still armed. */
  watches?: { id: string; said: string; kind: string; label: string | null; price: number | null; progress: number | null; expiresAt: number | null }[];
  /** True only for the replay harness, which renders a loud banner. Never set by the live endpoint. */
  replay?: boolean;
  /** Display-only intelligence (command-center/present/intel.ts). */
  intel?: import("../../../command-center/present/intel").Intel | null;
  features?: Record<string, { atr: number; atrPct: number; volRatio: number; velocity: number; acceleration: number; returns5: number; rangeExpansion: number }>;
};

const TF_ORDER = ["1d", "4h", "1h", "15m", "5m", "1m"];
const words = (s?: string | null) => (s ? s.replace(/_/g, " ") : "—");
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const toneOf = (state: string) =>
  /strong_up|uptrend|bullish/.test(state) ? C.up
  : /strong_down|downtrend|bearish/.test(state) ? C.down
  : /breakout|expansion/.test(state) ? C.gold
  : /compression|range/.test(state) ? C.cold : C.mut;

const leanTone = (l: string) => (l === "bullish" ? C.up : l === "bearish" ? C.down : C.mut2);

/** Describe a pressure move the way a trader would, respecting which side of zero it happened on. */
function pressurePhrase(from: number, to: number): string {
  if (to > from) return to > 0 ? "Buyers strengthening" : "Sellers easing off";
  return from > 0 ? "Buyers fading" : "Sellers strengthening";
}

const PRESENCE_WORD: Record<string, string> = {
  offline: "OFFLINE", market_closed: "MARKET CLOSED", observing: "OBSERVING", calm: "CALM",
  watching_level: "WATCHING A LEVEL", attention: "ATTENTION", market_shift: "MARKET SHIFT",
  setup_developing: "SETUP DEVELOPING", setup_armed: "SETUP ARMED", trade_active: "TRADE ACTIVE",
  protecting_trade: "PROTECTING TRADE", high_news_risk: "HIGH NEWS RISK", market_unclear: "MARKET UNCLEAR",
};

/* ── small building blocks ─────────────────────────────────────────────────── */

function Panel({ title, icon, children, className = "", right }: { title?: string; icon?: React.ReactNode; children: React.ReactNode; className?: string; right?: React.ReactNode }) {
  return (
    <section className={`overflow-hidden rounded-2xl border ${className}`} style={{ borderColor: C.line, background: C.panel }}>
      {title && (
        <div className="flex items-center justify-between gap-2 border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
          <p className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: C.mut2 }}>
            {icon}{title}
          </p>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

/** The price ticks toward its new value instead of jumping — the market flowing through the screen. */
function useEasedNumber(target: number | null, ms = 420) {
  const [v, setV] = useState<number | null>(target);
  const from = useRef<number | null>(target);
  const start = useRef(0);
  const raf = useRef(0);
  useEffect(() => {
    if (target == null) { setV(null); return; }
    if (from.current == null) { from.current = target; setV(target); return; }
    const a = from.current;
    start.current = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start.current) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setV(a + (target - a) * e);
      if (k < 1) raf.current = requestAnimationFrame(step);
      else from.current = target;
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);
  return v;
}

/* ── the screen ────────────────────────────────────────────────────────────── */

export function CommandCenterLive({ endpoint = "/api/command-center/live" }: { endpoint?: string } = {}) {
  const [d, setD] = useState<Live | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<VoiceMode>("push_to_talk");
  const [focusPrice, setFocusPrice] = useState<number | null>(null);
  const [showMath, setShowMath] = useState(false);
  const [flash, setFlash] = useState(0);
  const [callOpen, setCallOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  /*
   * WHETHER THEY HAVE SIGNED.
   *
   * Read for the interface only. The routes enforce it independently and would refuse with this state
   * missing, wrong, or edited in a console — which is the order of authority that matters.
   */
  const [consent, setConsent] = useState<ConsentView | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [reloadAt, setReloadAt] = useState(0);
  // The account and the idempotency key come from the trading route, which is the only place that knows
  // about the broker. The live read deliberately never touches it.
  const [desk, setDesk] = useState<{
    account: { equity: number | null; currency: string | null; isLive: boolean; liveAuthorized: boolean } | null;
    idempotencyKey: string | null;
    profile: ProfileView | null;
  }>({ account: null, idempotencyKey: null, profile: null });
  const lastEventKey = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/command-center/consent", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (alive) setConsent(j.consent ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(endpoint, { cache: "no-store" });
        if (!alive) return;
        if (!r.ok) { setErr(r.status === 401 ? "Sign in to open the Command Center." : "The Command Center is not answering."); return; }
        const j = (await r.json()) as Live;
        setErr(null);
        setD(j);
      } catch { /* keep the last read rather than blanking the screen */ }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [endpoint, reloadAt]);

  // The desk read is separate and slower: it talks to the broker layer, and polling that every five
  // seconds would burn rate limits that matter far more when an order actually needs to go out.
  useEffect(() => {
    if (endpoint.includes("replay")) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/command-center/trade", { cache: "no-store" });
        if (!alive || !r.ok) return;
        const j = await r.json();
        setDesk({ account: j.account ?? null, idempotencyKey: j.idempotencyKey ?? null, profile: j.profile ?? null });
      } catch { /* the card falls back to showing risk without an amount */ }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [endpoint, reloadAt]);

  // A brief flash when something new arrives — a state transition you can see, not a permanent animation.
  useEffect(() => {
    const newest = d?.events?.[0]?.key ?? null;
    if (newest && newest !== lastEventKey.current) {
      lastEventKey.current = newest;
      setFlash((n) => n + 1);
    }
  }, [d]);

  const price = useEasedNumber(d?.price ?? null);

  // What ATLAS wants to say, unprompted: its newest statement, or its loudest new observation.
  const announce = useMemo(() => {
    const st = d?.statements?.[0];
    const loud = d?.events?.find((e) => e.channel === "urgent" || e.channel === "voice");
    if (st && (!loud || st.at >= loud.at)) return { key: `s${st.at}`, text: st.text, urgent: st.channel === "urgent" };
    if (loud) return { key: loud.key, text: loud.detail, urgent: loud.channel === "urgent" };
    return null;
  }, [d]);

  const onUiAction = useCallback((name: string, arg: string | number | null) => {
    if (name === "SHOW_LEVEL" && typeof arg === "number") setFocusPrice(arg);
    if (name === "SHOW_METRICS") setShowMath(true);
    if (name === "SHOW_SCENARIO") document.getElementById("cc-scenario")?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (name === "FOCUS_TIMEFRAME") document.getElementById("cc-timeframes")?.scrollIntoView({ behavior: "smooth", block: "center" });
    /*
     * "Where do I set that up?" should end with the member looking at the thing, not holding
     * directions to it. These two open the panel the answer just described.
     */
    if (name === "OPEN_SETTINGS") {
      setProfileOpen(true);
      document.getElementById("cc-trade-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (name === "OPEN_BROKER") {
      window.dispatchEvent(new CustomEvent("cc:open-broker"));
      document.getElementById("cc-broker")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  if (err) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-6 text-center" style={{ background: C.bg, color: C.text }}>
        <div>
          <p className="text-[13px] font-black tracking-tight">COMMAND CENTER <span style={{ color: C.gold }}>XAUUSD</span></p>
          <p className="mt-2 text-[13px]" style={{ color: C.mut }}>{err}</p>
        </div>
      </div>
    );
  }

  const trade = d?.trade;

  // The position's own events join the market's, in one timeline. A trade is not a separate feed — it is
  // part of what ATLAS is noticing.
  const streamRows = (() => {
    const market = (d?.events ?? []).map((e) => ({ key: e.key, at: e.at, detail: e.detail, lean: e.lean as string, channel: e.channel, trade: false }));
    const pos = (trade?.events ?? []).map((e, i) => ({ key: `t${e.at}-${i}`, at: e.at, detail: e.detail, lean: "trade", channel: e.channel, trade: true }));
    return [...market, ...pos].sort((a, b) => b.at - a.at).slice(0, 34);
  })();

  const brain = d?.brain ?? null;
  const alive = !!d?.connected && !!d?.marketOpen;
  const lean = brain?.lean ?? 0;
  const bull = Math.max(3, Math.min(97, Math.round(50 + lean / 2)));
  const p5 = d?.changes?.find((c) => c.horizon === "5m") ?? null;

  return (
    <div className="min-h-screen w-full px-3 py-3 sm:px-5 sm:py-5" style={{ background: C.bg, color: C.text }}>
      {/* ── header ─────────────────────────────────────────────────────────── */}
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3" style={{ borderColor: C.line, background: C.panel }}>
        <div className="flex items-center gap-2.5">
          {/*
            * THE WAY OUT.
            *
            * The Command Center deliberately hides the site's header and footer — it is a screen, not a
            * page inside a website — and the cost of that was a room with no door. There was no way
            * back to the portal without editing the address bar, which is not something a member
            * should ever have to do.
            *
            * A link rather than history.back(): arriving here from a bookmark, a notification or the
            * desktop app leaves nothing to go back TO, and a button that sometimes does nothing is
            * worse than no button.
            */}
          <a href="/portal" aria-label="Back to the portal"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors"
            style={{ border: `1px solid ${C.line}`, background: C.raised, color: C.mut }}
            onMouseEnter={(e) => { e.currentTarget.style.color = C.gold; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = C.mut; }}>
            <ArrowLeft className="h-4 w-4" />
          </a>
          <div>
            <p className="text-[14px] font-black leading-none tracking-tight">COMMAND CENTER <span style={{ color: C.gold }}>XAUUSD</span></p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: C.mut2 }}>Atlas</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {price != null ? (
            <div className="text-right">
              <p className="text-2xl font-black leading-none tabular-nums tracking-tight">{price.toFixed(2)}</p>
              <p className="mt-1 text-[10px] tabular-nums" style={{ color: C.mut2 }}>
                {d?.bid != null && d?.ask != null ? `${d.bid.toFixed(2)} / ${d.ask.toFixed(2)}` : "single feed"}
                {d?.spread != null ? ` · spread ${d.spread.toFixed(2)}` : ""}
                {p5 ? ` · ${p5.priceMove >= 0 ? "+" : ""}${p5.priceMove.toFixed(2)} in 5m` : ""}
              </p>
            </div>
          ) : (
            <p className="text-[12px]" style={{ color: C.mut2 }}>no price</p>
          )}

          {/*
            FOUR STATUSES, NOT ONE.
            A muted microphone is not a dead market engine, and a breathing orb must never imply live
            data that is not arriving. These four things fail independently, so they are shown
            independently — collapsing them into a single green dot is how somebody ends up believing a
            position is being watched when nothing is watching it.
          */}
          <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em]"
            style={{
              background: d?.live ? "rgba(63,217,160,0.12)" : "rgba(233,185,73,0.12)",
              color: d?.live ? C.up : C.amber,
            }}>
            <Radio className="h-3 w-3" />
            {d?.replay ? "REPLAY" : d?.live ? `MARKET · LIVE ${d.ageSeconds}s` : d?.marketOpen === false ? "MARKET · CLOSED" : "MARKET · NO READ"}
          </span>

          {!d?.replay && (
            <span className="hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] sm:inline-flex"
              style={{
                background: trade?.active ? "rgba(63,217,160,0.10)" : "rgba(255,255,255,0.04)",
                color: trade?.active ? C.up : C.mut2,
                border: `1px solid ${trade?.active ? "rgba(63,217,160,0.26)" : C.line}`,
              }}>
              POSITIONS · {trade?.active ? "MANAGING" : "NONE OPEN"}
            </span>
          )}

          {!d?.replay && (
            <span className="hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] sm:inline-flex"
              style={{
                background: d?.profile?.autoEntry ? "rgba(233,185,73,0.12)" : "rgba(255,255,255,0.04)",
                color: d?.profile?.autoEntry ? C.amber : C.mut2,
                border: `1px solid ${d?.profile?.autoEntry ? "rgba(233,185,73,0.28)" : C.line}`,
              }}>
              AUTOMATION · {d?.profile?.autoEntry ? "AUTHORISED" : d?.profile?.autoManagement ? "MANAGEMENT ONLY" : "APPROVAL REQUIRED"}
            </span>
          )}

          {!d?.replay && (
            <>
              <span id="cc-broker"><BrokerBar /></span>
              <button
                onClick={() => setCallOpen(true)}
                className="rounded-full px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] transition"
                style={{ background: "rgba(240,196,117,0.12)", color: C.gold, border: "1px solid rgba(240,196,117,0.32)" }}
              >
                Manual
              </button>
            </>
          )}
        </div>
      </header>

      {d?.replay && (
        <div className="mb-3 rounded-xl border px-3.5 py-2.5 text-[12px] font-semibold"
          style={{ borderColor: "rgba(240,196,117,0.32)", background: "rgba(240,196,117,0.08)", color: C.gold }}>
          REPLAY — recorded XAUUSD stepped through the live engine. This is not the market.
        </div>
      )}

      {!d?.replay && (d?.reason || (d?.blockers?.length ?? 0) > 0) && (
        <div className="mb-3 rounded-xl border px-3.5 py-2.5 text-[12px]"
          style={{ borderColor: "rgba(233,185,73,0.24)", background: "rgba(233,185,73,0.06)", color: C.mut }}>
          {d?.blockers?.[0]?.detail ?? d?.reason}
        </div>
      )}

      {/* ── main ───────────────────────────────────────────────────────────── */}
      <div className="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)_370px]">

        {/* ATLAS presence */}
        <div className="order-1 space-y-3">
          <Panel className="relative">
            <div className="flex flex-col items-center px-4 pb-4 pt-5">
              <BrainCore
                intensity={brain?.intensity ?? 0}
                lean={lean}
                load={d?.events?.length ?? 0}
                alive={alive}
                size={190}
              />
              <p className="mt-3 text-[11px] font-black uppercase tracking-[0.22em]" style={{ color: alive ? C.gold : C.mut2 }}>
                {PRESENCE_WORD[brain?.presence ?? "observing"] ?? "OBSERVING"}
              </p>
              <p className="mt-2 text-center text-[12.5px] leading-relaxed" style={{ color: C.mut }}>
                {brain?.headline ?? d?.summary ?? "Waiting for the first market read."}
              </p>
            </div>

            <div className="border-t px-4 py-3" style={{ borderColor: C.line }}>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: C.mut2 }}>The question</p>
              <p className="mt-1.5 text-[13px] leading-snug" style={{ color: C.text }}>{brain?.question ?? "—"}</p>
            </div>

            {!!brain?.focus?.length && (
              <div className="border-t px-4 py-3" style={{ borderColor: C.line }}>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: C.mut2 }}>What I&rsquo;m watching</p>
                <ol className="space-y-1">
                  {brain.focus.map((f, i) => (
                    <li key={i} className="flex gap-2 text-[12px]" style={{ color: C.mut }}>
                      <span className="tabular-nums" style={{ color: C.mut2 }}>{i + 1}.</span>{f}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {/*
              WHAT YOU ASKED ME TO WATCH.
              Deliberately separate from WHAT I'M WATCHING above it: that is ATLAS's own attention,
              this is a promise the member made it make. A promise you cannot see is one you have to
              remember, and the whole point of persisting these is that you should not have to.
            */}
            {!!d?.watches?.length && (
              <div className="border-t px-4 py-3" style={{ borderColor: C.line }}>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: C.gold }}>
                  You asked me to watch
                </p>
                <ul className="space-y-2">
                  {d.watches.map((w) => (
                    <li key={w.id}>
                      <p className="text-[12px]" style={{ color: C.mut }}>
                        {w.label ?? (w.price != null ? w.price.toFixed(2) : w.kind.replace(/_/g, " "))}
                        <span style={{ color: C.mut2 }}> · {w.kind.replace(/_/g, " ")}</span>
                      </p>
                      <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
                        <div className="h-full rounded-full"
                          style={{ width: `${Math.round((w.progress ?? 0) * 100)}%`, background: C.gold, transition: "width .8s cubic-bezier(.22,.9,.24,1)" }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>

          <Panel title="Today's ATLAS" icon={<BookOpen className="h-3.5 w-3.5" />}>
            <div className="max-h-[260px] overflow-y-auto px-3.5 py-2.5">
              {d?.journal?.length ? d.journal.slice().reverse().map((j) => (
                <div key={j.id} className="flex gap-2.5 py-1.5">
                  <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: C.mut2 }}>{hhmm(j.at)}</span>
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-semibold">{j.label} <span className="font-normal" style={{ color: C.mut2 }}>· {j.confidence}</span></p>
                    {j.reasonEnded && <p className="text-[11.5px]" style={{ color: C.mut2 }}>ended — {j.reasonEnded}</p>}
                  </div>
                </div>
              )) : <p className="py-2 text-[12px]" style={{ color: C.mut2 }}>No reads recorded today yet.</p>}
            </div>
          </Panel>

          {/* market weather + velocity */}
          <Panel title="Market weather" icon={<Waves className="h-3.5 w-3.5" />}>
            <div className="grid grid-cols-2 gap-px" style={{ background: C.line }}>
              <div className="px-3.5 py-3" style={{ background: C.panel }}>
                <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>Weather</p>
                <p className="mt-1 text-[14px] font-bold capitalize">{words(d?.weather)}</p>
              </div>
              <div className="px-3.5 py-3" style={{ background: C.panel }}>
                <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>Velocity</p>
                <p className="mt-1 text-[14px] font-bold capitalize" style={{ color: d?.velocity === "extreme" || d?.velocity === "accelerating" ? C.gold : C.text }}>
                  {words(d?.velocity)}
                </p>
              </div>
            </div>
          </Panel>
        </div>

        {/* centre: ATLAS's trade, then the price map, then the stream */}
        <div className="order-2 space-y-3 lg:order-2">
          {/*
            The trade ATLAS wants sits ABOVE the chart, because it is the answer and the chart is the
            working. While there is an open position this collapses out of the way — TradePanel below is
            the trade then, and two cards competing to be the trade would be worse than either.
          */}
          {/*
            Shown in the replay too, because what ATLAS would have called at a given moment of a real
            recorded session is the single most useful thing the harness can show. It cannot be acted on
            there: the replay never loads the desk, so there is no account and no idempotency key, and the
            button is disabled by its own preconditions rather than by a flag somebody could forget.
          */}
          {!trade?.active && (
            <div id="cc-trade-card">
            <BrainTradeCard
              setup={d?.setup ?? null}
              profile={desk.profile ?? d?.profile ?? null}
              account={desk.account}
              idempotencyKey={desk.idempotencyKey}
              marketOpen={d?.marketOpen ?? true}
              onChanged={() => setReloadAt(Date.now())}
              onOpenManual={() => setCallOpen(true)}
              onOpenProfile={() => setProfileOpen(true)}
            />
            </div>
          )}

          {d?.experience?.completed && !trade?.active && <TradeCompleteCard c={d.experience.completed} />}

          <Panel title="XAUUSD price map" icon={<Target className="h-3.5 w-3.5" />}
            right={<span className="text-[10px]" style={{ color: C.mut2 }}>{d?.bars?.length ? `${d.bars.length} five-minute candles` : ""}</span>}>
            <div className="h-[340px] sm:h-[420px]">
              <PriceMap
                bars={d?.bars ?? []}
                levels={d?.levels ?? []}
                price={d?.price ?? null}
                focusPrice={focusPrice}
                invalidation={d?.thesis?.invalidationPrice ?? null}
                lean={lean}
                live={!!d?.live}
                trade={trade?.active && trade.entry != null && trade.side
                  ? {
                      side: trade.side, entry: trade.entry, stop: trade.stop, takeProfit: trade.takeProfit,
                      initStop: trade.initStop,
                      partials: (trade.partials ?? []).map((p) => p.price).filter((x): x is number => typeof x === "number"),
                      invalidation: trade.thesis?.invalidationPrice ?? null,
                    }
                  // No position: the chart shows the trade ATLAS is PROPOSING, so the member can see
                  // where the risk would sit before deciding, not after.
                  : d?.setup?.side && d.setup.stop != null && d.setup.entryHigh != null
                    ? {
                        side: d.setup.side, entry: d.setup.entryHigh, stop: d.setup.stop,
                        takeProfit: d.setup.initialObjective,
                        invalidation: d.setup.invalidationPrice, proposed: true,
                      }
                    : null}
              />
            </div>
          </Panel>

          {/*
            * THE INTERRUPTION.
            *
            * Mounted here rather than inside a panel because the whole point is that it reaches a
            * member who is not looking at this screen. It decides for itself whether there is
            * anything worth interrupting for, and stays invisible the rest of the time.
            */}
          <RiskConsent
            open={consentOpen}
            onClose={() => setConsentOpen(false)}
            onSigned={(c) => setConsent(c)}
          />

          {/*
            * A standing reminder while unsigned, rather than a refusal at the moment of action.
            *
            * Finding out you cannot trade at the second you wanted to is the worst possible time to
            * learn it. The routes still refuse regardless of whether this banner is on screen.
            */}
          {consent && !consent.signed && (
            <button onClick={() => setConsentOpen(true)}
              className="w-full rounded-2xl border px-4 py-3 text-left"
              style={{ borderColor: "rgba(244,115,123,0.30)", background: "rgba(244,115,123,0.06)" }}>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: C.down }}>
                {consent.stale ? "Risk disclosure updated" : "Risk disclosure not signed"}
              </p>
              <p className="mt-1 text-[12.5px]" style={{ color: C.mut }}>
                {consent.stale
                  ? "It has changed since you signed it. Read and sign the new version to keep trading."
                  : "You can read the market and talk to ATLAS, but you cannot connect a broker, take a trade or enable automation until you have read and signed it."}
              </p>
            </button>
          )}

          <TradeAlert
            setup={d?.setup ?? null}
            riskPct={d?.profile?.riskPct ?? 0.5}
            balance={desk.account?.equity ?? null}
            currency={desk.account?.currency ?? null}
            hasPosition={!!trade?.active}
            onChanged={() => setReloadAt(Date.now())}
            onDetails={() => document.getElementById("cc-trade-card")?.scrollIntoView({ behavior: "smooth", block: "center" })}
          />

          {trade?.unmanaged?.length ? <UnmanagedNotice trade={trade} onChanged={() => setReloadAt(Date.now())} /> : null}
          {trade?.active ? <TradePanel trade={trade} onChanged={() => setReloadAt(Date.now())} /> : null}

          {/* thesis */}
          <Panel title="BRAIN thesis" icon={<Activity className="h-3.5 w-3.5" />}
            right={d?.thesis ? <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>since {hhmm(d.thesis.startedAt)}</span> : null}>
            {d?.thesis ? (
              <div className="px-3.5 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="text-[17px] font-black tracking-tight">{d.thesis.label}</p>
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em]"
                    style={{ background: "rgba(255,255,255,0.05)", color: C.mut }}>
                    {d.thesis.strength} · {d.thesis.confidence}
                  </span>
                </div>
                <ul className="mt-2.5 space-y-1">
                  {[...d.thesis.reasonStarted, ...d.thesis.reasonStrengthened].slice(0, 4).map((r, i) => (
                    <li key={i} className="text-[12.5px] leading-relaxed" style={{ color: C.mut }}>— {r}</li>
                  ))}
                </ul>
                {!!d.thesis.reasonWeakened.length && (
                  <p className="mt-2 text-[12px]" style={{ color: C.amber }}>Weakening: {d.thesis.reasonWeakened[d.thesis.reasonWeakened.length - 1]}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-3 text-[11.5px]" style={{ color: C.mut2 }}>
                  {!!d.thesis.watching.length && (
                    <span>Watching {d.thesis.watching.map((w) => (
                      <button key={w} onClick={() => setFocusPrice(w)} className="underline decoration-dotted underline-offset-2 tabular-nums" style={{ color: C.gold }}>{w.toFixed(2)}</button>
                    )).reduce((a, b) => <>{a}, {b}</>)}</span>
                  )}
                  {d.thesis.invalidationPrice != null && <span style={{ color: C.down }}>Wrong at {d.thesis.invalidationPrice.toFixed(2)}</span>}
                </div>
                {trade?.active && trade.thesisState && (
                  <p className="mt-2.5 border-t pt-2.5 text-[12.5px]" style={{ borderColor: C.line, color: C.mut }}>
                    <span className="font-bold" style={{ color: C.gold }}>TRADE:</span> {trade.thesisState}
                    {trade.character ? ` — ${trade.character.headline}` : ""}
                  </p>
                )}
                {d.previousThesis?.reasonEnded && (
                  <p className="mt-3 border-t pt-2.5 text-[12px]" style={{ borderColor: C.line, color: C.mut2 }}>
                    I changed my read — before this I was on {d.previousThesis.label.toLowerCase()}, until {d.previousThesis.reasonEnded}.
                  </p>
                )}
              </div>
            ) : (
              <p className="px-3.5 py-3 text-[12.5px]" style={{ color: C.mut2 }}>No firm read yet.</p>
            )}
          </Panel>

          {/* timeframe story */}
          <Panel title="Timeframe story" icon={<Gauge className="h-3.5 w-3.5" />} className="scroll-mt-4">
            <div id="cc-timeframes" className="px-3.5 py-3">
              {TF_ORDER.filter((tf) => d?.timeframes?.[tf]).map((tf) => {
                const v = d!.timeframes[tf];
                return (
                  <div key={tf} className="flex items-center gap-3 py-1">
                    <span className="w-9 text-[11px] font-bold tabular-nums" style={{ color: C.mut2 }}>{tf}</span>
                    <span className="w-4 text-[13px]" style={{ color: toneOf(v.state) }}>
                      {/up/.test(v.state) ? "↑" : /down/.test(v.state) ? "↓" : "→"}
                    </span>
                    <span className="flex-1 truncate text-[12.5px] font-semibold capitalize" style={{ color: toneOf(v.state) }}>{words(v.state)}</span>
                    <span className="text-[11px] tabular-nums" style={{ color: C.mut2 }}>
                      {v.efficiency != null ? `eff ${Math.round(v.efficiency * 100)}%` : ""}
                    </span>
                  </div>
                );
              })}
              {!TF_ORDER.some((tf) => d?.timeframes?.[tf]) && <p className="text-[12px]" style={{ color: C.mut2 }}>No timeframe has enough closed bars yet.</p>}
              {d?.summary && (
                <p className="mt-3 border-t pt-2.5 text-[12.5px] leading-relaxed" style={{ borderColor: C.line, color: C.mut }}>{d.summary}</p>
              )}
            </div>
          </Panel>

          {/* buyers vs sellers */}
          <Panel title="Who is winning" icon={<Activity className="h-3.5 w-3.5" />}>
            <div className="px-3.5 py-3">
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>Buyers</p>
                  <p className="text-2xl font-black tabular-nums" style={{ color: C.up }}>{bull}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>Sellers</p>
                  <p className="text-2xl font-black tabular-nums" style={{ color: C.down }}>{100 - bull}</p>
                </div>
              </div>
              <div className="mt-2 flex h-2 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
                <span style={{ width: `${bull}%`, background: C.up, transition: "width .6s cubic-bezier(.22,.9,.24,1)" }} />
                <span style={{ width: `${100 - bull}%`, background: C.down, transition: "width .6s cubic-bezier(.22,.9,.24,1)" }} />
              </div>
              {p5 && Math.abs(p5.pressureTo - p5.pressureFrom) >= 3 && (
                <p className="mt-2 text-[12px]" style={{ color: C.mut }}>
                  {/* Sign matters: -32 → -18 is sellers easing, not buyers taking over. */}
                  {pressurePhrase(p5.pressureFrom, p5.pressureTo)} — {p5.pressureTo > p5.pressureFrom ? "+" : ""}
                  {Math.round(p5.pressureTo - p5.pressureFrom)} over the last five minutes.
                </p>
              )}
              <p className="mt-1.5 text-[10.5px] leading-relaxed" style={{ color: C.mut2 }}>
                Estimated from closes, wicks and momentum — not order flow.
              </p>
              <button onClick={() => setShowMath((s) => !s)} className="mt-2 text-[11px] underline decoration-dotted underline-offset-2" style={{ color: C.mut2 }}>
                {showMath ? "Hide the math" : "Show me the math"}
              </button>
              {showMath && d && (
                <div className="mt-2 grid gap-1 rounded-lg px-3 py-2 text-[11.5px] tabular-nums" style={{ background: C.raised, color: C.mut }}>
                  <span>pressure {d.pressure?.bullish ?? "—"} / {d.pressure?.bearish ?? "—"} (net {d.pressure?.net ?? "—"})</span>
                  <span>regime {words(d.regime)} · session {words(d.session)}</span>
                  <span>intensity {d.intensity} · weather {words(d.weather)} · velocity {words(d.velocity)}</span>
                  {TF_ORDER.filter((tf) => d.timeframes?.[tf]).map((tf) => (
                    <span key={tf}>{tf} rsi {d.timeframes[tf].rsi?.toFixed(0) ?? "—"} · eff {d.timeframes[tf].efficiency != null ? Math.round(d.timeframes[tf].efficiency! * 100) : "—"}% · {words(d.timeframes[tf].sequence)}</span>
                  ))}
                </div>
              )}
            </div>
          </Panel>

          {/* scenarios */}
          {d?.scenario && (
            <Panel title="Scenario map" icon={<Target className="h-3.5 w-3.5" />}>
              <div id="cc-scenario" className="grid gap-px sm:grid-cols-3" style={{ background: C.line }}>
                {([["Bull path", d.scenario.bull, C.up], ["Neutral", d.scenario.neutral, C.mut], ["Bear path", d.scenario.bear, C.down]] as const).map(([k, v, col]) => (
                  <div key={k} className="px-3.5 py-3" style={{ background: C.panel }}>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: col }}>{k}</p>
                    <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: C.mut }}>{v}</p>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>

        {/* right: conversation and the stream. On a phone this sits second — talking to ATLAS
            is the point of the product, and it should not be six screens down. */}
        <div className="order-3 space-y-3 lg:order-3">
          {/* Admin-gated server-side; this renders nothing at all for anybody else. */}
          {!d?.replay && <VoiceSession onUiAction={onUiAction} />}
          <Panel title="Talk to ATLAS" icon={<Radio className="h-3.5 w-3.5" />} className="flex h-[520px] flex-col">
            <BrainConsole announce={announce} onUiAction={onUiAction} mode={mode} onModeChange={setMode} live={!!d?.live} className="min-h-0 flex-1" />
          </Panel>

          <Panel title="Intelligence stream" icon={<AlertTriangle className="h-3.5 w-3.5" />}
            right={<span className="text-[10px] tabular-nums" style={{ color: C.mut2 }}>{flash > 0 ? `${d?.events?.length ?? 0} events` : ""}</span>}>
            <div className="max-h-[340px] overflow-y-auto px-3.5 py-2.5">
              {streamRows.length ? streamRows.map((e) => (
                <div key={e.key} className="flex gap-2.5 border-l py-1.5 pl-2.5" style={{ borderColor: e.trade ? C.gold : leanTone(e.lean) }}>
                  <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: C.mut2 }}>{clock(e.at)}</span>
                  <span className="text-[12px] leading-snug" style={{ color: e.channel === "urgent" ? C.amber : e.trade ? C.text : C.mut }}>{e.detail}</span>
                </div>
              )) : (
                <p className="py-2 text-[12px]" style={{ color: C.mut2 }}>
                  Nothing worth reporting yet. ATLAS stays quiet when nothing has changed — that is deliberate.
                </p>
              )}
            </div>
          </Panel>

        </div>
      </div>

      {!d?.replay && (
        <>
        <ProfileSheet
          open={profileOpen}
          profile={desk.profile ?? d?.profile ?? null}
          onClose={() => setProfileOpen(false)}
          onSaved={(p) => { setDesk((x) => ({ ...x, profile: p })); setReloadAt(Date.now()); }}
        />

        <CallTradeSheet
          price={d?.price ?? null}
          levels={(d?.levels ?? []).map((l) => ({ price: l.price, label: l.label }))}
          open={callOpen}
          onClose={() => setCallOpen(false)}
          onDone={() => setReloadAt(Date.now())}
        />
        </>
      )}

      <p className="mt-3 px-1 text-[10.5px] leading-relaxed" style={{ color: C.mut2 }}>
        ATLAS interprets the market. It can place and manage trades only on an account you have connected,
        only within the permissions you set on it, and never on a live account until you have authorised live
        trading there. Automatic trading is off unless you switch it on. Market pressure is estimated from
        closes, wicks and momentum, not order flow.
      </p>
    </div>
  );
}

export default CommandCenterLive;
