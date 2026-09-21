"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity, AlertTriangle, BarChart3, Bell, BookOpen, Brain, Globe2, Layers, LineChart, Maximize2, Mic,
  MoveHorizontal, PenLine, Radar, Settings, Sparkles, Target, TrendingDown, TrendingUp, X, Zap,
} from "lucide-react";
import { H, fmt2, toneColor, LABEL } from "./theme";
import { HudPanel, LiveDot, LivePill, Chip, HUD_CSS } from "./Hud";
import { BrainOrb, type OrbState } from "./BrainOrb";
import { Gauge } from "./Gauge";
import { GoldChart, type ChartBar, type ChartLine, type ChartMarker, type ChartZone } from "./GoldChart";
import { LiquidityRadar, RADAR_KIND_COLOR, RADAR_KIND_WORD, type RadarBlip } from "./LiquidityRadar";
import { StructureViz, pivotsOf } from "./StructureViz";
import type { Live } from "../CommandCenterLive";
import BrainConsole, { VOICE_MODES, type VoiceMode } from "../BrainConsole";
import BrokerBar from "../BrokerBar";
import TradePanel, { CallTradeSheet, UnmanagedNotice } from "../TradePanel";
import { BrainTradeCard, ProfileSheet, TradeCompleteCard, type ProfileView } from "../BrainTrade";
import VoiceSession from "../VoiceSession";
import TradeAlert from "../TradeAlert";
import RiskConsent, { type ConsentView } from "../RiskConsent";

/**
 * COMMAND CENTER XAUUSD — THE INTELLIGENCE HUD.
 *
 * LAYER 2 ONLY. This screen visualises and explains what ATLAS has already measured; it computes no
 * market opinion that could reach a trade. Every number here arrives from /api/command-center/live (the
 * engine's snapshot, thesis and events, plus the read-only `intel` block from command-center/present),
 * from /bars (the candles the worker already fetched) or from /context (informational macro quotes).
 * Where the engine has no measurement — probabilities, order-flow volume — the screen says so rather
 * than inventing one.
 */

const TF_BTNS: { id: string; label: string; feed: boolean }[] = [
  { id: "1m", label: "1m", feed: false }, { id: "5m", label: "5m", feed: true }, { id: "15m", label: "15m", feed: true },
  { id: "1h", label: "1h", feed: true }, { id: "4h", label: "4h", feed: true }, { id: "1d", label: "D", feed: true },
];
const TF_MIN: Record<string, number> = { "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };
const NAV = ["OVERVIEW", "ANALYSIS", "SCANNERS", "STRATEGY", "BACKTEST", "ALERTS", "JOURNAL"] as const;
type Nav = typeof NAV[number];
type StreamFilter = "ALL" | "PRICE" | "STRUCTURE" | "NEWS";
type TalkTab = "CHAT" | "VOICE" | "ANALYSIS" | "SETTINGS";

const words = (s?: string | null) => (s ? s.replace(/_/g, " ") : "—");
const cap = (s: string) => s.replace(/(^|[\s(])(\w)/g, (_, a, b) => a + b.toUpperCase());
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function aggregate(bars: ChartBar[], minutes: number): ChartBar[] {
  const ms = minutes * 60_000, out: ChartBar[] = [];
  for (const b of bars) {
    const k = Math.floor(b.t / ms) * ms, last = out[out.length - 1];
    if (last && last.t === k) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v = (last.v ?? 0) + (b.v ?? 0); }
    else out.push({ t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

function eventKind(code: string): "price" | "structure" | "news" | "trade" {
  if (/NEWS|SESSION|MARKET_(CLOSED|OPENED)|FEED/.test(code)) return "news";
  if (/TRADE_|POSITION|PARTIAL|BREAK_EVEN|STOP_/.test(code)) return "trade";
  if (/STRUCTURE|LEVEL|BREAKOUT|RETEST|LIQUIDITY|REGIME|TIMEFRAME/.test(code)) return "structure";
  return "price";
}

/** Price of an event's level, wherever the engine put it. */
function evPrice(e: Record<string, unknown>): number | null {
  const lv = e.level as { price?: number } | null | undefined;
  const d = (e.data ?? {}) as Record<string, unknown>;
  const p = Number(lv?.price ?? d.level ?? d.price ?? NaN);
  return Number.isFinite(p) ? p : null;
}

/**
 * The sizes that make the desktop layout match the reference at 1672 × 941.
 *
 * The desk is a cockpit: it fills the window and does not scroll while it fits. On a shorter window it
 * would rather scroll than silently cut the bottom row off, so the grid keeps a floor height and the
 * root scrolls past it — nothing on this screen is allowed to be invisible.
 */
const DESK = `
.hud-grid { display:grid; gap:8px; min-width:0; }
.hud-col > *, .hud-under > *, .hud-grid > * { min-width:0; }
@media (min-width:1280px) {
  .hud-root { height:100dvh; overflow-x:hidden; overflow-y:auto; display:flex; flex-direction:column; }
  .hud-grid { grid-template-columns: minmax(296px,21.4%) minmax(0,1fr) minmax(300px,21.2%); flex:1 1 auto; min-height:664px; }
  .hud-col { min-height:0; display:grid; gap:8px; }
  .hud-left { grid-template-rows: 1.34fr 1fr 0.84fr 1.16fr; }
  .hud-center { grid-template-rows: minmax(300px,1fr) 136px 172px; }
  .hud-right { grid-template-rows: minmax(0,1fr) 236px; }
  .hud-under { display:grid; grid-template-columns: minmax(0,1fr) 262px; gap:8px; min-height:0; }
}
@media (max-width:1279px) { .hud-col { display:flex; flex-direction:column; gap:8px; } .hud-under { display:flex; flex-direction:column; gap:8px; } .hud-center > * { min-height: 260px; } }
`;

export function CommandCenterHud({ endpoint = "/api/command-center/live" }: { endpoint?: string } = {}) {
  const isReplay = endpoint.includes("replay");
  const [d, setD] = useState<Live | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reloadAt, setReloadAt] = useState(0);
  const [mode, setMode] = useState<VoiceMode>("push_to_talk");
  const [tf, setTf] = useState("15m");
  const [tfBars, setTfBars] = useState<ChartBar[]>([]);
  const [overlays, setOverlays] = useState(true);
  const [liquidity, setLiquidity] = useState(true);
  const [indicators, setIndicators] = useState(true);
  const [liveAnalysis, setLiveAnalysis] = useState(true);
  const [talkTab, setTalkTab] = useState<TalkTab>(endpoint.includes("replay") ? "CHAT" : "VOICE");
  const [streamFilter, setStreamFilter] = useState<StreamFilter>("ALL");
  const [nav, setNav] = useState<Nav>("OVERVIEW");
  const [drawer, setDrawer] = useState<null | "trade" | "analysis" | "alerts" | "journal">(null);
  const [callOpen, setCallOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [consent, setConsent] = useState<ConsentView | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [askSignal, setAskSignal] = useState<{ n: number; q: string } | null>(null);
  const [activity, setActivity] = useState({ busy: false, speaking: false, listening: false });
  type CtxRow = {
  key: string; label: string; instrument: string; source: string; note: string;
  value: number | null; change: number | null; changePct: number | null;
  period: string; asOf: string | null; status: "live" | "delayed" | "stale" | "not_connected";
};
  const [ctx, setCtx] = useState<{ rows: CtxRow[]; history: { t: number; v: number }[]; at: number | null } | null>(null);
  const [radarHover, setRadarHover] = useState<RadarBlip | null>(null);
  /** A level the member tapped: the chart marks it until they tap it again or a minute passes. */
  const [pinned, setPinned] = useState<{ price: number; label: string } | null>(null);
  useEffect(() => { if (!pinned) return; const t = setTimeout(() => setPinned(null), 60_000); return () => clearTimeout(t); }, [pinned]);
  const [now, setNow] = useState(0);   // 0 until mounted, so server and client render the same text
  const [flash, setFlash] = useState<"up" | "dn" | null>(null);
  const [desk, setDesk] = useState<{
    account: { equity: number | null; currency: string | null; isLive: boolean; liveAuthorized: boolean } | null;
    idempotencyKey: string | null; profile: ProfileView | null;
  }>({ account: null, idempotencyKey: null, profile: null });
  const chartRef = useRef<HTMLDivElement | null>(null);
  const lastPrice = useRef<number | null>(null);

  /* ── data ─────────────────────────────────────────────────────────────── */
  useEffect(() => { setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  useEffect(() => {
    if (isReplay) return;
    let alive = true;
    fetch("/api/command-center/consent", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (alive) setConsent(j.consent ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [isReplay]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(endpoint, { cache: "no-store" });
        if (!alive) return;
        if (!r.ok) { setErr(r.status === 401 ? "Sign in to open the Command Center." : "The Command Center is not answering."); return; }
        const j = (await r.json()) as Live;
        setErr(null); setD(j);
      } catch { /* keep the last read */ }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [endpoint, reloadAt]);

  useEffect(() => {
    if (isReplay) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/command-center/trade", { cache: "no-store" });
        if (!alive || !r.ok) return;
        const j = await r.json();
        setDesk({ account: j.account ?? null, idempotencyKey: j.idempotencyKey ?? null, profile: j.profile ?? null });
      } catch { /* the card falls back */ }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [isReplay, reloadAt]);

  // Informational macro quotes — never an input to anything.
  useEffect(() => {
    if (isReplay) return;
    let alive = true;
    const load = () => fetch("/api/command-center/context", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (alive) setCtx({ rows: j.rows ?? [], history: j.history ?? [], at: j.at ?? null }); }).catch(() => {});
    load(); const id = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [isReplay]);

  // Chart candles: 5m from the live read, others from the worker's own bars (or aggregated in the replay).
  useEffect(() => {
    if (tf === "5m" || isReplay) return;
    let alive = true;
    const load = () => fetch(`/api/command-center/bars?tf=${tf}`, { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (alive && Array.isArray(j.bars)) setTfBars(j.bars as ChartBar[]); }).catch(() => {});
    load(); const id = setInterval(load, liveAnalysis ? 60_000 : 300_000);
    return () => { alive = false; clearInterval(id); };
  }, [tf, isReplay, liveAnalysis]);

  const chartBars: ChartBar[] = useMemo(() => {
    const m5 = (d?.bars ?? []) as ChartBar[];
    const raw = tf === "5m" ? m5.slice(-160)
      : isReplay || !tfBars.length ? aggregate(m5, TF_MIN[tf] ?? 15).slice(-160)
      : tfBars.slice(-170);
    /*
     * A weekend is not chart data. On the higher timeframes the series runs back through Friday's close,
     * and a flat two-day line squashes the part a trader is actually looking at. If there is a gap of
     * more than three hours in the first two-thirds of the series, the chart starts after it — as long
     * as enough candles remain to be worth drawing.
     */
    const step = (TF_MIN[tf] ?? 15) * 60_000;
    for (let i = raw.length - 1; i > 0; i--) {
      if (raw[i].t - raw[i - 1].t > Math.max(3 * 3600_000, step * 4) && raw.length - i >= 24 && i > raw.length * 0.25) {
        return raw.slice(i);
      }
    }
    return raw;
  }, [d?.bars, tf, tfBars, isReplay]);

  useEffect(() => {
    const p = d?.price ?? null;
    if (p != null && lastPrice.current != null && p !== lastPrice.current) {
      setFlash(p > lastPrice.current ? "up" : "dn");
      const id = setTimeout(() => setFlash(null), 900);
      lastPrice.current = p;
      return () => clearTimeout(id);
    }
    lastPrice.current = p;
  }, [d?.price]);

  const onUiAction = useCallback((name: string, arg: string | number | null) => {
    if (name === "SHOW_SCENARIO" || name === "SHOW_METRICS") setDrawer("analysis");
    if (name === "OPEN_SETTINGS") setProfileOpen(true);
    if (name === "OPEN_BROKER") window.dispatchEvent(new CustomEvent("cc:open-broker"));
    if (name === "SHOW_LEVEL" && typeof arg === "number") setLiquidity(true);
  }, []);
  const ask = useCallback((q: string) => { setTalkTab("CHAT"); setAskSignal({ n: Date.now(), q }); }, []);
  const onActivity = useCallback((a: { busy: boolean; speaking: boolean; listening: boolean }) => setActivity(a), []);

  const announce = useMemo(() => {
    const st = d?.statements?.[0];
    const loud = d?.events?.find((e) => e.channel === "urgent" || e.channel === "voice");
    if (st && (!loud || st.at >= loud.at)) return { key: `s${st.at}`, text: st.text, urgent: st.channel === "urgent" };
    if (loud) return { key: loud.key, text: loud.detail, urgent: loud.channel === "urgent" };
    return null;
  }, [d]);

  if (err) {
    return (
      <div className="grid min-h-screen place-items-center px-6 text-center" style={{ background: H.bg0, color: H.text }}>
        <div>
          <p className="text-[14px] font-bold tracking-[0.12em]">COMMAND CENTER <span style={{ color: H.gold2 }}>XAUUSD</span></p>
          <p className="mt-2 text-[13px]" style={{ color: H.mut }}>{err}</p>
        </div>
      </div>
    );
  }

  /* ── derived view state (display only) ─────────────────────────────────── */
  const intel = d?.intel ?? null;
  const thesis = d?.thesis ?? null;
  const trade = d?.trade;
  const setup = d?.setup ?? null;
  const profile = desk.profile ?? d?.profile ?? null;
  const alive = !!d?.connected && !!d?.marketOpen;
  const bias = thesis?.label?.toLowerCase().includes("bear") ? "bear" : thesis?.label?.toLowerCase().includes("bull") ? "bull" : "neutral";
  const biasColor = bias === "bear" ? H.red : bias === "bull" ? H.green : H.cyan2;
  const hardBlock = (d?.blockers ?? []).some((b) => b.code !== "market_closed");
  const orbState: OrbState = !alive ? "idle"
    : activity.speaking ? "speaking"
    : activity.busy ? "analyzing"
    : trade?.active ? "in_trade"
    : hardBlock || d?.brain?.presence === "high_news_risk" || d?.brain?.presence === "protecting_trade" ? "risk_event"
    : setup?.state === "armed" || setup?.state === "ready" ? "trade_ready"
    : setup?.state === "developing" ? "opportunity"
    : "watching";
  const nyTime = now ? new Date(now).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }) : "--:--:--";
  const nyDate = now ? new Date(now).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "";

  const streamRows = (() => {
    const market = (d?.events ?? []).map((e) => ({ key: e.key, at: e.at, detail: e.detail, kind: eventKind(e.code), lean: e.lean as string, urgent: e.channel === "urgent" }));
    const pos = (trade?.events ?? []).map((e, i) => ({ key: `t${e.at}-${i}`, at: e.at, detail: e.detail, kind: "trade" as const, lean: "trade", urgent: e.channel === "urgent" }));
    const rows = [...market, ...pos].sort((a, b) => b.at - a.at);
    return rows.filter((r) => streamFilter === "ALL" || (streamFilter === "PRICE" && (r.kind === "price" || r.kind === "trade")) || (streamFilter === "STRUCTURE" && r.kind === "structure") || (streamFilter === "NEWS" && r.kind === "news")).slice(0, 40);
  })();

  const markers: ChartMarker[] = (d?.events ?? []).flatMap((e) => {
    const raw = e as unknown as Record<string, unknown>;
    const map: Record<string, string> = { STRUCTURE_BREAK: "BOS", STRUCTURE_RECLAIM: "Reclaim", LIQUIDITY_SWEEP: "Liquidity sweep", FAILED_BREAKOUT: "Failed break", BREAKOUT_CONFIRMED: "Breakout", RETEST_HOLDING: "Retest holding", RETEST_FAILING: "Retest failing" };
    const label = map[e.code]; if (!label) return [];
    return [{ at: e.at, price: evPrice(raw), label, tone: e.lean === "bearish" ? "down" : e.lean === "bullish" ? "up" : "gold" } as ChartMarker];
  })
    // One of each kind, newest first: three "Failed break" labels stacked on the same candles is noise.
    .filter((m, i, all) => all.findIndex((x) => x.label === m.label) === i)
    .slice(0, 5);

  const zones: ChartZone[] = [];
  if (intel?.liquidity.aboveZone) zones.push({ from: intel.liquidity.aboveZone[0], to: intel.liquidity.aboveZone[1], tone: "supply", label: `Resistance ${fmt2(intel.liquidity.aboveZone[0])} – ${fmt2(intel.liquidity.aboveZone[1])}` });
  if (intel?.liquidity.belowZone) zones.push({ from: intel.liquidity.belowZone[0], to: intel.liquidity.belowZone[1], tone: "demand", label: `Support ${fmt2(intel.liquidity.belowZone[0])} – ${fmt2(intel.liquidity.belowZone[1])}` });
  const pathPts = intel?.path?.points ?? null;
  if (pathPts && pathPts.length > 1) {
    const end = pathPts[pathPts.length - 1];
    zones.push({ from: end - 0.6, to: end + 0.6, tone: "target", label: `Scenario level ${fmt2(end)}` });
  }

  const lines: ChartLine[] = [];
  if (indicators) {
    for (const w of thesis?.watching ?? []) lines.push({ price: w, label: "Atlas watch", color: H.gold2 });
    if (thesis?.invalidationPrice != null) lines.push({ price: thesis.invalidationPrice, label: "Read fails here", color: H.red });
  }
  if (pinned) lines.push({ price: pinned.price, label: `◆ ${pinned.label}`, color: H.cyan2, dashed: false });
  if (trade?.active && trade.entry != null) {
    lines.push({ price: trade.entry, label: `Entry ${trade.side?.toUpperCase()}`, color: H.blue, dashed: false });
    if (trade.stop != null) lines.push({ price: trade.stop, label: "Stop", color: H.red, dashed: false });
    if (trade.takeProfit != null) lines.push({ price: trade.takeProfit, label: "Target", color: H.green, dashed: false });
  } else if (setup?.side && setup.stop != null && setup.entryHigh != null) {
    lines.push({ price: setup.entryHigh, label: `Proposed ${setup.side.toUpperCase()}`, color: H.blue, tag: false });
    lines.push({ price: setup.stop, label: "Proposed stop", color: H.red, tag: false });
  }

  // Every blip is computed server-side in the read-only present layer, so the meaning shown on hover is
  // the same sentence everywhere and nothing is invented in the browser.
  const blips: RadarBlip[] = (intel?.radar ?? []).map((b) => ({
    price: b.price, kind: b.kind, label: b.label, meaning: b.meaning, swept: b.swept, side: b.side, distance: b.distance,
  }));


  const pivots = pivotsOf(chartBars, 3, 5);
  const ch = intel?.pressure.change ?? null;
  const tfWord = TF_BTNS.find((b) => b.id === tf)?.label ?? tf;
  const change = intel?.day.change ?? null;
  const spark = (d?.bars ?? []).slice(-60).map((b) => (b as ChartBar).c);

  const setupPill = trade?.active
    ? { text: `IN TRADE · ${trade.side?.toUpperCase()} ${trade.qty ?? ""} · ${trade.metrics ? `${trade.metrics.pips >= 0 ? "+" : ""}${Math.round(trade.metrics.pips)} pips` : ""}`, color: H.green }
    : setup?.side && setup.state !== "none" && setup.state !== "blocked"
      ? { text: `${setup.side.toUpperCase()} ${setup.style === "quick" ? "SCALP" : setup.style === "swing" ? "SWING" : "NORMAL"} · ${words(setup.state).toUpperCase()}`, color: H.gold2 }
      : null;

  /* ── render ───────────────────────────────────────────────────────────── */
  return (
    <div className="hud-root w-full px-[10px] pb-[10px] pt-[8px]" style={{ background: `radial-gradient(1200px 500px at 12% -10%, rgba(0,199,232,0.06), transparent), radial-gradient(900px 500px at 100% 0%, rgba(213,169,61,0.05), transparent), ${H.bg0}`, color: H.text, fontFamily: "Inter, var(--font-inter), system-ui, sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: HUD_CSS + DESK }} />

      {/* ── GLOBAL HEADER ─────────────────────────────────────────────── */}
      <header className="mb-[8px] flex h-[42px] shrink-0 items-center gap-4">
        <a href="/portal" className="flex shrink-0 items-center gap-3" aria-label="Back to the portal">
          <span className="grid h-9 w-9 place-items-center rounded-full" style={{ border: `1px solid ${H.lineHi}`, boxShadow: "0 0 12px rgba(0,199,232,0.25), inset 0 0 10px rgba(213,169,61,0.25)" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path d="M12 3 L21 20 H3 Z" fill="none" stroke={H.gold3} strokeWidth="1.6" /><circle cx="12" cy="14" r="2.2" fill={H.cyan2} /></svg>
          </span>
          <span className="hidden sm:block">
            <span className="block text-[15px] font-semibold leading-none tracking-[0.06em]" style={{ color: H.text }}>COMMAND CENTER XAUUSD</span>
            <span className="mt-1 block text-[8.5px] font-medium tracking-[0.3em]" style={{ color: H.mut }}>THE ULTIMATE GOLD INTELLIGENCE MACHINE</span>
          </span>
        </a>

        <nav className="hud-scroll mx-auto hidden h-full min-w-0 items-center gap-0.5 overflow-x-auto rounded-[10px] px-1.5 lg:flex" style={{ border: `1px solid ${H.line}`, background: "rgba(7,16,26,0.7)" }}>
          {NAV.map((n) => (
            <button key={n}
              onClick={() => {
                setNav(n);
                if (n === "ANALYSIS") setDrawer("analysis");
                else if (n === "SCANNERS") setDrawer("trade");
                else if (n === "STRATEGY") setProfileOpen(true);
                else if (n === "BACKTEST") window.location.href = "/command-center/replay";
                else if (n === "ALERTS") setDrawer("alerts");
                else if (n === "JOURNAL") setDrawer("journal");
                else setDrawer(null);
              }}
              className="relative h-[30px] shrink-0 rounded-[7px] px-3 text-[9.5px] font-semibold tracking-[0.14em] transition"
              style={{
                color: nav === n ? H.gold3 : H.mut,
                background: nav === n ? "linear-gradient(180deg, rgba(213,169,61,0.16), rgba(213,169,61,0.04))" : "transparent",
                border: nav === n ? "1px solid rgba(231,196,103,0.5)" : "1px solid transparent",
                boxShadow: nav === n ? "0 0 14px rgba(213,169,61,0.25)" : "none",
              }}>
              {n}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-4">
          {!isReplay && <span className="hidden min-[1800px]:block"><BrokerBar /></span>}
          {!isReplay && (
            <button onClick={() => setCallOpen(true)} className="hidden rounded-[7px] px-3 py-1.5 text-[9.5px] font-bold tracking-[0.14em] md:block"
              style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.4)", background: "rgba(213,169,61,0.08)" }}>MANUAL</button>
          )}
          <span className="inline-flex items-center gap-2 rounded-[8px] px-3 py-1.5 text-[11px] font-bold tracking-[0.14em]"
            style={{ color: d?.live ? H.green : H.gold2, border: `1px solid ${d?.live ? "rgba(41,223,166,0.4)" : "rgba(231,196,103,0.4)"}`, background: d?.live ? "rgba(41,223,166,0.07)" : "rgba(213,169,61,0.07)" }}>
            <LiveDot color={d?.live ? H.green : H.gold2} />{isReplay ? "REPLAY" : d?.live ? "LIVE" : d?.marketOpen === false ? "CLOSED" : "NO FEED"}
          </span>
          <span className="hidden text-right md:block">
            <span className="block text-[10.5px] tracking-[0.14em]" style={{ color: H.mut }}>NEW YORK <b className="ml-1 text-[14px] font-semibold tabular-nums tracking-normal" style={{ color: H.text }}>{nyTime}</b></span>
            <span className="block text-[9.5px]" style={{ color: H.mut2 }}>{nyDate}</span>
          </span>
          <Globe2 className="hidden h-5 w-5 md:block" style={{ color: H.mut }} />
          <span className="hidden text-[9.5px] font-semibold leading-tight tracking-[0.2em] 2xl:block" style={{ color: H.mut }}>DISCIPLINE<br />CREATES FREEDOM.</span>
        </div>
      </header>

      {/* ── MARKET STATUS BAR ─────────────────────────────────────────── */}
      <div className="mb-[8px] grid shrink-0 gap-[8px] xl:h-[74px] xl:grid-cols-[minmax(0,1fr)_430px_310px]">
        <HudPanel bodyClass="flex items-center gap-x-4 overflow-hidden px-3.5 py-2" hi>
          <div className="flex items-center gap-3">
            <GoldBars />
            <div>
              <p className="text-[17px] font-semibold leading-none tracking-[0.06em]">XAUUSD</p>
              <p className="mt-1 text-[10.5px]" style={{ color: H.mut }}>Gold Spot / U.S. Dollar</p>
            </div>
          </div>
          <div>
            <p className={`text-[30px] font-semibold leading-none tabular-nums ${flash === "up" ? "hud-flash-up" : flash === "dn" ? "hud-flash-dn" : ""}`} style={{ letterSpacing: "0.01em" }}>
              {d?.price != null ? d.price.toLocaleString("en-US", { minimumFractionDigits: 2 }) : "—"}
            </p>
            <p className="mt-1 text-[12px] font-semibold tabular-nums" style={{ color: change == null ? H.mut : change >= 0 ? H.green : H.red }}>
              {change == null ? "vs daily open —" : `${change >= 0 ? "▲ +" : "▼ "}${change.toFixed(2)} (${change >= 0 ? "+" : ""}${intel?.day.changePct?.toFixed(2)}%)`}
            </p>
          </div>
          <Sparkline values={spark} color={change != null && change < 0 ? H.red : H.green} w={96} h={30} />
          <div className="hidden grid-cols-4 gap-x-4 lg:grid">
            {([["DAY HIGH", intel?.day.high], ["DAY LOW", intel?.day.low], ["DAILY RANGE", intel?.day.range], ["SPREAD", d?.spread]] as const).map(([k, v]) => (
              <div key={k} className="min-w-[58px]">
                <p className={LABEL} style={{ color: H.mut }}>{k}</p>
                <p className="mt-1 text-[13.5px] font-semibold tabular-nums">{v == null ? "—" : fmt2(v)}</p>
              </div>
            ))}
          </div>
        </HudPanel>

        <HudPanel bodyClass="grid grid-cols-[1.25fr_1fr_1.15fr] items-center gap-3 px-4 py-2" style={{ borderColor: bias === "bear" ? "rgba(255,83,100,0.45)" : bias === "bull" ? "rgba(41,223,166,0.4)" : H.line }}>
          <div>
            <p className={LABEL} style={{ color: H.mut }}>Market mode</p>
            <p className="mt-1.5 text-[14px] font-bold tracking-[0.08em]" style={{ color: toneColor(intel?.mode.tone) }}>{intel?.mode.label ?? "NO READ"}</p>
          </div>
          <div>
            <p className={LABEL} style={{ color: H.mut }}>Session</p>
            <p className="mt-1 text-[13px] font-semibold uppercase tracking-[0.06em]">{words(d?.session)}</p>
            <p className="mt-0.5 inline-flex items-center gap-1.5 text-[10px]" style={{ color: d?.marketOpen ? H.green : H.mut }}><LiveDot color={d?.marketOpen ? H.green : H.mut2} size={5} />{d?.marketOpen ? "Active" : "Closed"}</p>
          </div>
          <div>
            <p className={LABEL} style={{ color: H.mut }} title="ATLAS's own confidence in its current thesis">Atlas confidence</p>
            <div className="mt-1 flex items-center gap-2.5">
              <p className="text-[20px] font-semibold tabular-nums" style={{ color: H.cyan2 }}>{thesis ? `${thesis.confidence}%` : "—"}</p>
              <span className="h-[5px] flex-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.07)" }}>
                <span className="block h-full rounded-full" style={{ width: `${thesis?.confidence ?? 0}%`, background: `linear-gradient(90deg, ${H.blue}, ${H.cyan2})`, boxShadow: `0 0 8px ${H.cyan}`, transition: "width .8s cubic-bezier(.22,.9,.24,1)" }} />
              </span>
            </div>
          </div>
        </HudPanel>

        <HudPanel bodyClass="flex items-center justify-between gap-3 px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-full" style={{ border: `1px solid ${H.line}` }}><Zap className="h-4 w-4" style={{ color: profile?.autoEntry ? H.gold2 : H.mut }} /></span>
            <div>
              <p className={LABEL} style={{ color: H.mut }}>Automation</p>
              <p className="mt-0.5 text-[13px] font-bold tracking-[0.08em]" style={{ color: trade?.active ? H.green : profile?.autoEntry ? H.gold2 : H.text }}>
                {trade?.active ? "MANAGING" : profile?.autoEntry ? "ARMED" : profile?.autoManagement ? "MANAGE ONLY" : "STANDBY"}
              </p>
              <p className="text-[10px]" style={{ color: H.mut }}>{trade?.active ? `${trade.side?.toUpperCase()} open` : "No trades"}</p>
            </div>
          </div>
          <button onClick={() => (isReplay ? null : setProfileOpen(true))}
            className="rounded-[8px] px-4 py-2 text-center transition hover:brightness-110"
            style={{ border: "1px solid rgba(255,216,117,0.65)", background: "linear-gradient(180deg, rgba(213,169,61,0.22), rgba(213,169,61,0.06))", boxShadow: "0 0 18px rgba(213,169,61,0.28), inset 0 0 12px rgba(213,169,61,0.12)" }}>
            <span className="flex items-center gap-2 text-[12px] font-bold tracking-[0.14em]" style={{ color: H.gold3 }}><Zap className="h-4 w-4" />{profile?.autoEntry ? "AUTO SETTINGS" : "ENABLE AUTO"}</span>
            <span className="block text-[8px] tracking-[0.18em]" style={{ color: H.gold2 }}>WITH AI SUPERVISION</span>
          </button>
        </HudPanel>
      </div>

      {/* notices */}
      {(isReplay || (d?.reason || hardBlock) || (consent && !consent.signed)) && (
        <div className="mb-[8px] flex shrink-0 flex-wrap gap-2">
          {isReplay && <Notice color={H.gold2}>REPLAY — recorded XAUUSD stepped through the live engine. This is not the market.</Notice>}
          {!isReplay && (hardBlock || d?.reason) && <Notice color={H.gold2}>{d?.blockers?.[0]?.detail ?? d?.reason}</Notice>}
          {consent && !consent.signed && (
            <button onClick={() => setConsentOpen(true)}><Notice color={H.red}>{consent.stale ? "Risk disclosure updated — sign the new version to keep trading." : "Risk disclosure not signed — you can read the market and talk to ATLAS, but not trade. Tap to read and sign."}</Notice></button>
          )}
        </div>
      )}

      {/* ── MAIN GRID ─────────────────────────────────────────────────── */}
      <div className="hud-grid">
        {/* LEFT */}
        <div className="hud-col hud-left">
          <HudPanel hi bodyClass="flex h-full flex-col">
            <div className="flex min-h-0 flex-1 flex-col items-center overflow-hidden xl:flex-row">
              <div className="relative grid w-full flex-1 place-items-center">
                <BrainOrb state={orbState} intensity={d?.intensity ?? 0} alive={alive} pulseKey={thesis?.id ?? null} size={152} />
              </div>
              <ul className="hud-scroll grid max-h-full w-full grid-cols-2 gap-x-3 gap-y-[4px] overflow-y-auto px-3 pb-2 xl:block xl:w-[112px] xl:shrink-0 xl:space-y-[4px] xl:px-0 xl:pr-2.5">
                {[
                  ["ANALYZING", d?.live ? `Live · ${d.ageSeconds ?? 0}s old` : "No live read", !!d?.live],
                  ["SCANNING", `${Object.keys(d?.timeframes ?? {}).length} timeframes`, Object.keys(d?.timeframes ?? {}).length > 0],
                  ["DETECTING", `${(intel?.liquidity.above.length ?? 0) + (intel?.liquidity.below.length ?? 0)} levels · structure`, !!intel],
                  ["CALCULATING", setup?.totalCount ? `Setup ${setup.metCount}/${setup.totalCount} conditions` : "Setups & risk", alive],
                  ["MONITORING", d?.intel?.news ? `${d.intel.news.name.slice(0, 18)}` : "News calendar", alive],
                  ["LEARNING", "Grading its calls", alive],
                ].map(([k, sub, on]) => (
                  <li key={String(k)} className="flex items-start gap-2">
                    <span className="mt-[3px] grid h-[13px] w-[13px] shrink-0 place-items-center rounded-full" style={{ border: `1px solid ${on ? H.cyan2 : H.mut2}` }}>
                      <span className="h-[5px] w-[5px] rounded-full" style={{ background: on ? H.cyan2 : H.mut2, boxShadow: on ? `0 0 6px ${H.cyan2}` : "none" }} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[8.5px] font-bold tracking-[0.12em]" style={{ color: on ? H.cyan2 : H.mut2 }}>{k}</span>
                      <span className="block truncate text-[8.5px]" style={{ color: H.mut }}>{sub}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="shrink-0 pb-2 text-center">
              <p className="text-[14px] font-semibold tracking-[0.2em]">ATLAS</p>
              <p className="text-[8.5px] tracking-[0.3em]" style={{ color: H.gold2 }}>GOLD INTELLIGENCE CORE</p>
              <p className="mt-1 text-[10.5px] italic" style={{ color: H.mut }}>&ldquo;Clarity in the noise. Opportunity in the data.&rdquo;</p>
            </div>
          </HudPanel>

          <HudPanel title="MARKET PULSE" icon={<Activity className="h-3.5 w-3.5" />} right={d?.live ? <LivePill /> : <LivePill label={d?.marketOpen === false ? "CLOSED" : "STALE"} color={H.gold2} />} bodyClass="flex flex-col px-3 pb-2.5">
            <div className="flex items-center gap-2">
              <p className="text-[17px] font-semibold" style={{ color: H.text }}>{thesis?.label ?? "No firm read"}</p>
              {thesis && <span className="rounded-[4px] px-1.5 py-[2px] text-[8.5px] font-bold tracking-[0.14em]" style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.45)", background: "rgba(213,169,61,0.08)" }}>{thesis.strength.toUpperCase()}</span>}
            </div>
            <div className="mt-1 flex min-h-0 flex-1 gap-2">
              <p className="hud-scroll min-h-0 flex-1 overflow-y-auto text-[11.5px] leading-[1.55]" style={{ color: "#B9C5CF", maskImage: "linear-gradient(180deg,#000 82%,transparent)", WebkitMaskImage: "linear-gradient(180deg,#000 82%,transparent)" }}>
                {pulseText(d)}
              </p>
              <Sparkline values={spark.slice(-30)} color={biasColor} w={64} h={40} />
            </div>
            {(() => {
              const c5 = d?.changes?.find((c) => c.horizon === "5m") ?? d?.changes?.[0];
              if (!c5) return null;
              const dp = c5.pressureTo - c5.pressureFrom;
              return (
                <p className="mt-1 shrink-0 text-[10px] tabular-nums" style={{ color: H.mut }} title="What measurably changed over this window — the engine's own before-and-after">
                  <span style={{ color: H.gold2 }}>{c5.horizon}:</span>{" "}
                  price {c5.priceMove >= 0 ? "+" : ""}{c5.priceMove.toFixed(2)} · pressure {Math.round(c5.pressureFrom)} → {Math.round(c5.pressureTo)}
                  {Math.abs(dp) >= 3 ? <span style={{ color: dp > 0 ? H.green : H.red }}> ({dp > 0 ? "+" : ""}{Math.round(dp)})</span> : null}
                </p>
              );
            })()}
            <div className="mt-1.5 flex items-center justify-between">
              <button onClick={() => ask("Explain your current read in detail: what you think, why, what changed, what you're watching, what would invalidate it and what would strengthen it.")}
                className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-[3px] text-[9px] font-bold tracking-[0.12em]"
                style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.45)" }}><Zap className="h-3 w-3" />EXPLAIN FURTHER</button>
              <span className="text-[9.5px] tabular-nums" style={{ color: H.mut }}>{d?.at ? new Date(d.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}</span>
            </div>
          </HudPanel>

          <HudPanel title="TIMEFRAME ALIGNMENT" icon={<Layers className="h-3.5 w-3.5" />}
            right={<span className="text-[9.5px] font-bold tracking-[0.14em]" style={{ color: intel?.alignment.bias === "BEARISH BIAS" ? H.red : intel?.alignment.bias === "BULLISH BIAS" ? H.green : H.gold2 }}>{intel?.alignment.bias ?? "NO READ"}</span>}
            bodyClass="flex flex-col px-3 pb-2">
            <div className="grid flex-1 grid-cols-5 gap-1.5">
              {["1d", "4h", "1h", "15m", "5m"].map((k) => {
                const r = intel?.alignment.rows.find((x) => x.tf === k);
                const col = r ? (r.dir === "down" ? H.red : r.dir === "up" ? H.green : H.mut) : H.mut2;
                return (
                  <div key={k} title={r ? words(r.state) : "Not enough closed bars"} className="flex flex-col items-center justify-center rounded-[6px] py-1.5 transition" style={{ border: `1px solid ${H.line}`, background: "rgba(3,7,11,0.5)" }}>
                    <p className="text-[12px] font-semibold">{k === "1d" ? "1D" : k.toUpperCase()}</p>
                    <p className="mt-0.5 max-w-full truncate px-1 text-[10px]" style={{ color: col }}>{r?.word ?? "No read"}</p>
                    <p className="text-[13px] leading-none" style={{ color: col }}>{!r ? "·" : r.dir === "down" ? "⌄" : r.dir === "up" ? "⌃" : "—"}</p>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 rounded-[5px] py-[3px] text-center text-[8.5px] tracking-[0.16em]" style={{ color: H.mut, border: `1px solid ${H.lineSoft}` }}>
              {intel ? `${intel.alignment.agree} OF ${intel.alignment.rows.length} AGREE · DISAGREEMENT IS SHOWN, NOT HIDDEN` : "STRONGER ALIGNMENT = CLEARER READ"}
            </p>
          </HudPanel>

          <HudPanel title="KEY LEVELS" icon={<Target className="h-3.5 w-3.5" />}
            right={<button onClick={() => setDrawer("alerts")} className="inline-flex items-center gap-1 rounded-[5px] px-2 py-[2px] text-[9px] font-bold tracking-[0.12em]" style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.45)" }}><Bell className="h-3 w-3" />ALERTS</button>}
            bodyClass="hud-scroll overflow-y-auto px-2 pb-2">
            {(intel?.keyLevels ?? []).map((l, i) => {
              const isPx = l.role === "price";
              const col = isPx ? H.gold3 : l.role === "invalidation" ? H.red : l.watched || l.role === "watch" ? H.gold2 : l.role === "resistance" ? "#E7A0A7" : "#9FE3C8";
              const isPinned = !isPx && pinned != null && Math.abs(pinned.price - l.price) < 0.01;
              return (
                <button key={i} type="button" title={isPx ? "The live price" : "Mark this level on the chart"}
                  onClick={() => !isPx && setPinned(isPinned ? null : { price: l.price, label: cap(l.label) })}
                  className="flex w-full items-center gap-3 rounded-[5px] px-2 py-[3px] text-left text-[11px] transition hover:brightness-125"
                  style={isPx
                    ? { border: `1px solid ${H.gold2}`, background: "rgba(213,169,61,0.1)", boxShadow: "0 0 10px rgba(213,169,61,0.2)" }
                    : isPinned ? { border: `1px solid ${H.cyan2}`, background: "rgba(0,199,232,0.08)" } : { border: "1px solid transparent" }}>
                  <span className="w-[68px] font-semibold tabular-nums" style={{ color: isPx ? H.gold3 : H.text }}>{fmt2(l.price)}</span>
                  <span className="min-w-0 flex-1 truncate" style={{ color: isPx ? H.gold3 : H.mut }} title={l.label}>{cap(l.label)}</span>
                  <span className="shrink-0 text-[10px]" style={{ color: isPinned ? H.cyan2 : col }}>{isPx ? "→" : isPinned ? "pinned" : l.watched || l.role === "watch" ? "● watch" : l.role === "invalidation" ? "✕ fails" : "•".repeat(Math.max(1, 4 - Math.min(3, Math.floor(Math.abs(l.price - (d?.price ?? l.price)) / Math.max(1, (intel?.volatility.atr ?? 5)))) ))}</span>
                </button>
              );
            })}
            {!intel?.keyLevels?.length && <p className="px-2 py-2 text-[11px]" style={{ color: H.mut }}>Levels appear with the first market read.</p>}
          </HudPanel>
        </div>

        {/* CENTER */}
        <div className="hud-col hud-center">
          <HudPanel hi bodyClass="flex h-full flex-col">
            <div ref={chartRef} className="flex h-full min-h-0 flex-col" style={{ background: H.panel }}>
              <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1.5" style={{ borderColor: H.lineSoft }}>
                <div className="flex items-center gap-0.5 rounded-[7px] p-0.5" style={{ border: `1px solid ${H.line}` }}>
                  {TF_BTNS.map((b) => (
                    <button key={b.id} disabled={!b.feed} title={b.feed ? `${b.label} candles` : "1-minute candles are not in the feed ATLAS reads"}
                      onClick={() => setTf(b.id)}
                      className="rounded-[5px] px-2.5 py-1 text-[11px] transition disabled:cursor-not-allowed disabled:opacity-35"
                      style={{ color: tf === b.id ? H.gold3 : H.mut, border: tf === b.id ? "1px solid rgba(231,196,103,0.55)" : "1px solid transparent", background: tf === b.id ? "rgba(213,169,61,0.1)" : "transparent" }}>{b.label}</button>
                  ))}
                </div>
                <ToolBtn icon={<BarChart3 className="h-3.5 w-3.5" />} label="Indicators" on={indicators} onClick={() => setIndicators((x) => !x)} />
                <ToolBtn icon={<Sparkles className="h-3.5 w-3.5" style={{ color: H.gold2 }} />} label="AI Overlays" on={overlays} onClick={() => setOverlays((x) => !x)} />
                <ToolBtn icon={<Layers className="h-3.5 w-3.5" />} label="Liquidity" on={liquidity} onClick={() => setLiquidity((x) => !x)} />
                <ToolBtn icon={<PenLine className="h-3.5 w-3.5" />} label="Draw" on={false} disabled title="Drawing tools are not built yet" />
                {setupPill && (
                  <button onClick={() => setDrawer("trade")} className="ml-1 inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[10px] font-bold tracking-[0.1em] hud-in"
                    style={{ color: setupPill.color, border: `1px solid ${setupPill.color}`, background: "rgba(0,0,0,0.3)", boxShadow: `0 0 12px ${setupPill.color}55` }}>
                    <LiveDot color={setupPill.color} size={5} />{setupPill.text} ▸
                  </button>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1 text-[10.5px]" style={{ color: H.text, border: `1px solid ${H.line}` }}>
                    Live Analysis
                    <span onClick={() => { const v = !liveAnalysis; setLiveAnalysis(v); setOverlays(v); setLiquidity(v); }} className="relative h-[16px] w-[30px] rounded-full transition" style={{ background: liveAnalysis ? H.blue : "rgba(255,255,255,0.12)" }}>
                      <span className="absolute top-[2px] h-[12px] w-[12px] rounded-full bg-white transition-all" style={{ left: liveAnalysis ? 16 : 2 }} />
                    </span>
                  </label>
                  <button aria-label="Atlas settings" onClick={() => !isReplay && setProfileOpen(true)} className="p-1" style={{ color: H.mut }}><Settings className="h-4 w-4" /></button>
                  <button aria-label="Fullscreen" onClick={() => { const el = chartRef.current; if (el) void (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()); }} className="p-1" style={{ color: H.mut }}><Maximize2 className="h-4 w-4" /></button>
                </div>
              </div>
              <div className="min-h-0 flex-1 px-1 pt-1">
                <GoldChart
                  bars={chartBars} price={d?.price ?? null} markers={markers} zones={zones} lines={lines}
                  path={pathPts} pathLabel={intel?.path?.label ?? "Atlas scenario"}
                  showOverlays={overlays} showLiquidity={liquidity}
                  tfLabel={`XAUUSD · ${tfWord} · TWELVE DATA`}
                  activityLabel={chartBars.some((b) => b.v && b.v > 0) ? "Activity · tick volume" : "Activity · bar range (spot gold has no traded volume)"}
                />
              </div>
            </div>
          </HudPanel>

          {/* gauges + scenarios */}
          <div className="hud-under">
            <div className="grid grid-cols-2 gap-[9px] sm:grid-cols-5">
              <Gauge title="SELLER PRESSURE" display={intel ? `${intel.pressure.sellers}` : "—"}
                sub={intel?.pressure.sellerLabel ?? "—"} value01={intel ? (intel.pressure.sellers ?? 0) / 100 : null} color={H.red}
                delta={ch ? -ch.deltaNet / 2 : null} deltaLabel={ch ? `over ${ch.horizon}` : null} info={intel?.pressure.method} />
              <Gauge title="BUYER PRESSURE" display={intel ? `${intel.pressure.buyers}` : "—"}
                sub={intel?.pressure.buyerLabel ?? "—"} value01={intel ? (intel.pressure.buyers ?? 0) / 100 : null} color={H.green}
                delta={ch ? ch.deltaNet / 2 : null} deltaLabel={ch ? `over ${ch.horizon}` : null} info={intel?.pressure.method} />
              <Gauge title="VOLATILITY" display={intel?.volatility.atr != null ? intel.volatility.atr.toFixed(1) : "—"} sub={intel ? `${intel.volatility.label} · 15m ATR` : "—"} value01={volLevel(intel?.volatility.band)} color={H.gold2}
                info="The 15-minute average true range in dollars, with the engine's own weather band (compressed → extreme) from the ratio of current range to normal." />
              <Gauge title="MOMENTUM" display={intel?.momentum.value != null ? `${intel.momentum.value > 0 ? "+" : ""}${intel.momentum.value.toFixed(2)}` : "—"} sub={intel?.momentum.label ?? "—"} value01={intel?.momentum.value != null ? (intel.momentum.value + 3) / 6 : null} color={toneColor(intel?.momentum.tone)}
                info="The 15-minute frame's five-bar return measured in average ranges: −1.6 means price fell 1.6 normal ranges in five bars. Measured by the engine (core/math.ts)." />
              <Gauge title="ATLAS CONVICTION" display={thesis ? `${thesis.confidence}%` : "—"} sub={bias === "bear" ? "Downside" : bias === "bull" ? "Upside" : "No side"} value01={thesis ? thesis.confidence / 100 : null} color={biasColor}
                info="ATLAS's own confidence in the thesis it is trading, 0–100, as recorded by the engine. It is not a probability that the trade wins." />
            </div>
            <HudPanel title="SCENARIO ANALYSIS" right={<span className="text-[8px] tracking-[0.1em]" style={{ color: H.mut }} title="ATLAS has no probability model, so these are ranked by its current thesis rather than given percentages">RANKED</span>} bodyClass="hud-scroll flex flex-col gap-[3px] overflow-y-auto px-2.5 pb-1.5">
              {(intel?.scenarios ?? []).map((s, i) => {
                const col = s.kind === "bear" ? H.red : s.kind === "bull" ? H.green : H.mut;
                const Icon = s.kind === "bear" ? TrendingDown : s.kind === "bull" ? TrendingUp : MoveHorizontal;
                return (
                  <div key={s.kind} className="flex items-center gap-2 rounded-[6px] px-2 py-[3px]" style={{ border: `1px solid ${i === 0 ? col : H.line}`, background: i === 0 ? `${col}14` : "transparent" }}>
                    <Icon className="h-4 w-4 shrink-0" style={{ color: col }} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[9.5px] font-bold tracking-[0.06em]" style={{ color: col }}>{s.title.toUpperCase()}</p>
                      <p className="truncate text-[9.5px]" style={{ color: H.mut }}>{s.detail}</p>
                    </div>
                    <span className="text-[9px] font-bold tracking-[0.1em]" style={{ color: i === 0 ? col : H.mut }}>{s.rank}</span>
                  </div>
                );
              })}
              {!intel && <p className="text-[11px]" style={{ color: H.mut }}>Waiting for a read.</p>}
            </HudPanel>
          </div>

          {/* radar + structure + context */}
          <div className="hud-under">
            <div className="grid gap-[9px] sm:grid-cols-[250px_minmax(0,1fr)]">
              <HudPanel title="LIQUIDITY RADAR" icon={<Radar className="h-3.5 w-3.5" />}
                right={<span className="flex items-center gap-1" title="Estimated from price structure — gold is over the counter, so no feed here shows resting orders"><Chip active={liquidity} onClick={() => setLiquidity(true)}>Heatmap</Chip><Chip active={!liquidity} tone="cyan" onClick={() => setLiquidity(false)}>Structure</Chip></span>}
                bodyClass="flex items-center gap-2 px-2 pb-2">
                <LiquidityRadar price={d?.price ?? null} blips={blips} size={104} alive={alive} onHover={setRadarHover}
                  onPick={(b) => setPinned(pinned && Math.abs(pinned.price - b.price) < 0.01 ? null : { price: b.price, label: b.label })} />
                {radarHover ? (
                  <div className="min-w-0 flex-1 self-stretch rounded-[6px] p-1.5 text-[9.5px] leading-snug"
                    style={{ border: `1px solid rgba(${RADAR_KIND_COLOR[radarHover.kind]},0.55)`, background: "rgba(3,7,11,0.7)" }}>
                    <p className="flex items-baseline justify-between gap-1">
                      <b className="text-[11.5px] tabular-nums" style={{ color: H.text }}>{fmt2(radarHover.price)}</b>
                      <span style={{ color: H.mut }}>{radarHover.side === "above" ? "above" : "below"}{radarHover.distance != null ? ` · ${radarHover.distance.toFixed(2)}` : ""}</span>
                    </p>
                    <p style={{ color: `rgb(${RADAR_KIND_COLOR[radarHover.kind]})` }}>{RADAR_KIND_WORD[radarHover.kind]}{radarHover.swept ? " · swept" : ""}</p>
                    <p className="mt-0.5 line-clamp-4" style={{ color: H.mut }}>{radarHover.meaning ?? radarHover.label}</p>
                  </div>
                ) : (
                <ul className="space-y-[4px] text-[9px]" style={{ color: H.text }}>
                  {[["Buyside liq.", H.green], ["Sellside liq.", H.red], ["Equal highs/lows", "#E7A0A7"], ["Busiest price", H.blue], ["Atlas watch", H.gold2], ["Price", H.gold3]].map(([k, c]) => (
                    <li key={k} className="flex items-center gap-1.5"><span className="h-[7px] w-[7px] rounded-full" style={{ background: c, boxShadow: `0 0 5px ${c}` }} />{k}</li>
                  ))}
                  <li className="pt-0.5 leading-tight" style={{ color: H.mut2 }}>Hollow = swept.<br />Hover a blip for detail.</li>
                </ul>
                )}
              </HudPanel>
              <HudPanel title="MARKET STRUCTURE" icon={<LineChart className="h-3.5 w-3.5" />} bodyClass="grid grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] gap-2 px-2 pb-2">
                <div className="relative min-h-[110px]">
                  <StructureViz pivots={pivots} price={d?.price ?? null} bearish={bias === "bear"} />
                  <p className="absolute right-1 top-0 text-[9px]" style={{ color: H.mut }}>Structure <b style={{ color: biasColor }}>{bias === "bear" ? "BEARISH" : bias === "bull" ? "BULLISH" : "MIXED"}</b></p>
                </div>
                <dl className="hud-scroll grid content-start gap-[3px] overflow-y-auto text-[9.5px]">
                  {[
                    ["Trend", intel?.structure.trend, intel?.structure.trend === "Downtrend" ? H.red : intel?.structure.trend === "Uptrend" ? H.green : H.text],
                    ["Market structure", intel?.structure.sequence, intel?.structure.sequence?.startsWith("Lower") ? H.red : intel?.structure.sequence?.startsWith("Higher") ? H.green : H.text],
                    ["Liquidity (above)", intel?.liquidity.aboveZone ? `${fmt2(intel.liquidity.aboveZone[0])} – ${fmt2(intel.liquidity.aboveZone[1])}` : "—", H.text],
                    ["Liquidity (below)", intel?.liquidity.belowZone ? `${fmt2(intel.liquidity.belowZone[0])} – ${fmt2(intel.liquidity.belowZone[1])}` : "—", H.text],
                    ["Current phase", intel?.structure.phase, H.gold2],
                    ["Next watched", intel?.structure.nextWatched != null ? fmt2(intel.structure.nextWatched) : "—", H.gold2],
                  ].map(([k, v, c]) => (
                    <div key={String(k)} className="flex items-baseline justify-between gap-2 border-b pb-[3px]" style={{ borderColor: H.lineSoft }}>
                      <dt style={{ color: H.mut }}>{k}</dt><dd className="truncate text-right font-medium tabular-nums" style={{ color: String(c) }}>{v ?? "—"}</dd>
                    </div>
                  ))}
                </dl>
              </HudPanel>
            </div>
            <HudPanel title="GLOBAL CONTEXT" icon={<Globe2 className="h-3 w-3" />}
              right={<span className="text-[8px] tracking-[0.1em]" style={{ color: H.mut }} title="Shown for context only. GENX and ATLAS do not read these — nothing here changes a trade. Refreshed every 15 minutes from Twelve Data.">DISPLAY ONLY{ctx?.at ? ` · ${new Date(ctx.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span>}
              bodyClass="flex flex-col gap-[3px] px-2.5 pb-1.5">
              {(() => {
                const rows = ctx?.rows ?? [];
                const dxy = rows.find((r) => r.key === "dxy") ?? null;
                const rest = rows.filter((r) => r.key !== "dxy");
                const dot = (st: CtxRow["status"]) => st === "live" ? H.green : st === "delayed" ? H.gold2 : st === "stale" ? H.mut : H.red;
                return (
                  <>
                    <div className="flex items-center gap-2.5" title={dxy?.note}>
                      <span className="h-[36px] w-[36px] shrink-0 rounded-full" style={{ background: "radial-gradient(circle at 35% 30%, #7FD3FF, #0B4A7A 55%, #03101C 80%)", boxShadow: "0 0 14px rgba(89,175,255,0.4), inset -5px -5px 10px rgba(0,0,0,0.55)" }} />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 text-[10px] font-bold tracking-[0.12em]" style={{ color: H.text }}>
                          DXY
                          <span className="inline-flex items-center gap-1 text-[8px] font-semibold tracking-[0.1em]" style={{ color: dot(dxy?.status ?? "not_connected") }}>
                            <span className="h-[5px] w-[5px] rounded-full" style={{ background: dot(dxy?.status ?? "not_connected") }} />
                            {(dxy?.status ?? "not_connected").replace("_", " ").toUpperCase()}
                          </span>
                        </p>
                        {dxy?.value != null ? (
                          <p className="flex items-baseline gap-2">
                            <b className="text-[17px] tabular-nums" style={{ color: H.text }}>{dxy.value.toFixed(2)}</b>
                            <span className="text-[10.5px] tabular-nums" style={{ color: (dxy.changePct ?? 0) >= 0 ? H.green : H.red }}>
                              {(dxy.changePct ?? 0) >= 0 ? "+" : ""}{dxy.change?.toFixed(2) ?? "—"} ({(dxy.changePct ?? 0) >= 0 ? "+" : ""}{dxy.changePct?.toFixed(2) ?? "—"}%)
                            </span>

                          </p>
                        ) : (
                          <p className="text-[10.5px]" style={{ color: H.red }}>DXY feed not connected</p>
                        )}
                        <p className="truncate text-[8.5px]" style={{ color: H.mut2 }} title={dxy?.note}>{dxy ? `${dxy.instrument}${dxy.value != null ? ` · ${dxy.period}` : ""}` : "waiting for the context feed"}</p>
                      </div>
                      <Sparkline values={(ctx?.history ?? []).map((h) => h.v)} color={(dxy?.changePct ?? 0) >= 0 ? H.green : H.red} w={46} h={24} />
                    </div>

                    <table className="w-full text-[9.5px] tabular-nums">
                      <tbody>
                        {(rest.length ? rest : [{ key: "x", label: "US10Y" }, { key: "y", label: "SPX" }, { key: "z", label: "WTI" }] as CtxRow[]).map((q) => (
                          <tr key={q.key} title={q.note ? `${q.instrument} · ${q.source} — ${q.note}` : undefined}>
                            <td style={{ color: H.mut }}>{q.label}<span style={{ color: H.mut2 }}>{q.instrument && q.instrument !== "—" ? ` ${q.instrument.replace(" ETF", "")}` : ""}</span></td>
                            <td className="text-right" style={{ color: H.text }}>{q.value == null ? "—" : q.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
                            <td className="w-[48px] text-right" style={{ color: q.changePct == null ? H.mut2 : q.changePct >= 0 ? H.green : H.red }}>{q.changePct == null ? "" : `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%`}</td>
                            <td className="w-[10px] text-right"><span className="inline-block h-[5px] w-[5px] rounded-full" style={{ background: dot(q.status ?? "not_connected") }} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-auto flex items-center gap-2 rounded-[6px] px-2 py-[3px]" style={{ border: `1px solid ${H.line}` }}>
                      <AlertTriangle className="h-3 w-3 shrink-0" style={{ color: intel?.news?.lockout ? H.red : H.gold2 }} />
                      <p className="min-w-0 flex-1 text-[9.5px] leading-tight" style={{ color: H.text }}>
                        {intel?.news ? <>{intel.news.name}<span className="block text-[8.5px]" style={{ color: H.mut }}>{intel.news.lockout ? "Release lockout active" : intel.news.minutesTo != null ? `in ${Math.round(intel.news.minutesTo)} min · ${intel.news.importance} impact` : intel.news.importance}</span></> : <>No high-impact release scheduled<span className="block text-[8.5px]" style={{ color: H.mut }}>Atlas does read the calendar; the quotes above it do not reach any trade.</span></>}
                      </p>
                    </div>
                  </>
                );
              })()}
            </HudPanel>
          </div>
        </div>

        {/* RIGHT */}
        <div className="hud-col hud-right">
          <HudPanel title="TALK WITH ATLAS" icon={<Mic className="h-3.5 w-3.5" />} right={<span className="inline-flex items-center gap-1.5 text-[10px]" style={{ color: H.green }}><LiveDot size={5} />Online</span>} bodyClass="flex h-full flex-col">
            <div className="grid shrink-0 grid-cols-4 gap-1.5 px-3 pb-2">
              {(["CHAT", "VOICE", "ANALYSIS", "SETTINGS"] as TalkTab[]).map((t) => (
                <button key={t} onClick={() => setTalkTab(t)} className="rounded-[6px] py-1 text-[9.5px] font-semibold tracking-[0.14em]"
                  style={{ color: talkTab === t ? H.gold3 : H.mut, border: `1px solid ${talkTab === t ? "rgba(231,196,103,0.6)" : H.line}`, background: talkTab === t ? "rgba(213,169,61,0.12)" : "transparent", boxShadow: talkTab === t ? "0 0 10px rgba(213,169,61,0.2)" : "none" }}>{t}</button>
              ))}
            </div>
            <div className="min-h-0 flex-1 border-t" style={{ borderColor: H.lineSoft }}>
              {/* Chat stays mounted so a conversation survives switching tabs. */}
              <div className={talkTab === "CHAT" ? "h-full" : "hidden"}>
                <BrainConsole variant="hud" announce={announce} onUiAction={onUiAction} mode={mode} onModeChange={setMode} live={!!d?.live} askSignal={askSignal} onActivity={onActivity}
                  quick={[
                    { label: "Show key levels", q: "What are the key levels above and below price right now, and which one matters most?" },
                    { label: "Run scenario analysis", q: "Run through the scenarios: what's primary, what's the alternative, and what would flip it?" },
                    { label: "What's the trend?", q: "What are the timeframes saying, and where do they disagree?" },
                    { label: "Check liquidity", q: "Where is liquidity sitting above and below, and has any of it been swept?" },
                    ...(intel?.structure.nextWatched != null ? [{ label: `Watch ${fmt2(intel.structure.nextWatched)}`, q: `Watch ${fmt2(intel.structure.nextWatched)} for me and tell me when price reaches it.` }] : []),
                  ]} />
              </div>
              {talkTab === "VOICE" && (
                <div className="hud-scroll h-full overflow-y-auto p-2">
                  {isReplay ? <p className="p-3 text-[12px]" style={{ color: H.mut }}>Voice is off in the replay.</p> : <VoiceSession onUiAction={onUiAction} />}
                  <p className="px-2 pt-2 text-[10.5px]" style={{ color: H.mut }}>Prefer typing or quick push-to-talk? Use <button className="underline" onClick={() => setTalkTab("CHAT")} style={{ color: H.gold2 }}>Chat</button> — press space to speak there.</p>
                </div>
              )}
              {talkTab === "ANALYSIS" && <div className="hud-scroll h-full overflow-y-auto p-3"><ThesisExplainer d={d} onAsk={ask} /></div>}
              {talkTab === "SETTINGS" && (
                <div className="hud-scroll h-full space-y-3 overflow-y-auto p-3">
                  <p className={LABEL} style={{ color: H.mut }}>When ATLAS speaks</p>
                  <div className="flex flex-wrap gap-1.5">
                    {VOICE_MODES.map((m) => <Chip key={m.id} active={mode === m.id} onClick={() => setMode(m.id)} title={m.hint}>{m.label}</Chip>)}
                  </div>
                  <p className="text-[11px]" style={{ color: H.mut }}>{VOICE_MODES.find((m) => m.id === mode)?.hint}</p>
                  {!isReplay && <button onClick={() => setProfileOpen(true)} className="rounded-[6px] px-3 py-1.5 text-[10px] font-bold tracking-[0.12em]" style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.45)" }}>RISK, STYLES & AUTOMATION ▸</button>}
                </div>
              )}
            </div>
          </HudPanel>

          <HudPanel title="INTELLIGENCE STREAM" icon={<Brain className="h-3 w-3" />}
            right={<span className="flex items-center gap-[3px]">{(["ALL", "PRICE", "STRUCTURE", "NEWS"] as StreamFilter[]).map((f) => <Chip key={f} active={streamFilter === f} onClick={() => setStreamFilter(f)} className="!px-1.5 !text-[8px]">{f}</Chip>)}<LiveDot size={5} /></span>}
            bodyClass="hud-scroll overflow-y-auto px-2 pb-2">
            {streamRows.length ? streamRows.map((r, i) => (
              <div key={r.key} className={`flex gap-2.5 border-b border-l-2 py-[5px] pl-2 pr-1.5 ${i === 0 ? "hud-in" : ""}`}
                style={{ borderBottomColor: H.lineSoft, borderLeftColor: r.kind === "trade" ? H.gold2 : r.kind === "news" ? H.blue : r.kind === "structure" ? "rgba(39,215,242,0.5)" : "rgba(255,255,255,0.12)" }}>
                <span className="shrink-0 text-[10px] tabular-nums" style={{ color: H.mut }}>{clock(r.at)}</span>
                <span className="text-[11px] leading-snug" title={`${new Date(r.at).toLocaleTimeString()} · ${r.kind}`} style={{ color: r.urgent ? H.gold2 : r.kind === "trade" ? H.gold3 : r.lean === "bearish" ? "#F2B8BE" : r.lean === "bullish" ? "#B5EDD8" : "#C9D3DB" }}>{r.detail}</span>
              </div>
            )) : <p className="p-2 text-[11px]" style={{ color: H.mut }}>Nothing worth reporting yet. ATLAS stays quiet when nothing has changed.</p>}
          </HudPanel>
        </div>
      </div>

      {/* ── DRAWERS (trade / analysis / alerts / journal) ─────────────── */}
      {drawer && (
        <div className="fixed inset-0 z-40 flex justify-end" style={{ background: "rgba(0,0,0,0.45)" }} onClick={() => { setDrawer(null); setNav("OVERVIEW"); }}>
          <aside className="hud-scroll hud-in h-full w-full max-w-[560px] overflow-y-auto p-3" style={{ background: H.bg1, borderLeft: `1px solid ${H.lineHi}` }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[12px] font-bold tracking-[0.16em]" style={{ color: H.gold2 }}>{drawer === "trade" ? "ATLAS'S TRADE" : drawer === "analysis" ? "ANALYSIS" : drawer === "alerts" ? "ALERTS & WATCHES" : "TODAY'S ATLAS"}</p>
              <button onClick={() => { setDrawer(null); setNav("OVERVIEW"); }} aria-label="Close" style={{ color: H.mut }}><X className="h-5 w-5" /></button>
            </div>
            {drawer === "trade" && (
              <div className="space-y-3">
                {trade?.unmanaged?.length ? <UnmanagedNotice trade={trade} onChanged={() => setReloadAt(Date.now())} /> : null}
                {trade?.active ? <TradePanel trade={trade} onChanged={() => setReloadAt(Date.now())} /> : (
                  <BrainTradeCard setup={setup} profile={profile} account={desk.account} idempotencyKey={desk.idempotencyKey}
                    marketOpen={d?.marketOpen ?? true} onChanged={() => setReloadAt(Date.now())}
                    onOpenManual={() => setCallOpen(true)} onOpenProfile={() => setProfileOpen(true)} />
                )}
                {d?.experience?.completed && !trade?.active && <TradeCompleteCard c={d.experience.completed} />}
              </div>
            )}
            {drawer === "analysis" && <ThesisExplainer d={d} onAsk={(q) => { setDrawer(null); ask(q); }} full />}
            {drawer === "alerts" && (
              <div className="space-y-2">
                {d?.watches?.length ? d.watches.map((w) => (
                  <div key={w.id} className="rounded-[8px] p-3" style={{ border: `1px solid ${H.line}` }}>
                    <p className="text-[12.5px]">{w.label ?? (w.price != null ? fmt2(w.price) : words(w.kind))} <span style={{ color: H.mut }}>· {words(w.kind)}</span></p>
                    <p className="mt-0.5 text-[11px]" style={{ color: H.mut }}>&ldquo;{w.said}&rdquo;</p>
                    <div className="mt-2 h-[3px] overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.07)" }}><div className="h-full" style={{ width: `${Math.round((w.progress ?? 0) * 100)}%`, background: H.gold2 }} /></div>
                  </div>
                )) : <p className="text-[12px]" style={{ color: H.mut }}>No alerts armed. Ask ATLAS to watch a level — &ldquo;watch 4,360 for me&rdquo; — and it appears here.</p>}
                <button onClick={() => { setDrawer(null); ask("What level should I have you watch right now, and why?"); }} className="mt-2 rounded-[6px] px-3 py-1.5 text-[10px] font-bold tracking-[0.12em]" style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.45)" }}>ASK WHAT TO WATCH ▸</button>
              </div>
            )}
            {drawer === "journal" && (
              <div className="space-y-1">
                {d?.journal?.length ? d.journal.slice().reverse().map((j) => (
                  <div key={j.id} className="flex gap-3 border-b py-2" style={{ borderColor: H.lineSoft }}>
                    <span className="w-[62px] shrink-0 text-[11px] tabular-nums" style={{ color: H.mut }}>{new Date(j.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                    <div><p className="text-[12.5px] font-semibold">{j.label} <span className="font-normal" style={{ color: H.mut }}>· {j.confidence}</span></p>{j.reasonEnded && <p className="text-[11.5px]" style={{ color: H.mut }}>ended — {j.reasonEnded}</p>}</div>
                  </div>
                )) : <p className="text-[12px]" style={{ color: H.mut }}>No reads recorded today yet.</p>}
              </div>
            )}
          </aside>
        </div>
      )}

      {!isReplay && (
        <>
          <RiskConsent open={consentOpen} onClose={() => setConsentOpen(false)} onSigned={(c) => setConsent(c)} />
          <TradeAlert setup={setup} riskPct={d?.profile?.riskPct ?? 0.5} balance={desk.account?.equity ?? null} currency={desk.account?.currency ?? null}
            hasPosition={!!trade?.active} onChanged={() => setReloadAt(Date.now())} onDetails={() => setDrawer("trade")} />
          <ProfileSheet open={profileOpen} profile={profile} onClose={() => { setProfileOpen(false); setNav("OVERVIEW"); }}
            onSaved={(p) => { setDesk((x) => ({ ...x, profile: p })); setReloadAt(Date.now()); }} />
          <CallTradeSheet price={d?.price ?? null} levels={(d?.levels ?? []).map((l) => ({ price: l.price, label: l.label }))}
            open={callOpen} onClose={() => setCallOpen(false)} onDone={() => setReloadAt(Date.now())} />
        </>
      )}
    </div>
  );
}

/* ── small pieces ─────────────────────────────────────────────────────── */

function volLevel(band?: string | null): number | null {
  const m: Record<string, number> = { compressed: 0.15, quiet: 0.3, normal: 0.45, active: 0.62, expanding: 0.78, extreme: 0.95, news_shock: 0.95 };
  return band ? m[band] ?? 0.45 : null;
}

function pulseText(d: Live | null): string {
  if (!d) return "Waiting for the first market read.";
  const parts: string[] = [];
  if (d.brain?.headline) parts.push(d.brain.headline);
  const t = d.thesis;
  if (t) {
    const why = [...t.reasonStarted, ...t.reasonStrengthened].slice(0, 2);
    parts.push(...why);
    if (t.reasonWeakened.length) parts.push(`Weakening: ${t.reasonWeakened[t.reasonWeakened.length - 1]}`);
  }
  if (!parts.length && d.summary) parts.push(d.summary);
  return parts.join(" ");
}

/** The thesis translated: what, why, what changed, watching, what invalidates, what strengthens. */
function ThesisExplainer({ d, onAsk, full = false }: { d: Live | null; onAsk: (q: string) => void; full?: boolean }) {
  const t = d?.thesis;
  if (!t) return <p className="text-[12px]" style={{ color: H.mut }}>No firm read yet — ATLAS is still building one.</p>;
  const p5 = d?.changes?.find((c) => c.horizon === "5m");
  const rows: [string, ReactNode][] = [
    ["What I think", <><b>{t.label.toUpperCase()}</b> <span style={{ color: H.mut }}>· {t.strength} · {t.confidence}</span></>],
    ["Why", <ul className="space-y-0.5">{[...t.reasonStarted, ...t.reasonStrengthened].slice(0, 5).map((r, i) => <li key={i}>— {r}</li>)}</ul>],
    ["What changed", d?.previousThesis?.reasonEnded ? `Before this I read ${d.previousThesis.label.toLowerCase()}, until ${d.previousThesis.reasonEnded}.` : p5 ? `Pressure ${p5.pressureFrom} → ${p5.pressureTo} over five minutes; price ${p5.priceMove >= 0 ? "+" : ""}${p5.priceMove.toFixed(2)}.` : "Nothing material in the last few minutes."],
    ["Weakening", t.reasonWeakened.length ? t.reasonWeakened[t.reasonWeakened.length - 1] : "Nothing is working against it right now."],
    ["Watching", t.watching.length ? t.watching.map((w) => fmt2(w)).join(" · ") : "—"],
    ["Wrong if", t.invalidationPrice != null ? `Price accepts beyond ${fmt2(t.invalidationPrice)}.` : "No single price invalidates it yet."],
    ["Stronger if", d?.scenario ? (t.label.toLowerCase().includes("bear") ? d.scenario.bear : t.label.toLowerCase().includes("bull") ? d.scenario.bull : d.scenario.neutral) : "—"],
  ];
  return (
    <div className="space-y-2.5">
      {rows.map(([k, v]) => (
        <div key={k}>
          <p className={LABEL} style={{ color: H.gold2 }}>{k}</p>
          <div className="mt-0.5 text-[12px] leading-relaxed" style={{ color: "#C9D3DB" }}>{v}</div>
        </div>
      ))}
      {full && d?.timeframes && (
        <div>
          <p className={LABEL} style={{ color: H.gold2 }}>Timeframe story</p>
          {["1d", "4h", "1h", "15m", "5m"].filter((k) => d.timeframes[k]).map((k) => (
            <p key={k} className="text-[12px]" style={{ color: "#C9D3DB" }}><span className="inline-block w-9 tabular-nums" style={{ color: H.mut }}>{k}</span>{words(d.timeframes[k].state)}</p>
          ))}
        </div>
      )}
      <button onClick={() => onAsk("What would change your mind right now?")} className="rounded-[6px] px-3 py-1.5 text-[10px] font-bold tracking-[0.12em]" style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.45)" }}>WHAT WOULD CHANGE YOUR MIND? ▸</button>
    </div>
  );
}

function ToolBtn({ icon, label, on, onClick, disabled, title }: { icon: ReactNode; label: string; on: boolean; onClick?: () => void; disabled?: boolean; title?: string }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title ?? label}
      className="inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[11px] transition disabled:cursor-not-allowed disabled:opacity-40"
      style={{ color: on ? H.text : H.mut, border: `1px solid ${on ? H.line : "transparent"}`, background: on ? "rgba(89,175,255,0.06)" : "transparent" }}>
      {icon}{label}
    </button>
  );
}

function Notice({ children, color }: { children: ReactNode; color: string }) {
  return <span className="inline-block rounded-[6px] px-3 py-1.5 text-left text-[11.5px]" style={{ color, border: `1px solid ${color}55`, background: `${color}10` }}>{children}</span>;
}

function Sparkline({ values, color, w = 130, h = 34 }: { values: number[]; color: string; w?: number; h?: number }) {
  if (values.length < 2) return <span style={{ width: w, height: h }} />;
  const lo = Math.min(...values), hi = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4)}`).join(" ");
  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.3} style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
    </svg>
  );
}

function GoldBars() {
  return (
    <svg width="44" height="32" viewBox="0 0 44 32" aria-hidden>
      <defs><linearGradient id="gb" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#FFE9A8" /><stop offset=".5" stopColor="#E0AE3F" /><stop offset="1" stopColor="#8A5E14" /></linearGradient></defs>
      <path d="M6 30 L10 20 H24 L28 30 Z" fill="url(#gb)" /><path d="M20 30 L24 20 H38 L42 30 Z" fill="url(#gb)" /><path d="M13 19 L17 9 H31 L35 19 Z" fill="url(#gb)" />
      <path d="M17 9 H31" stroke="#FFF3CF" strokeWidth=".8" />
    </svg>
  );
}

export default CommandCenterHud;
