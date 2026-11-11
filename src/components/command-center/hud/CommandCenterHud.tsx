"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle, BarChart3, Bell, BookOpen, Globe2, Layers, LineChart, Maximize2, Menu, Mic, Radar, RefreshCw,
  Settings, Sparkles, Target, X, Zap,
} from "lucide-react";
import { H, fmt2, LABEL } from "./theme";
import { HudPanel, LiveDot, Chip, HUD_CSS, Sparkline } from "./Hud";
import { BrainOrb, type OrbState } from "./BrainOrb";
import { voiceBus, useVoiceBus, lineOpen } from "../voiceBus";
import { GoldChart, type ChartBar, type ChartLine, type ChartMarker, type ChartZone } from "./GoldChart";
import type { RadarBlip } from "./LiquidityRadar";
import type { Live } from "../CommandCenterLive";
import BrainConsole, { VOICE_MODES, dispatchChartAction, type VoiceMode } from "../BrainConsole";
import BrokerBar from "../BrokerBar";
import TradePanel, { CallTradeSheet, UnmanagedNotice } from "../TradePanel";
import { BrainTradeCard, ProfileSheet, TradeCompleteCard, type ProfileView } from "../BrainTrade";
import VoiceSession from "../VoiceSession";
import { HudTour, tourSeen } from "./HudTour";
import TradeAlert from "../TradeAlert";
import RiskConsent, { type ConsentView } from "../RiskConsent";
import { useLiveFeed } from "./useLiveFeed";
import {
  CHART_ACTION_EVENT, CHART_TFS, levelIdOf, validateChartAction, type ChartTf,
} from "../../../../command-center/core/atlasContract";
import { FEED_STATUS_WORD, FEED_POLL_MS, feedAgeWords } from "../../../../command-center/core/feed";
import { COMMENTARY_MODES, COPILOT_COOLDOWNS_MS } from "../../../../command-center/core/commentary";
import { ReadCard, type PointTarget } from "./ReadCard";
import { ScenarioCards } from "./ScenarioCards";
import { IndicatorsPanel } from "./IndicatorsPanel";
import { ContextPanel, LiquidityPanel, StructurePanel, type CtxState } from "./DeeperPanels";
import { Timeline, type TimelineRow } from "./Timeline";
import {
  FEED_TONE, LEAN_TONE, ageShort, automationOf, leanLabel, orbLabelOf, orbVoiceOf, rangeFromArg, talkStateOf, tfFromArg,
} from "./hudModel";

/**
 * COMMAND CENTER XAUUSD — THE INTELLIGENCE HUD.
 *
 * LAYER 2 ONLY. This screen visualises and explains what ATLAS has already measured; it computes no
 * market opinion that could reach a trade. Every number here arrives from /api/command-center/live (the
 * engine's snapshot, ATLAS's read and scenarios, the feed state, and the read-only `intel` block from
 * command-center/present), from /tick + Realtime (useLiveFeed: the price and its honest status), from /bars
 * (the candles the worker already fetched) or from /context (informational macro quotes). Where the engine has
 * no measurement — probabilities, order flow — the screen says so rather than inventing one.
 *
 * THE LAYOUT (ATLAS integration, owner 11-11). A compact strip across the top (the price, whose it is, how
 * fresh the quote and the analysis each are, the session, the connection). Left: ATLAS's read, timeframe
 * alignment and key levels. Centre: the chart, given most of the room, with the scenario cards beneath it and
 * the indicators folded into one line between them. Right: the voice/chat copilot. Bottom: the intelligence
 * timeline. Deeper panels (candidate liquidity zones, market structure, global context, the lean journal) live
 * in the ANALYSIS drawer. Below 1280 px the same panels stack — chart, read, scenarios, levels — and the
 * copilot becomes a sheet behind a dock fixed to the bottom of the screen, so talking never means scrolling.
 */

const TF_BTNS: { id: ChartTf; label: string }[] = CHART_TFS.map((id) => ({ id, label: id === "1d" ? "D" : id }));
const TF_MIN: Record<ChartTf, number> = { "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };
const NAV = ["OVERVIEW", "ANALYSIS", "SCANNERS", "STRATEGY", "BACKTEST", "ALERTS", "JOURNAL"] as const;
type Nav = typeof NAV[number];
type TalkTab = "CHAT" | "VOICE" | "ANALYSIS" | "SETTINGS";
type Drawer = null | "trade" | "analysis" | "alerts" | "journal";
type AnalysisTab = "journal" | "liquidity" | "structure" | "context";
/** The chat's timed written read — the part of its mode that does something in the HUD console. */
const BRIEFING_CHOICES: { id: VoiceMode; label: string }[] = [
  { id: "push_to_talk", label: "Off" }, { id: "briefing_1m", label: "Every minute" }, { id: "briefing_5m", label: "Every 5 minutes" },
];
const ANALYSIS_TABS: { id: AnalysisTab; label: string }[] = [
  { id: "journal", label: "Lean journal" }, { id: "liquidity", label: "Liquidity zones" },
  { id: "structure", label: "Structure" }, { id: "context", label: "Global context" },
];

const words = (s?: string | null) => (s ? s.replace(/_/g, " ") : "—");
const cap = (s: string) => s.replace(/(^|[\s(])(\w)/g, (_, a, b) => a + b.toUpperCase());
const hhmmss = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const toneCol = (t: string) => (t === "green" ? H.green : t === "red" ? H.red : t === "gold" ? H.gold2 : t === "blue" ? H.blue : t === "cyan" ? H.cyan2 : t === "text" ? H.text : H.mut);

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

/** A media query, read after mount (the server renders the desktop layout's markup either way). */
function useMedia(q: string): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [q]);
  return m;
}

/**
 * THE DESK. At 1280 px and up it is a cockpit: it fills the window and the panels share it; on a shorter
 * window the grid keeps a floor height and the root scrolls rather than silently cutting the bottom off.
 * Below 1280 px the column wrappers dissolve (display: contents) and each panel takes its place in one
 * column by `order` — chart, read, scenarios, levels, alignment, indicators — while the copilot becomes a
 * bottom sheet (the same mounted panel, moved off-screen, so a call or a conversation survives closing it).
 */
const DESK = `
.hud-grid { display:grid; gap:8px; min-width:0; }
.hud-col > *, .hud-grid > * { min-width:0; }
@media (min-width:1280px) {
  .hud-root { height:100dvh; overflow-x:hidden; overflow-y:auto; display:flex; flex-direction:column; }
  .hud-grid { grid-template-columns: minmax(284px,21%) minmax(0,1fr) minmax(318px,23%); flex:1 1 auto; min-height:600px; }
  .hud-col { min-height:0; display:flex; flex-direction:column; gap:8px; }
  .hud-left > .hud-read { flex:1 1 60%; min-height:240px; }
  .hud-left > .hud-tf { flex:0 0 auto; }
  .hud-left > .hud-levels { flex:1 1 28%; min-height:128px; }
  .hud-center > .hud-chart { flex:1 1 auto; min-height:300px; }
  .hud-center > .hud-ind { flex:0 0 auto; }
  .hud-center > .hud-scen { flex:0 0 auto; height:clamp(188px, 22vh, 210px); }
  .hud-right > .hud-talk { flex:1 1 auto; min-height:0; }
  .hud-bottom { flex:0 0 auto; height:100px; }
  .hud-bottom > * { min-height:0; height:100%; }
}
/* 1280–1535: the scenario cards are narrow, so their sentences take more lines — give them the room. */
@media (min-width:1280px) and (max-width:1535px) { .hud-center > .hud-scen { height:208px; } }
@media (max-width:1279px) {
  .hud-grid { display:flex; flex-direction:column; }
  .hud-col { display:contents; }
  .hud-chart { order:1; height:clamp(330px, 58vh, 620px); }
  .hud-read { order:2; }
  .hud-scen { order:3; }
  .hud-levels { order:4; max-height:340px; }
  .hud-tf { order:5; }
  .hud-ind { order:6; }
  .hud-root .hud-talk { position:fixed; left:0; right:0; bottom:0; top:auto; height:min(86dvh, 780px); z-index:50;
    border-radius:14px 14px 0 0; transform:translateY(104%); visibility:hidden;
    transition: transform .28s cubic-bezier(.22,.9,.24,1), visibility 0s linear .28s; box-shadow: 0 -18px 50px rgba(0,0,0,0.6); }
  .hud-root .hud-talk.is-open { transform:none; visibility:visible; transition: transform .28s cubic-bezier(.22,.9,.24,1), visibility 0s; }
  .hud-bottom .hud-timeline { max-height:320px; }
}
@media (min-width:768px) and (max-width:1279px) { .hud-root .hud-talk { left:auto; width:min(560px, 100vw); border-radius:14px 0 0 0; } }
`;

export function CommandCenterHud({ endpoint = "/api/command-center/live" }: { endpoint?: string } = {}) {
  const isReplay = endpoint.includes("replay");

  /* ── state — EVERY hook sits above the render, with no early return anywhere ─────────────────── */
  const [d, setD] = useState<Live | null>(null);
  /** The last /live failure. The last good read stays on screen, under a banner that says it is not updating. */
  const [err, setErr] = useState<{ msg: string; code: number | null; at: number } | null>(null);
  const [goodAt, setGoodAt] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [reloadAt, setReloadAt] = useState(0);
  const [mode, setMode] = useState<VoiceMode>("push_to_talk");
  const [tf, setTf] = useState<ChartTf>("15m");
  const [tfData, setTfData] = useState<{ tf: ChartTf; bars: ChartBar[]; at: number | null } | null>(null);
  const [overlays, setOverlays] = useState(true);
  const [liquidity, setLiquidity] = useState(true);
  const [watchLines, setWatchLines] = useState(true);
  const [talkTab, setTalkTab] = useState<TalkTab>(isReplay ? "CHAT" : "VOICE");
  const [nav, setNav] = useState<Nav>("OVERVIEW");
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [analysisTab, setAnalysisTab] = useState<AnalysisTab>("journal");
  const [callOpen, setCallOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [consent, setConsent] = useState<ConsentView | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [askSignal, setAskSignal] = useState<{ n: number; q: string } | null>(null);
  const [activity, setActivity] = useState({ busy: false, speaking: false, listening: false });
  const [ctx, setCtx] = useState<CtxState>(null);
  /** A level the member tapped: the chart marks it until they tap it again or a minute passes. */
  const [pinned, setPinned] = useState<{ price: number; label: string } | null>(null);
  const [now, setNow] = useState(0);   // 0 until mounted, so server and client render the same text
  const [flash, setFlash] = useState<"up" | "dn" | null>(null);
  const [desk, setDesk] = useState<{
    account: { equity: number | null; currency: string | null; isLive: boolean; liveAuthorized: boolean } | null;
    idempotencyKey: string | null; profile: ProfileView | null;
  }>({ account: null, idempotencyKey: null, profile: null });
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  /** Below 1280 px: the copilot sheet, and the header menu. */
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** The scenario drawn on the chart (from a card, or from ATLAS). */
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  /** ATLAS drew on the chart while the sheet covered it: offer to show it. */
  const [chartPing, setChartPing] = useState<number | null>(null);
  const [tourOpen, setTourOpen] = useState(false);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartPanelRef = useRef<HTMLDivElement | null>(null);
  const lastPrice = useRef<number | null>(null);
  const wasOnCall = useRef(false);

  const stacked = useMedia("(max-width: 1279px)");
  // The price and its honest status: streamed ticks (Realtime) or the /tick poll, with the /live answer's feed
  // folded in when it carries a fresher price. The replay is DEMO and fetches nothing.
  const lf = useLiveFeed({ enabled: !isReplay, demo: isReplay, serverFeed: d?.feed ?? null });
  const vb = useVoiceBus();

  // Read by event handlers without re-subscribing them on every render.
  const levelsRef = useRef<Live["levels"]>([]);
  levelsRef.current = d?.levels ?? [];
  const scenariosRef = useRef<NonNullable<Live["scenarios"]>>([]);
  scenariosRef.current = d?.scenarios ?? [];
  const stackedRef = useRef(stacked);
  stackedRef.current = stacked;
  const sheetOpenRef = useRef(sheetOpen);
  sheetOpenRef.current = sheetOpen;
  const tfRef = useRef(tf);
  tfRef.current = tf;

  /* ── data ─────────────────────────────────────────────────────────────── */
  useEffect(() => { setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { if (!pinned) return; const t = setTimeout(() => setPinned(null), 60_000); return () => clearTimeout(t); }, [pinned]);
  // Guided walkthrough: opens by itself the first time this browser sees the desk, and from GUIDE any time.
  useEffect(() => { if (!isReplay && !tourSeen()) { const t = setTimeout(() => setTourOpen(true), 1800); return () => clearTimeout(t); } }, [isReplay]);

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
        if (!r.ok) {
          setErr({
            msg: r.status === 401 ? "Sign in to open the Command Center."
              : r.status === 402 ? "Your Command Center window has ended."
              : `The Command Center is not answering (${r.status}).`,
            code: r.status, at: Date.now(),
          });
          return;
        }
        const j = (await r.json()) as Live;
        if (!alive) return;
        setErr(null); setD(j); setGoodAt(Date.now());
      } catch {
        if (alive) setErr({ msg: "Can't reach the Command Center — check the connection.", code: null, at: Date.now() });
      } finally {
        if (alive) setRetrying(false);
      }
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
    const load = () => fetch("/api/command-center/context", { cache: "no-store" })
      .then(async (r) => { const j = await r.json().catch(() => ({})); return { ok: r.ok, j }; })
      .then(({ ok, j }) => { if (alive) setCtx({ rows: j.rows ?? [], history: j.history ?? [], at: j.at ?? null, error: ok ? (j.error ?? null) : (j.error ?? `unavailable`) }); })
      .catch(() => { if (alive) setCtx((c) => c ?? { rows: [], history: [], at: null, error: "unreachable" }); });
    load(); const id = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [isReplay]);

  // Chart candles: 5m from the live read, others from the worker's own bars (or aggregated in the replay).
  useEffect(() => {
    if (tf === "5m" || isReplay) return;
    let alive = true;
    const load = () => fetch(`/api/command-center/bars?tf=${tf}`, { cache: "no-store" }).then((r) => r.json())
      .then((j) => {
        if (alive && Array.isArray(j.bars)) setTfData({ tf, bars: j.bars as ChartBar[], at: typeof j.at === "number" ? j.at : null });
      }).catch(() => {});
    load(); const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [tf, isReplay]);
  const tfBars = tfData && tfData.tf === tf ? tfData.bars : [];
  const tfBarsAt = tfData && tfData.tf === tf ? tfData.at : null;

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

  // The headline price is the feed's (the freshest the screen has), else the read's; it flashes on a change.
  const headPrice = lf.feed.price ?? d?.price ?? null;
  useEffect(() => {
    const p = headPrice;
    if (p != null && lastPrice.current != null && p !== lastPrice.current) {
      setFlash(p > lastPrice.current ? "up" : "dn");
      const id = setTimeout(() => setFlash(null), 900);
      lastPrice.current = p;
      return () => clearTimeout(id);
    }
    lastPrice.current = p;
  }, [headPrice]);

  /* ── talking to ATLAS ─────────────────────────────────────────────────── */
  const onCall = lineOpen(vb.status);
  const voiceMode = orbVoiceOf(vb.activity);
  const voiceLevel = voiceMode === "speaking" ? vb.outLevel : voiceMode === "listening" ? vb.inLevel : 0;
  useEffect(() => {
    // A short two-note tone when the line comes up, one note when it drops — the desk telling you it heard.
    const live = vb.status === "listening";
    if (live && !wasOnCall.current) chime([660, 990]);
    if (!onCall && wasOnCall.current && vb.status !== "listening") chime([520]);
    wasOnCall.current = live || (onCall && wasOnCall.current);
  }, [vb.status, onCall]);

  const openTalk = useCallback((tab?: TalkTab) => {
    if (tab) setTalkTab(tab);
    if (stackedRef.current) setSheetOpen(true);
  }, []);
  const tapCore = useCallback(() => {
    if (isReplay) { openTalk("CHAT"); return; }
    if (lineOpen(voiceBus.get().status)) { voiceBus.end(); return; }
    openTalk("VOICE");
    if (voiceBus.get().status === "locked" || !voiceBus.ready()) return;
    voiceBus.start();     // inside the tap: Safari only lets audio begin from the gesture that asked for it
  }, [isReplay, openTalk]);
  const ask = useCallback((q: string) => { openTalk("CHAT"); setAskSignal({ n: Date.now(), q }); }, [openTalk]);
  const onActivity = useCallback((a: { busy: boolean; speaking: boolean; listening: boolean }) => setActivity(a), []);

  /* ── ATLAS's hands on the chart ───────────────────────────────────────── */
  const scrollToChart = useCallback(() => {
    if (!stackedRef.current) return;
    const el = chartPanelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.top > window.innerHeight * 0.35) el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  /** Show a piece of evidence, a trigger or a price on the chart — only as something real. */
  const pointAt = useCallback((t: PointTarget) => {
    const levels = levelsRef.current;
    const label = t.label.slice(0, 80);
    const ref = t.ref ?? null;
    if (ref) {
      if (ref.kind === "level") {
        const lv = levels.find((l) => levelIdOf(l) === ref.levelId);
        if (lv) dispatchChartAction({ type: "highlight_level", levelId: ref.levelId, price: lv.price, label: `${cap(lv.label)} ${fmt2(lv.price)}` });
        else setPinned({ price: ref.price, label });
      } else if (ref.kind === "zone") {
        dispatchChartAction({ type: "show_zone", from: Math.min(ref.from, ref.to), to: Math.max(ref.from, ref.to), label: ref.label || label });
      } else {
        const ctf = ref.tf as ChartTf;
        if ((CHART_TFS as readonly string[]).includes(ref.tf)) {
          dispatchChartAction({ type: "mark_candle", tf: ctf, t: ref.t, label: ref.kind === "swing" ? `Swing ${ref.type} ${fmt2(ref.price)}` : label });
          // The candle is on that timeframe: show it there (the chart draws it once its candles are loaded).
          if (ctf !== tfRef.current) setTf(ctf);
        }
      }
    } else if (t.price != null && Number.isFinite(t.price)) {
      const lv = levels.find((l) => Math.abs(l.price - (t.price as number)) < 0.06);
      if (lv) dispatchChartAction({ type: "highlight_level", levelId: levelIdOf(lv), price: lv.price, label: `${cap(lv.label)} ${fmt2(lv.price)}` });
      else setPinned({ price: t.price, label });
    }
    scrollToChart();
  }, [scrollToChart]);

  const showScenario = useCallback((id: string | null) => {
    dispatchChartAction({ type: "scenario", scenarioId: id });
    setSelectedScenario(id);
    if (id) scrollToChart();
  }, [scrollToChart]);

  // The screen's half of a chart action: the timeframe, and which scenario card is open. (GoldChart draws.)
  useEffect(() => {
    const on = (e: Event) => {
      const raw = (e as CustomEvent<unknown>).detail;
      const a = validateChartAction(raw, { levels: [], candles: {}, scenarios: [], price: null });
      if (a?.type === "timeframe") setTf(a.tf);
      const r = raw as { type?: unknown; scenarioId?: unknown } | null;
      if (r && r.type === "scenario") {
        const id = r.scenarioId == null ? null : String(r.scenarioId);
        if (id == null || scenariosRef.current.some((s) => s.id === id)) setSelectedScenario(id);
      }
      if (a?.type === "clear") setSelectedScenario(null);
      // Drawn while the sheet covers the chart: say so, with a way to look.
      if (r && r.type !== "timeframe" && r.type !== "clear" && stackedRef.current && sheetOpenRef.current) setChartPing(Date.now());
    };
    window.addEventListener(CHART_ACTION_EVENT, on);
    return () => window.removeEventListener(CHART_ACTION_EVENT, on);
  }, []);
  useEffect(() => { if (!chartPing) return; const t = setTimeout(() => setChartPing(null), 12_000); return () => clearTimeout(t); }, [chartPing]);

  /** The older [[UI: …]] vocabulary, still sent beside the structured answer. */
  const onUiAction = useCallback((name: string, arg: string | number | null) => {
    if (name === "FOCUS_TIMEFRAME") { const t = tfFromArg(arg); if (t) setTf(t); return; }
    if (name === "SHOW_LEVEL" || name === "MARK_CHART") {
      const range = name === "MARK_CHART" ? rangeFromArg(arg) : null;
      if (range) { dispatchChartAction({ type: "show_zone", from: range[0], to: range[1], label: "ATLAS" }); return; }
      const p = typeof arg === "number" ? arg : typeof arg === "string" && arg.trim() !== "" ? Number(arg.replace(/,/g, "")) : NaN;
      if (!Number.isFinite(p)) return;
      const lv = levelsRef.current.find((l) => Math.abs(l.price - p) < 0.06);
      if (lv) dispatchChartAction({ type: "highlight_level", levelId: levelIdOf(lv), price: lv.price, label: `${cap(lv.label)} ${fmt2(lv.price)}` });
      else if (name === "MARK_CHART") setPinned({ price: p, label: "ATLAS mark" });
      return;
    }
    if (name === "SHOW_TRADE") { setDrawer("trade"); return; }
    if (name === "SHOW_SCENARIO") {
      const list = scenariosRef.current;
      const key = arg == null ? "" : String(arg).toLowerCase();
      const dir = /^bull|^up/.test(key) ? "up" : /^bear|^down/.test(key) ? "down" : /^neutral|^range/.test(key) ? "range" : null;
      const sc = list.find((s) => s.id === String(arg)) ?? (dir ? list.find((s) => s.direction === dir && (s.status === "watching" || s.status === "developing")) : undefined);
      if (sc) { dispatchChartAction({ type: "scenario", scenarioId: sc.id }); setSelectedScenario(sc.id); }
      else document.querySelector("[data-tour='scenarios']")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    if (name === "SHOW_METRICS") {
      setIndicatorsOpen(true);
      window.setTimeout(() => document.querySelector("[data-tour='indicators']")?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
      return;
    }
    if (name === "OPEN_SETTINGS") { setProfileOpen(true); return; }
    if (name === "OPEN_BROKER") window.dispatchEvent(new CustomEvent("cc:open-broker"));
  }, []);

  // Escape closes the top-most of this screen's own overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menuOpen) setMenuOpen(false);
      else if (drawer) { setDrawer(null); setNav("OVERVIEW"); }
      else if (sheetOpen) setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, drawer, sheetOpen]);
  // The sheet only exists below 1280 px.
  useEffect(() => { if (!stacked) setSheetOpen(false); }, [stacked]);

  const announce = useMemo(() => {
    const st = d?.statements?.[0];
    const loud = d?.events?.find((e) => e.channel === "urgent" || e.channel === "voice");
    if (st && (!loud || st.at >= loud.at)) return { key: `s${st.at}`, text: st.text, urgent: st.channel === "urgent" };
    if (loud) return { key: loud.key, text: loud.detail, urgent: loud.channel === "urgent" };
    return null;
  }, [d]);

  const timelineRows: TimelineRow[] = useMemo(() => {
    const market: TimelineRow[] = (d?.events ?? []).map((e) => ({ key: e.key, at: e.at, text: e.detail, kind: eventKind(e.code), lean: e.lean, urgent: e.channel === "urgent" }));
    const pos: TimelineRow[] = (d?.trade?.events ?? []).map((e, i) => ({ key: `t${e.at}-${i}`, at: e.at, text: e.detail, kind: "trade", urgent: e.channel === "urgent" }));
    const said: TimelineRow[] = (vb.commentary ?? []).map((c) => ({ key: `c${c.id}`, at: c.at, text: c.text, kind: "atlas", spoken: c.spoken, tag: "ATLAS" }));
    return [...market, ...pos, ...said].sort((a, b) => b.at - a.at);
  }, [d?.events, d?.trade?.events, vb.commentary]);

  /* ── derived view state (display only) ─────────────────────────────────── */
  const intel = d?.intel ?? null;
  const thesis = d?.thesis ?? null;
  const trade = d?.trade;
  const setup = d?.setup ?? null;
  const read = d?.read ?? null;
  const profile = desk.profile ?? d?.profile ?? null;
  const alive = !!d?.connected && !!d?.marketOpen;
  const hardBlock = (d?.blockers ?? []).some((b) => b.code !== "market_closed");
  const orbState: OrbState = !alive ? "idle"
    : activity.speaking ? "speaking"
    : activity.busy ? "analyzing"
    : trade?.active ? "in_trade"
    : hardBlock || d?.brain?.presence === "high_news_risk" || d?.brain?.presence === "protecting_trade" ? "risk_event"
    : setup?.state === "armed" || setup?.state === "ready" ? "trade_ready"
    : setup?.state === "developing" ? "opportunity"
    : "watching";
  const accessEnded = err?.code === 401 || err?.code === 402;
  const talk = talkStateOf({ activity: vb.activity, lineOpen: onCall, chatBusy: activity.busy, replay: isReplay, accessEnded });
  const auto = automationOf({
    tradeActive: !!trade?.active, tradeSide: trade?.side ?? null,
    autoEntry: !!profile?.autoEntry, autoManagement: !!profile?.autoManagement, serverMode: d?.autopilotMode ?? null,
  });

  const feed = lf.feed;
  const feedCol = toneCol(FEED_TONE[feed.status]);
  const analysisAt = d?.analysis?.analysisAt ?? d?.at ?? null;
  const analysisAgeMs = isReplay || analysisAt == null || !now ? null : Math.max(0, now + lf.clockOffsetMs - analysisAt);
  const freshness = analysisAt != null
    ? `snapshot ${hhmmss(analysisAt)}${isReplay ? " (recorded)" : analysisAgeMs != null ? ` · ${ageShort(analysisAgeMs)} old` : ""}`
    : "no snapshot yet";
  const connection = feed.status === "demo" ? "Replay (recorded bars)"
    : lf.polling ? `Polling every ${FEED_POLL_MS / 1000} s`
    : lf.channel === "subscribed" ? "Stream connected"
    : lf.channel === "connecting" ? "Connecting to the stream"
    : lf.channel === "error" || lf.channel === "closed" ? "Reconnecting"
    : feed.transport === "snapshot" ? "Engine snapshot via /live"
    : "No push channel";
  const feedTitle = [
    `${FEED_STATUS_WORD[feed.status]} — ${feed.reason}`,
    feed.receivedTs != null ? `Received ${hhmmss(feed.receivedTs)}${feed.ageMs != null ? ` (${feedAgeWords(feed.ageMs)} ago)` : ""}` : "No price received yet",
    feed.providerTs != null ? `Provider time ${hhmmss(feed.providerTs)} (gold is stamped to the minute)` : "No provider timestamp",
  ].join("\n");
  const quoteAge = feed.status === "demo" ? "recorded" : feed.ageMs != null ? ageShort(feed.ageMs) : "—";

  const nyTime = now ? new Date(now).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }) : "--:--:--";
  const nyDate = now ? new Date(now).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) : "";

  const markers: ChartMarker[] = (d?.events ?? []).flatMap((e) => {
    const raw = e as unknown as Record<string, unknown>;
    const map: Record<string, string> = { STRUCTURE_BREAK: "BOS", STRUCTURE_RECLAIM: "Reclaim", LIQUIDITY_SWEEP: "Liquidity sweep", FAILED_BREAKOUT: "Failed break", BREAKOUT_CONFIRMED: "Breakout", RETEST_HOLDING: "Retest holding", RETEST_FAILING: "Retest failing" };
    const label = map[e.code]; if (!label) return [];
    return [{ at: e.at, price: evPrice(raw), label, tone: e.lean === "bearish" ? "down" : e.lean === "bullish" ? "up" : "gold" } as ChartMarker];
  })
    // One of each kind, newest first: three "Failed break" labels stacked on the same candles is noise.
    .filter((m, i, all) => all.findIndex((x) => x.label === m.label) === i)
    // And one answer per question: only the NEWEST of a contradicting pair is shown — that is the current read.
    .filter((m, i, all) => {
      const family = (l: string) => (/^Retest/.test(l) ? "retest" : /Breakout|Failed break/.test(l) ? "break" : l);
      return all.findIndex((x) => family(x.label) === family(m.label)) === i;
    })
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
  if (watchLines) {
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

  // Every blip is computed server-side in the read-only present layer, so the meaning shown is the same
  // sentence everywhere and nothing is invented in the browser.
  const blips: RadarBlip[] = (intel?.radar ?? []).map((b) => ({
    price: b.price, kind: b.kind, label: b.label, meaning: b.meaning, swept: b.swept, side: b.side, distance: b.distance,
  }));

  const tfWord = TF_BTNS.find((b) => b.id === tf)?.label ?? tf;
  const change = intel?.day.change ?? null;
  const spark = (d?.bars ?? []).slice(-60).map((b) => (b as ChartBar).c);

  const setupPill = trade?.active
    ? { text: `IN TRADE · ${trade.side?.toUpperCase()} ${trade.qty ?? ""} · ${trade.metrics ? `${trade.metrics.pips >= 0 ? "+" : ""}${Math.round(trade.metrics.pips)} pips` : ""}`, color: H.green }
    : setup?.side && setup.state !== "none" && setup.state !== "blocked"
      ? { text: `${setup.side.toUpperCase()} ${setup.style === "quick" ? "SCALP" : setup.style === "swing" ? "SWING" : "NORMAL"} · ${words(setup.state).toUpperCase()}`, color: H.gold2 }
      : null;

  const openAnalysis = (t: AnalysisTab) => { setAnalysisTab(t); setDrawer("analysis"); setNav("ANALYSIS"); setSheetOpen(false); };
  const goNav = (n: Nav) => {
    setNav(n); setMenuOpen(false);
    if (n === "ANALYSIS") { setAnalysisTab("journal"); setDrawer("analysis"); }
    else if (n === "SCANNERS") setDrawer("trade");
    else if (n === "STRATEGY") { if (!isReplay) setProfileOpen(true); }
    else if (n === "BACKTEST") window.location.href = "/command-center/replay";
    else if (n === "ALERTS") setDrawer("alerts");
    else if (n === "JOURNAL") setDrawer("journal");
    else setDrawer(null);
  };
  const closeDrawer = () => { setDrawer(null); setNav("OVERVIEW"); };
  const retry = () => { setRetrying(true); setReloadAt(Date.now()); };

  /* ── render ───────────────────────────────────────────────────────────── */
  return (
    <div className="hud-root w-full px-[10px] pb-[92px] pt-[8px] xl:pb-[10px]" style={{ background: `radial-gradient(1200px 500px at 12% -10%, rgba(0,199,232,0.06), transparent), radial-gradient(900px 500px at 100% 0%, rgba(213,169,61,0.05), transparent), ${H.bg0}`, color: H.text, fontFamily: "Inter, var(--font-inter), system-ui, sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: HUD_CSS + DESK }} />
      {tourOpen && <HudTour onClose={() => setTourOpen(false)} />}

      {/* ── HEADER ────────────────────────────────────────────────────── */}
      <header className="relative mb-[8px] flex h-[42px] shrink-0 items-center gap-2 sm:gap-3">
        <a href="/portal" className="flex shrink-0 items-center gap-2.5" aria-label="Back to the portal">
          <span className="grid h-9 w-9 place-items-center rounded-full" style={{ border: `1px solid ${H.lineHi}`, boxShadow: "0 0 12px rgba(0,199,232,0.25), inset 0 0 10px rgba(213,169,61,0.25)" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path d="M12 3 L21 20 H3 Z" fill="none" stroke={H.gold3} strokeWidth="1.6" /><circle cx="12" cy="14" r="2.2" fill={H.cyan2} /></svg>
          </span>
          <span className="hidden min-[1440px]:block">
            <span className="block text-[15px] font-semibold leading-none tracking-[0.06em]" style={{ color: H.text }}>COMMAND CENTER XAUUSD</span>
            <span className="mt-1 block text-[8.5px] font-medium tracking-[0.3em]" style={{ color: H.mut }}>THE ULTIMATE GOLD INTELLIGENCE MACHINE</span>
          </span>
          <span className="block text-[11.5px] font-semibold leading-[1.15] tracking-[0.06em] min-[1440px]:hidden" style={{ color: H.text }}>
            <span className="block">COMMAND CENTER</span>
            <span className="block" style={{ color: H.gold2 }}>XAUUSD</span>
          </span>
        </a>

        <nav data-tour="nav" className="hud-scroll mx-auto hidden h-full min-w-0 items-center gap-0.5 overflow-x-auto rounded-[10px] px-1.5 lg:flex" style={{ border: `1px solid ${H.line}`, background: "rgba(7,16,26,0.7)" }}>
          {NAV.map((n) => (
            <button key={n} onClick={() => goNav(n)}
              className="relative h-[30px] shrink-0 rounded-[7px] px-2.5 text-[9.5px] font-semibold tracking-[0.14em] transition min-[1440px]:px-3"
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

        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
          {/* Broker connect at every width: one instance, its modal rendered into <body> (BrokerBar). */}
          {!isReplay && <BrokerBar size="auto" />}
          {!isReplay && (
            <button onClick={() => setTourOpen(true)} className="hidden rounded-[7px] px-2.5 py-1.5 text-[9.5px] font-bold tracking-[0.14em] sm:block" title="A guided walk through every part of the Command Center"
              style={{ color: H.cyan2, border: "1px solid rgba(0,199,232,0.35)", background: "rgba(0,199,232,0.06)" }}>GUIDE</button>
          )}
          {!isReplay && (
            <button onClick={() => setCallOpen(true)} className="hidden rounded-[7px] px-2.5 py-1.5 text-[9.5px] font-bold tracking-[0.14em] md:block"
              style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.4)", background: "rgba(213,169,61,0.08)" }}>MANUAL</button>
          )}
          {/* The feed's own status: green LIVE only when a streamed tick arrived within seconds (core/feed.ts). */}
          <span data-feed-status={feed.status} title={feedTitle}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[8px] px-2 py-1.5 text-[10px] font-bold tracking-[0.12em] sm:px-3 sm:text-[11px]"
            style={{ color: feedCol, border: `1px solid ${feedCol}66`, background: `${feedCol}12` }}>
            {feed.status === "live" ? <LiveDot color={feedCol} /> : <span className="h-[6px] w-[6px] rounded-full" style={{ background: feedCol }} />}
            {FEED_STATUS_WORD[feed.status]}
          </span>
          {isReplay && <span className="rounded-[6px] px-2 py-1 text-[9.5px] font-bold tracking-[0.14em]" style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.45)" }}>REPLAY</span>}
          <span className="hidden text-right md:block">
            <span className="block text-[10px] tracking-[0.14em]" style={{ color: H.mut }}>NEW YORK <b className="ml-1 text-[13px] font-semibold tabular-nums tracking-normal" style={{ color: H.text }}>{nyTime}</b></span>
            <span className="block text-[9px]" style={{ color: H.mut2 }}>{nyDate}</span>
          </span>
          <span className="hidden text-[9.5px] font-semibold leading-tight tracking-[0.2em] min-[1800px]:block" style={{ color: H.mut }}>DISCIPLINE<br />CREATES FREEDOM.</span>
          <button onClick={() => setMenuOpen((x) => !x)} aria-label="Menu" aria-expanded={menuOpen} className="grid h-8 w-8 place-items-center rounded-[7px] lg:hidden"
            style={{ color: H.text, border: `1px solid ${H.line}` }}>{menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}</button>
        </div>

        {menuOpen && (
          <div className="hud-in absolute right-0 top-[46px] z-[46] w-[220px] rounded-[10px] p-1.5 lg:hidden" style={{ background: H.bg1, border: `1px solid ${H.lineHi}`, boxShadow: "0 16px 40px rgba(0,0,0,0.6)" }}>
            {NAV.map((n) => (
              <button key={n} onClick={() => goNav(n)} className="block w-full rounded-[6px] px-3 py-2 text-left text-[11px] font-semibold tracking-[0.14em]"
                style={{ color: nav === n ? H.gold3 : H.text }}>{n}</button>
            ))}
            {!isReplay && <button onClick={() => { setMenuOpen(false); setTourOpen(true); }} className="block w-full rounded-[6px] px-3 py-2 text-left text-[11px] font-semibold tracking-[0.14em]" style={{ color: H.cyan2 }}>GUIDE</button>}
            {!isReplay && <button onClick={() => { setMenuOpen(false); setCallOpen(true); }} className="block w-full rounded-[6px] px-3 py-2 text-left text-[11px] font-semibold tracking-[0.14em]" style={{ color: H.gold2 }}>MANUAL TRADE</button>}
          </div>
        )}
      </header>

      {/* ── THE STRIP: price · source · freshness · session · connection · automation ── */}
      <div data-tour="price" className="mb-[8px] shrink-0 overflow-hidden rounded-[10px]"
        style={{ background: `linear-gradient(180deg, ${H.panel2} 0%, ${H.panel} 100%)`, border: `1px solid ${H.lineHi}`, boxShadow: "0 0 22px rgba(0,199,232,0.06)" }}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-1.5 xl:flex-nowrap xl:gap-x-5">
          <div className="flex min-w-0 shrink-0 items-center gap-3">
            <span className="hidden sm:block"><GoldBars /></span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-[0.1em]" style={{ color: H.text }}>XAUUSD <span className="font-normal tracking-normal" style={{ color: H.mut }}>Gold spot / USD</span></p>
              <p className="flex items-baseline gap-2 whitespace-nowrap">
                <span data-price="" className={`text-[25px] font-semibold leading-none tabular-nums xl:text-[26px] ${flash === "up" ? "hud-flash-up" : flash === "dn" ? "hud-flash-dn" : ""}`} style={{ letterSpacing: "0.01em" }}>
                  {headPrice != null ? headPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
                </span>
                <span className="text-[11.5px] font-semibold tabular-nums" style={{ color: change == null ? H.mut : change >= 0 ? H.green : H.red }}
                  title="Change against the New York daily open, from the engine's levels">
                  {change == null ? "vs open —" : `${change >= 0 ? "▲ +" : "▼ "}${change.toFixed(2)} (${change >= 0 ? "+" : ""}${intel?.day.changePct?.toFixed(2)}%)`}
                </span>
              </p>
            </div>
          </div>
          <span className="hidden min-[1440px]:block"><Sparkline values={spark} color={change != null && change < 0 ? H.red : H.green} w={84} h={28} /></span>

          {/* phone: one compact line */}
          <p className="w-full text-[10.5px] leading-snug md:hidden" style={{ color: H.mut }} title={feedTitle}>
            {feed.provider} · {feed.quoteType} · <span style={{ color: feedCol }}>quote {quoteAge}</span> · analysis {isReplay ? "recorded" : analysisAgeMs != null ? `${ageShort(analysisAgeMs)} old` : "—"} · {words(d?.session)}
          </p>

          {/* tablet and desktop: labelled facts */}
          <div className="hidden min-w-0 flex-1 items-center gap-x-4 gap-y-1 md:flex md:flex-wrap xl:flex-nowrap xl:gap-x-5">
            <Fact k="Source" title={`${feed.provider} · ${feed.symbol} composite (${feed.quoteType}). A composite spot price — not a broker's executable bid or ask.`}
              v={<><span className="min-[1536px]:hidden">{feed.provider} · {feed.quoteType}</span><span className="hidden min-[1536px]:inline">{feed.provider} · {feed.symbol} composite ({feed.quoteType})</span></>} />
            <Fact k="Quote" title={feedTitle} v={<span style={{ color: feedCol }}>{feed.receivedTs != null && feed.status !== "demo" ? `${hhmmss(feed.receivedTs)} · ${quoteAge}` : quoteAge}</span>} />
            <Fact k="Analysis" title={`Which analysis everything else on the desk is: engine ${d?.analysis?.analysisVersion ?? "—"}${d?.analysis?.snapshotId != null ? `, snapshot #${d.analysis.snapshotId}` : ""}. A quote moves faster than a conclusion — the two carry their own times.`}
              v={analysisAt != null ? `${hhmmss(analysisAt)}${isReplay ? " · recorded" : analysisAgeMs != null ? ` · ${ageShort(analysisAgeMs)}` : ""}` : "—"} />
            <Fact k="Session" v={<>{cap(words(d?.session))}<span style={{ color: d?.marketOpen ? H.green : H.mut }}> · {d?.marketOpen === false ? "closed" : d?.marketOpen ? "open" : "—"}</span></>} />
            <Fact k="Connection" title={feed.reason} v={connection} />
            <div className="hidden min-[1536px]:block">
              <Fact k="Day H / L" v={intel?.day.high != null ? `${fmt2(intel.day.high)} / ${fmt2(intel.day.low)}` : "—"} title={intel?.day.range != null ? `Range ${fmt2(intel.day.range)}${d?.spread != null ? ` · spread ${fmt2(d.spread)}` : ""}` : undefined} />
            </div>
          </div>

          {/* automation — honest about what the screen can know */}
          <button data-tour="automation" onClick={() => (isReplay ? null : setProfileOpen(true))} title={`${auto.word} — ${auto.detail}. Opens risk, styles and automation.`}
            className="ml-auto inline-flex shrink-0 items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left transition hover:brightness-110"
            style={{ border: "1px solid rgba(255,216,117,0.45)", background: "linear-gradient(180deg, rgba(213,169,61,0.14), rgba(213,169,61,0.04))" }}>
            <Zap className="h-4 w-4 shrink-0" style={{ color: toneCol(auto.tone) }} />
            <span className="min-w-0">
              <span className="block text-[8px] font-semibold uppercase tracking-[0.16em]" style={{ color: H.mut }}>Automation</span>
              <span className="block whitespace-nowrap text-[10.5px] font-bold tracking-[0.08em]" style={{ color: toneCol(auto.tone) }} data-automation="">{auto.word}</span>
            </span>
          </button>
        </div>
      </div>

      {/* ── notices: replay, blockers, consent, and the in-place error banner ── */}
      {(isReplay || d?.reason || hardBlock || (consent && !consent.signed) || err) && (
        <div className="mb-[8px] flex shrink-0 flex-wrap gap-2">
          {err && (
            <div role="alert" data-error-banner="" className="flex w-full flex-wrap items-center gap-2 rounded-[8px] px-3 py-1.5 text-[11.5px]"
              style={{ border: `1px solid ${H.red}66`, background: "rgba(255,83,100,0.08)", color: H.text }}>
              <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: H.red }} />
              <span className="min-w-0 flex-1">
                <b style={{ color: H.red }}>{err.msg}</b>{" "}
                {d && goodAt
                  ? <span style={{ color: H.mut }}>Showing the last good read from {hhmmss(goodAt)}{now ? ` (${ageShort(now - goodAt)} ago)` : ""} — it is not updating.</span>
                  : <span style={{ color: H.mut }}>Nothing has loaded yet.</span>}
              </span>
              {err.code === 401 && <a href="/login" className="rounded-[6px] px-3 py-1 text-[10.5px] font-bold tracking-[0.1em]" style={{ color: H.gold3, border: "1px solid rgba(231,196,103,0.5)" }}>SIGN IN</a>}
              <button onClick={retry} disabled={retrying} className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1 text-[10.5px] font-bold tracking-[0.1em] disabled:opacity-60"
                style={{ color: H.gold3, border: "1px solid rgba(231,196,103,0.5)", background: "rgba(213,169,61,0.1)" }}>
                <RefreshCw className={`h-3 w-3 ${retrying ? "animate-spin" : ""}`} />{retrying ? "RETRYING…" : "RETRY"}
              </button>
            </div>
          )}
          {isReplay && <Notice color={H.gold2}>REPLAY — recorded XAUUSD stepped through the live engine. This is not the market.</Notice>}
          {!isReplay && (hardBlock || d?.reason) && <Notice color={H.gold2}>{d?.blockers?.[0]?.detail ?? d?.reason}</Notice>}
          {consent && !consent.signed && (
            <button onClick={() => setConsentOpen(true)}><Notice color={H.red}>{consent.stale ? "Risk disclosure updated — sign the new version to keep trading." : "Risk disclosure not signed — you can read the market and talk to ATLAS, but not trade. Tap to read and sign."}</Notice></button>
          )}
        </div>
      )}

      {/* ── MAIN GRID ─────────────────────────────────────────────────── */}
      <div className="hud-grid">
        {/* LEFT — the read, the timeframes, the levels */}
        <div className="hud-col hud-left">
          <ReadCard className="hud-read" read={read} analysisAt={analysisAt} analysisAgeMs={analysisAgeMs} replay={isReplay} onPoint={pointAt}
            onExplain={() => ask("Explain your current read in detail: what you think, why, what changed, what you're watching, what would invalidate it and what would strengthen it.")} />

          <HudPanel className="hud-tf" tour="tf" title="TIMEFRAME ALIGNMENT" icon={<Layers className="h-3.5 w-3.5" />}
            right={<span className="text-[9.5px] font-bold tracking-[0.14em]" style={{ color: intel?.alignment.bias === "BEARISH BIAS" ? H.red : intel?.alignment.bias === "BULLISH BIAS" ? H.green : H.gold2 }}>{intel?.alignment.bias ?? "NO READ"}</span>}
            bodyClass="flex flex-col px-3 pb-2">
            <div className="grid grid-cols-5 gap-1.5">
              {["1d", "4h", "1h", "15m", "5m"].map((k) => {
                const r = intel?.alignment.rows.find((x) => x.tf === k);
                const col = r ? (r.dir === "down" ? H.red : r.dir === "up" ? H.green : H.mut) : H.mut2;
                return (
                  <div key={k} title={r ? words(r.state) : "Not enough closed bars"} className="flex flex-col items-center justify-center rounded-[6px] py-1" style={{ border: `1px solid ${H.line}`, background: "rgba(3,7,11,0.5)" }}>
                    <p className="text-[11.5px] font-semibold">{k === "1d" ? "1D" : k.toUpperCase()}</p>
                    <p className="max-w-full truncate px-1 text-[9.5px]" style={{ color: col }}>{r?.word ?? "No read"}</p>
                    <p className="text-[12px] leading-none" style={{ color: col }}>{!r ? "·" : r.dir === "down" ? "⌄" : r.dir === "up" ? "⌃" : "—"}</p>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-center text-[8.5px] tracking-[0.14em]" style={{ color: H.mut }}>
              {intel ? `${intel.alignment.agree} OF ${intel.alignment.rows.length} AGREE · DISAGREEMENT SHOWN` : "STRONGER ALIGNMENT = CLEARER READ"}
            </p>
          </HudPanel>

          <HudPanel className="hud-levels" tour="levels" title="KEY LEVELS" icon={<Target className="h-3.5 w-3.5" />}
            right={<button onClick={() => setDrawer("alerts")} className="inline-flex items-center gap-1 rounded-[5px] px-2 py-[2px] text-[9px] font-bold tracking-[0.12em]" style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.45)" }}><Bell className="h-3 w-3" />ALERTS</button>}
            bodyClass="hud-scroll overflow-y-auto px-2 pb-2">
            {(intel?.keyLevels ?? []).map((l, i) => {
              const isPx = l.role === "price";
              const col = isPx ? H.gold3 : l.role === "invalidation" ? H.red : l.watched || l.role === "watch" ? H.gold2 : l.role === "resistance" ? "#E7A0A7" : "#9FE3C8";
              const isPinned = !isPx && pinned != null && Math.abs(pinned.price - l.price) < 0.01;
              return (
                <button key={i} type="button" title={isPx ? "The price at the last analysis" : "Mark this level on the chart"}
                  onClick={() => { if (!isPx) { setPinned(isPinned ? null : { price: l.price, label: cap(l.label) }); if (!isPinned) scrollToChart(); } }}
                  className="flex w-full items-center gap-3 rounded-[5px] px-2 py-[3px] text-left text-[11px] transition hover:brightness-125"
                  style={isPx
                    ? { border: `1px solid ${H.gold2}`, background: "rgba(213,169,61,0.1)", boxShadow: "0 0 10px rgba(213,169,61,0.2)" }
                    : isPinned ? { border: `1px solid ${H.cyan2}`, background: "rgba(0,199,232,0.08)" } : { border: "1px solid transparent" }}>
                  <span className="w-[66px] font-semibold tabular-nums" style={{ color: isPx ? H.gold3 : H.text }}>{fmt2(l.price)}</span>
                  <span className="min-w-0 flex-1 truncate" style={{ color: isPx ? H.gold3 : H.mut }} title={l.label}>{cap(l.label)}</span>
                  <span className="shrink-0 text-[10px]" style={{ color: isPinned ? H.cyan2 : col }}>{isPx ? "→" : isPinned ? "pinned" : l.watched || l.role === "watch" ? "● watch" : l.role === "invalidation" ? "✕ fails" : "•".repeat(Math.max(1, 4 - Math.min(3, Math.floor(Math.abs(l.price - (d?.price ?? l.price)) / Math.max(1, (intel?.volatility.atr ?? 5)))) ))}</span>
                </button>
              );
            })}
            {!intel?.keyLevels?.length && <p className="px-2 py-2 text-[11px]" style={{ color: H.mut }}>Levels appear with the first market read.</p>}
          </HudPanel>
        </div>

        {/* CENTRE — the chart, the indicators folded, the scenarios */}
        <div className="hud-col hud-center">
          <div ref={chartPanelRef} className="hud-chart min-h-0">
            <HudPanel tour="chart" hi className="h-full" bodyClass="flex h-full flex-col">
              <div ref={chartRef} className="flex h-full min-h-0 flex-col" style={{ background: H.panel }}>
                <div className="hud-scroll flex shrink-0 items-center gap-1 overflow-x-auto whitespace-nowrap border-b px-2 py-1.5" style={{ borderColor: H.lineSoft }}>
                  <div className="flex shrink-0 items-center gap-0.5 rounded-[7px] p-0.5" style={{ border: `1px solid ${H.line}` }} role="group" aria-label="Chart timeframe">
                    {TF_BTNS.map((b) => (
                      <button key={b.id} title={`${b.id} candles`} aria-pressed={tf === b.id}
                        onClick={() => setTf(b.id)}
                        className="rounded-[5px] px-2 py-1 text-[11px] transition sm:px-2.5"
                        style={{ color: tf === b.id ? H.gold3 : H.mut, border: tf === b.id ? "1px solid rgba(231,196,103,0.55)" : "1px solid transparent", background: tf === b.id ? "rgba(213,169,61,0.1)" : "transparent" }}>{b.label}</button>
                    ))}
                  </div>
                  <ToolBtn icon={<BarChart3 className="h-3.5 w-3.5" />} label="Watch lines" title="ATLAS's watched levels and the price its thesis fails at" on={watchLines} onClick={() => setWatchLines((x) => !x)} />
                  <ToolBtn icon={<Sparkles className="h-3.5 w-3.5" style={{ color: H.gold2 }} />} label="ATLAS overlays" title="Structure events and ATLAS's conditional path" on={overlays} onClick={() => setOverlays((x) => !x)} />
                  <ToolBtn icon={<Layers className="h-3.5 w-3.5" />} label="Liquidity zones" title="Candidate liquidity zones — inferred from structure, not an order book" on={liquidity} onClick={() => setLiquidity((x) => !x)} />
                  {setupPill && (
                    <button onClick={() => setDrawer("trade")} className="ml-1 inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-[6px] px-2 py-1 text-[9.5px] font-bold tracking-[0.08em] hud-in"
                      style={{ color: setupPill.color, border: `1px solid ${setupPill.color}`, background: "rgba(0,0,0,0.3)", boxShadow: `0 0 12px ${setupPill.color}55` }}>
                      <LiveDot color={setupPill.color} size={5} />{setupPill.text} ▸
                    </button>
                  )}
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <button aria-label="Atlas settings" title="Risk, styles and automation" onClick={() => !isReplay && setProfileOpen(true)} className="p-1" style={{ color: H.mut }}><Settings className="h-4 w-4" /></button>
                    <button aria-label="Fullscreen" title="Fullscreen chart" onClick={() => { const el = chartRef.current; if (el) void (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()); }} className="p-1" style={{ color: H.mut }}><Maximize2 className="h-4 w-4" /></button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 px-1 pt-1">
                  <GoldChart
                    bars={chartBars} price={d?.price ?? null} markers={markers} zones={zones} lines={lines}
                    path={pathPts} pathLabel={intel?.path?.label ?? "Atlas scenario"}
                    showOverlays={overlays} showLiquidity={liquidity}
                    tfLabel={`XAUUSD · ${tfWord}`}
                    activityLabel={chartBars.some((b) => b.v && b.v > 0) ? "Activity · tick volume" : "Activity · bar range (spot gold has no traded volume)"}
                    tf={tf} ticks={lf.recentTicks} feed={lf.feed}
                    barsAsOf={tf === "5m" || isReplay ? d?.at ?? null : tfBarsAt}
                    levels={d?.levels} scenarios={d?.scenarios}
                  />
                </div>
              </div>
            </HudPanel>
          </div>

          <IndicatorsPanel className="hud-ind" d={d} open={indicatorsOpen} onToggle={() => setIndicatorsOpen((x) => !x)} freshness={freshness} />

          <ScenarioCards className="hud-scen" scenarios={d ? d.scenarios ?? [] : null} selectedId={selectedScenario}
            onShow={showScenario} onPoint={pointAt} now={now} replay={isReplay} />
        </div>

        {/* RIGHT — the copilot (a sheet below 1280 px) */}
        <div className="hud-col hud-right">
          <HudPanel className={`hud-talk ${sheetOpen ? "is-open" : ""}`} tour={stacked && !sheetOpen ? undefined : "talk"} title="TALK WITH ATLAS" icon={<Mic className="h-3.5 w-3.5" />}
            right={
              <span className="flex items-center gap-2">
                <span data-talk-state={talk.tone} className="inline-flex items-center gap-1.5 text-[10px]" style={{ color: talk.tone === "live" ? H.green : talk.tone === "busy" ? H.cyan2 : talk.tone === "warn" ? H.gold2 : H.mut }}>
                  {talk.tone === "live" ? <LiveDot size={5} /> : <span className="h-[5px] w-[5px] rounded-full" style={{ background: talk.tone === "busy" ? H.cyan2 : talk.tone === "warn" ? H.gold2 : H.mut2 }} />}
                  {talk.label}
                </span>
                <button onClick={() => setSheetOpen(false)} aria-label="Close" className="grid h-7 w-7 place-items-center rounded-[6px] xl:hidden" style={{ color: H.mut, border: `1px solid ${H.line}` }}><X className="h-4 w-4" /></button>
              </span>
            }
            bodyClass="flex h-full flex-col">
            {/* the ATLAS core: tap to talk */}
            <div className="flex shrink-0 items-center gap-3 px-3 pb-2">
              <button type="button" onClick={tapCore} aria-label={onCall ? "End the conversation with ATLAS" : "Talk to ATLAS"} title={onCall ? "Tap to end" : "Tap to talk to ATLAS"}
                data-tour={stacked && !sheetOpen ? undefined : "core"} className="group relative grid shrink-0 cursor-pointer place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60">
                <BrainOrb state={voiceMode === "listening" || voiceMode === "muted" ? "listening" : voiceMode ? "speaking" : orbState}
                  intensity={d?.intensity ?? 0} alive={alive} pulseKey={read?.since ?? thesis?.id ?? null} size={82}
                  voice={voiceMode ? { mode: voiceMode, level: voiceLevel } : null} />
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold tracking-[0.2em]">ATLAS</p>
                {onCall ? (
                  <div className="hud-in">
                    <p className="text-[9px] font-bold tracking-[0.22em]" style={{ color: voiceMode === "listening" ? H.cyan2 : voiceMode === "muted" ? H.gold2 : H.gold3 }} data-voice-activity={vb.activity}>
                      {orbLabelOf(vb.activity)}<span style={{ color: H.mut }}> · TAP THE CORE TO END</span>
                    </p>
                    {vb.you && <p className="mt-0.5 line-clamp-1 text-[10.5px]" style={{ color: H.mut }}>You: &ldquo;{vb.you}&rdquo;</p>}
                    {vb.atlas && <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug" style={{ color: H.text }}>{vb.atlas}</p>}
                    {vb.error && <p className="mt-0.5 line-clamp-2 text-[10px]" style={{ color: H.red }}>{vb.error}</p>}
                  </div>
                ) : (
                  <>
                    <p className="text-[8.5px] tracking-[0.26em]" style={{ color: H.gold2 }}>GOLD INTELLIGENCE CORE</p>
                    {vb.error && vb.status !== "idle"
                      ? <p className="mt-0.5 line-clamp-2 text-[10px]" style={{ color: H.red }}>{vb.error}</p>
                      : <p className="mt-0.5 text-[10.5px]" style={{ color: H.mut }}>{isReplay ? "Voice is off in the replay — chat below." : "Tap the core to talk, or type below."}</p>}
                  </>
                )}
              </div>
            </div>
            {chartPing && stacked && sheetOpen && (
              <button onClick={() => { setChartPing(null); setSheetOpen(false); window.setTimeout(() => chartPanelRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 280); }}
                className="mx-3 mb-2 shrink-0 rounded-[7px] px-3 py-1.5 text-left text-[11px] font-semibold" style={{ color: H.cyan2, border: "1px solid rgba(39,215,242,0.45)", background: "rgba(0,199,232,0.08)" }}>
                ATLAS marked the chart — view it ▸
              </button>
            )}
            <div className="grid shrink-0 grid-cols-4 gap-1.5 px-3 pb-2">
              {(["CHAT", "VOICE", "ANALYSIS", "SETTINGS"] as TalkTab[]).map((t) => (
                <button key={t} onClick={() => setTalkTab(t)} className="rounded-[6px] py-1 text-[9.5px] font-semibold tracking-[0.14em]"
                  style={{ color: talkTab === t ? H.gold3 : H.mut, border: `1px solid ${talkTab === t ? "rgba(231,196,103,0.6)" : H.line}`, background: talkTab === t ? "rgba(213,169,61,0.12)" : "transparent", boxShadow: talkTab === t ? "0 0 10px rgba(213,169,61,0.2)" : "none" }}>{t}</button>
              ))}
            </div>
            <div className="min-h-0 flex-1 border-t" style={{ borderColor: H.lineSoft }}>
              {/* Chat stays mounted so a conversation survives switching tabs (and closing the sheet). */}
              <div className={talkTab === "CHAT" ? "h-full" : "hidden"}>
                <BrainConsole variant="hud" announce={announce} onUiAction={onUiAction} mode={mode} onModeChange={setMode} live={!!d?.live} askSignal={askSignal} onActivity={onActivity}
                  chartTf={tf}
                  seen={read ? { snapshotId: read.snapshotId, at: read.at, lean: read.lean } : d?.analysis ? { snapshotId: d.analysis.snapshotId, at: d.analysis.analysisAt } : null}
                  quick={[
                    { label: "What's your read?", q: "What's your read right now, why, and what would change it?" },
                    { label: "Run the scenarios", q: "Run through the scenarios: what's the base case, the alternative, and what would change your view?" },
                    { label: "Key levels", q: "What are the key levels above and below price right now, and which one matters most?" },
                    { label: "Where do timeframes disagree?", q: "What are the timeframes saying, and where do they disagree?" },
                    ...(intel?.structure.nextWatched != null ? [{ label: `Watch ${fmt2(intel.structure.nextWatched)}`, q: `Watch ${fmt2(intel.structure.nextWatched)} for me and tell me when price reaches it.` }] : []),
                  ]} />
              </div>
              {/* Always mounted, only hidden: the ATLAS core starts this line from anywhere on the screen. */}
              <div className={talkTab === "VOICE" ? "hud-scroll h-full overflow-y-auto p-2" : "hidden"}>
                {isReplay ? <p className="p-3 text-[12px]" style={{ color: H.mut }}>Voice is off in the replay.</p> : <VoiceSession onUiAction={onUiAction} live={d} />}
                <p className="px-2 pt-2 text-[10.5px]" style={{ color: H.mut }}>Prefer typing or quick push-to-talk? Use <button className="underline" onClick={() => setTalkTab("CHAT")} style={{ color: H.gold2 }}>Chat</button> — press space to speak there.</p>
              </div>
              {talkTab === "ANALYSIS" && (
                <div className="hud-scroll h-full space-y-3 overflow-y-auto p-3">
                  <LeanJournal items={d?.readHistory} compact />
                  <button onClick={() => openAnalysis("journal")} className="text-[10px] font-bold tracking-[0.12em]" style={{ color: H.gold2 }}>FULL ANALYSIS ▸</button>
                </div>
              )}
              {talkTab === "SETTINGS" && (
                <div className="hud-scroll h-full space-y-3 overflow-y-auto p-3">
                  <div>
                    <p className={LABEL} style={{ color: H.mut }}>Voice commentary — what ATLAS volunteers</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5" data-commentary-mode={vb.commentaryMode}>
                      {COMMENTARY_MODES.map((m) => (
                        <Chip key={m.id} active={vb.commentaryMode === m.id} title={m.hint} onClick={() => { if (!isReplay) voiceBus.setCommentary({ mode: m.id }); }}>{m.label}</Chip>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[11px] leading-snug" style={{ color: H.mut }}>{COMMENTARY_MODES.find((m) => m.id === vb.commentaryMode)?.hint}</p>
                    {isReplay && <p className="mt-1 text-[10.5px]" style={{ color: H.gold2 }}>Voice is off in the replay, so commentary can&apos;t be changed here.</p>}
                  </div>
                  <div style={{ opacity: vb.commentaryMode === "copilot" ? 1 : 0.5 }}>
                    <p className={LABEL} style={{ color: H.mut }}>Session copilot — at most one line every</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {COPILOT_COOLDOWNS_MS.map((ms) => (
                        <Chip key={ms} tone="cyan" active={vb.copilotCooldownMs === ms} onClick={() => { if (!isReplay) voiceBus.setCommentary({ copilotCooldownMs: ms }); }}
                          title={vb.commentaryMode === "copilot" ? undefined : "Applies in Session copilot mode"}>{ms < 60_000 ? `${ms / 1000} s` : `${ms / 60_000} min`}</Chip>
                      ))}
                    </div>
                  </div>
                  <div>
                    {/* The chat console is text only and always posts ATLAS's announcements; the one thing its mode
                        changes is a written read on a timer — so that is the only choice offered. */}
                    <p className={LABEL} style={{ color: H.mut }}>Scheduled written read in chat</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {BRIEFING_CHOICES.map((c) => (
                        <Chip key={c.id} active={mode === c.id} onClick={() => setMode(c.id)} title={VOICE_MODES.find((m) => m.id === c.id)?.hint}>{c.label}</Chip>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[11px]" style={{ color: H.mut }}>
                      {mode === "briefing_1m" || mode === "briefing_5m" ? `${VOICE_MODES.find((m) => m.id === mode)?.hint} Live market only.` : "Off — ATLAS writes when you ask, and posts its own alerts."}
                    </p>
                  </div>
                  {!isReplay && <button onClick={() => setProfileOpen(true)} className="rounded-[6px] px-3 py-1.5 text-[10px] font-bold tracking-[0.12em]" style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.45)" }}>RISK, STYLES & AUTOMATION ▸</button>}
                </div>
              )}
            </div>
          </HudPanel>
        </div>
      </div>

      {/* ── BOTTOM — the timeline, and the way into the deeper panels ── */}
      <div className="hud-bottom mt-[8px] grid gap-[8px] xl:grid-cols-[minmax(0,1fr)_268px]">
        <Timeline rows={timelineRows} className="hud-timeline" />
        <HudPanel tour="deeper" title="DEEPER ANALYSIS" icon={<BookOpen className="h-3 w-3" />} bodyClass="grid grid-cols-2 content-start gap-1.5 px-2.5 pb-2">
          {([
            ["journal", "Lean journal", <BookOpen key="j" className="h-3.5 w-3.5" />],
            ["liquidity", "Liquidity zones", <Radar key="l" className="h-3.5 w-3.5" />],
            ["structure", "Structure", <LineChart key="s" className="h-3.5 w-3.5" />],
            ["context", "Global context", <Globe2 key="c" className="h-3.5 w-3.5" />],
          ] as [AnalysisTab, string, ReactNode][]).map(([id, label, icon]) => (
            <button key={id} onClick={() => openAnalysis(id)} className="flex min-w-0 items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[10.5px] font-semibold transition hover:brightness-125"
              style={{ color: H.text, border: `1px solid ${H.line}`, background: "rgba(3,7,11,0.4)" }}>
              <span style={{ color: H.gold2 }}>{icon}</span><span className="truncate">{label}</span>
            </button>
          ))}
        </HudPanel>
      </div>

      {/* ── below 1280 px: the dock that opens the copilot ── */}
      {sheetOpen && <div className="fixed inset-0 z-[49] xl:hidden" style={{ background: "rgba(0,0,0,0.5)" }} onClick={() => setSheetOpen(false)} aria-hidden />}
      <div data-dock="" data-tour={stacked ? "dock" : undefined} className="fixed inset-x-0 bottom-0 z-[45] xl:hidden"
        style={{ background: "linear-gradient(180deg, rgba(5,11,17,0.92), rgba(3,7,11,0.98))", borderTop: `1px solid ${H.lineHi}`, paddingBottom: "env(safe-area-inset-bottom)", backdropFilter: "blur(8px)" }}>
        <div className="mx-auto flex max-w-[760px] items-center gap-2 px-3 py-2">
          <button onClick={() => openTalk("CHAT")} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-3 py-2 text-left"
            style={{ border: `1px solid ${H.line}`, background: "rgba(9,19,29,0.9)" }} aria-label="Talk to ATLAS">
            <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full" style={{ background: "radial-gradient(circle at 40% 35%, #FFD875, #8A5F12 70%)", boxShadow: `0 0 0 2px ${talk.tone === "live" ? "rgba(41,223,166,0.6)" : "rgba(39,215,242,0.35)"}, 0 0 10px rgba(255,216,117,0.4)` }}>
              <span className="h-2 w-2 rounded-full" style={{ background: "#FFF3D0" }} />
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-semibold" style={{ color: H.text }}>Talk to ATLAS</span>
              <span className="block truncate text-[10px]" style={{ color: talk.tone === "live" ? H.green : talk.tone === "warn" ? H.gold2 : H.mut }}>
                {onCall ? orbLabelOf(vb.activity).toLowerCase() : read ? `${leanLabel(read.lean)} · ${talk.label.toLowerCase()}` : talk.label.toLowerCase()}
              </span>
            </span>
          </button>
          <button onClick={tapCore} aria-label={onCall ? "End the voice line" : "Talk to ATLAS by voice"}
            className="relative grid h-12 w-12 shrink-0 place-items-center rounded-full"
            style={{ background: "radial-gradient(circle at 40% 35%, #3A2C0C, #120D04)", border: `2px solid ${onCall ? "#FFD875" : "#D5A93D"}`, color: "#FFD875", boxShadow: onCall ? "0 0 0 5px rgba(255,216,117,0.12), 0 0 22px rgba(255,216,117,0.5)" : "0 0 14px rgba(213,169,61,0.35)" }}>
            {onCall && <span className="hud-ping absolute inset-0 rounded-full" style={{ border: "1px solid #FFD875" }} />}
            {onCall ? <X className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* ── DRAWERS (trade / analysis / alerts / journal) ─────────────── */}
      {drawer && (
        <div className="fixed inset-0 z-[55] flex justify-end" style={{ background: "rgba(0,0,0,0.45)" }} onClick={closeDrawer}>
          <aside className="hud-scroll hud-in h-full w-full max-w-[620px] overflow-y-auto p-3" style={{ background: H.bg1, borderLeft: `1px solid ${H.lineHi}` }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[12px] font-bold tracking-[0.16em]" style={{ color: H.gold2 }}>{drawer === "trade" ? "ATLAS'S TRADE" : drawer === "analysis" ? "ANALYSIS" : drawer === "alerts" ? "ALERTS & WATCHES" : "TODAY'S ATLAS"}</p>
              <button onClick={closeDrawer} aria-label="Close" style={{ color: H.mut }}><X className="h-5 w-5" /></button>
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
            {drawer === "analysis" && (
              <div>
                <div className="mb-3 flex flex-wrap gap-1.5" role="tablist">
                  {ANALYSIS_TABS.map((t) => (
                    <button key={t.id} role="tab" aria-selected={analysisTab === t.id} onClick={() => setAnalysisTab(t.id)} className="rounded-[6px] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em]"
                      style={{ color: analysisTab === t.id ? H.gold3 : H.mut, border: `1px solid ${analysisTab === t.id ? "rgba(231,196,103,0.6)" : H.line}`, background: analysisTab === t.id ? "rgba(213,169,61,0.12)" : "transparent" }}>{t.label}</button>
                  ))}
                </div>
                {analysisTab === "journal" && (
                  <div className="space-y-4">
                    <div>
                      <p className={LABEL} style={{ color: H.gold2 }}>The lean, over time</p>
                      <p className="mb-2 mt-0.5 text-[11px]" style={{ color: H.mut }}>Every change of ATLAS&apos;s lean, newest first, with the reason the rules allowed it. Entries are never rewritten.</p>
                      <LeanJournal items={d?.readHistory} />
                    </div>
                    <div className="rounded-[8px] p-3" style={{ border: `1px solid ${H.line}` }}>
                      <p className={LABEL} style={{ color: H.gold2 }}>Engine thesis</p>
                      <p className="mb-2 mt-0.5 text-[11px]" style={{ color: H.mut }}>The working view the setup engine reads. It is computed separately from the lean above.</p>
                      <ThesisExplainer d={d} onAsk={(q) => { closeDrawer(); ask(q); }} full />
                    </div>
                  </div>
                )}
                {analysisTab === "liquidity" && (
                  <LiquidityPanel d={d} blips={blips} alive={alive} liquidity={liquidity} onToggleLiquidity={() => setLiquidity((x) => !x)}
                    pinned={pinned} onPin={(p) => { setPinned(p); if (p) { closeDrawer(); scrollToChart(); } }} freshness={freshness} />
                )}
                {analysisTab === "structure" && <StructurePanel d={d} bars={chartBars} freshness={freshness} />}
                {analysisTab === "context" && <ContextPanel ctx={ctx} replay={isReplay} news={intel?.news ?? null} />}
              </div>
            )}
            {drawer === "alerts" && (
              <div className="space-y-2">
                {d?.watches?.length ? d.watches.map((w) => (
                  <div key={w.id} className="rounded-[8px] p-3" style={{ border: `1px solid ${H.line}` }}>
                    <p className="text-[12.5px]">{w.label ?? (w.price != null ? fmt2(w.price) : words(w.kind))} <span style={{ color: H.mut }}>· {words(w.kind)}</span></p>
                    <p className="mt-0.5 text-[11px]" style={{ color: H.mut }}>&ldquo;{w.said}&rdquo;</p>
                    <div className="mt-2 h-[3px] overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.07)" }}><div className="h-full" style={{ width: `${Math.round((w.progress ?? 0) * 100)}%`, background: H.gold2 }} /></div>
                  </div>
                )) : <p className="text-[12px]" style={{ color: H.mut }}>No alerts armed. Ask ATLAS to watch a level — &ldquo;watch 4,360 for me&rdquo; — and it appears here.</p>}
                <button onClick={() => { closeDrawer(); ask("What level should I have you watch right now, and why?"); }} className="mt-2 rounded-[6px] px-3 py-1.5 text-[10px] font-bold tracking-[0.12em]" style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.45)" }}>ASK WHAT TO WATCH ▸</button>
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
                <button onClick={() => openAnalysis("journal")} className="mt-3 text-[10px] font-bold tracking-[0.12em]" style={{ color: H.gold2 }}>THE LEAN JOURNAL ▸</button>
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

function Fact({ k, v, title }: { k: string; v: ReactNode; title?: string }) {
  return (
    <div className="min-w-0 shrink-0" title={title}>
      <p className="text-[8px] font-semibold uppercase tracking-[0.16em]" style={{ color: H.mut }}>{k}</p>
      <p className="mt-0.5 truncate whitespace-nowrap text-[11.5px] font-semibold tabular-nums" style={{ color: H.text }}>{v}</p>
    </div>
  );
}

/** The lean's history: when it changed, to what, and the reason the rules allowed it. */
function LeanJournal({ items, compact = false }: { items: Live["readHistory"]; compact?: boolean }) {
  if (!items?.length) return <p className="text-[12px]" style={{ color: H.mut }}>No lean changes recorded yet.</p>;
  const today = new Date().toDateString();
  return (
    <ol className="space-y-1.5" data-lean-journal="">
      {items.map((h, i) => {
        const col = toneCol(LEAN_TONE[h.lean] ?? "mut");
        const dt = new Date(h.at);
        return (
          <li key={`${h.at}-${i}`} className="rounded-[7px] px-2.5 py-2" style={{ border: `1px solid ${i === 0 ? `${col}66` : H.lineSoft}`, background: i === 0 ? `${col}0D` : "transparent" }}>
            <p className="flex flex-wrap items-center gap-2">
              <span className="text-[10.5px] tabular-nums" style={{ color: H.mut }}>{dt.toDateString() === today ? hhmm(h.at) : dt.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</span>
              <span className="rounded-[4px] px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-[0.1em]" style={{ color: col, border: `1px solid ${col}66` }}>{leanLabel(h.lean)}</span>
              {i === 0 && <span className="text-[9px]" style={{ color: H.mut2 }}>current</span>}
            </p>
            {h.reason && <p className="mt-1 text-[11.5px] leading-snug" style={{ color: H.text }}>{h.reason}</p>}
            {!compact && h.summary && <p className="mt-0.5 text-[11px] leading-snug" style={{ color: H.mut }}>{h.summary}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/** The engine thesis translated: what, why, what changed, watching, what invalidates, what strengthens. */
function ThesisExplainer({ d, onAsk, full = false }: { d: Live | null; onAsk: (q: string) => void; full?: boolean }) {
  const t = d?.thesis;
  if (!t) return <p className="text-[12px]" style={{ color: H.mut }}>No engine thesis yet — ATLAS is still building one.</p>;
  const p5 = d?.changes?.find((c) => c.horizon === "5m");
  const rows: [string, ReactNode][] = [
    ["What it reads", <><b>{t.label.toUpperCase()}</b> <span style={{ color: H.mut }}>· {t.strength} · conviction {t.confidence}/100 (not a win probability)</span></>],
    ["Why", <ul className="space-y-0.5">{[...t.reasonStarted, ...t.reasonStrengthened].slice(0, 5).map((r, i) => <li key={i}>— {r}</li>)}</ul>],
    ["What changed", d?.previousThesis?.reasonEnded ? `Before this it read ${d.previousThesis.label.toLowerCase()}, until ${d.previousThesis.reasonEnded}.` : p5 ? `Pressure (derived) ${p5.pressureFrom} → ${p5.pressureTo} over five minutes; price ${p5.priceMove >= 0 ? "+" : ""}${p5.priceMove.toFixed(2)}.` : "Nothing material in the last few minutes."],
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

/** A short tone from the Web Audio API — no files. Quiet on purpose; it confirms, it doesn't announce. */
function chime(freqs: number[]) {
  try {
    const W = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctx = W.AudioContext ?? W.webkitAudioContext; if (!Ctx) return;
    const ctx = new Ctx(); const t = ctx.currentTime;
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.11); g.gain.linearRampToValueAtTime(0.06, t + i * 0.11 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.11 + 0.25);
      o.connect(g); g.connect(ctx.destination); o.start(t + i * 0.11); o.stop(t + i * 0.11 + 0.3);
    });
    window.setTimeout(() => { void ctx.close().catch(() => {}); }, 900);
  } catch { /* no audio — the orb still says it */ }
}

/** A chart toggle: an icon with its name beside it on wide screens, and as its accessible name everywhere. */
function ToolBtn({ icon, label, on, onClick, title }: { icon: ReactNode; label: string; on: boolean; onClick?: () => void; title?: string }) {
  return (
    <button onClick={onClick} title={title ?? label} aria-label={label} aria-pressed={on}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-[6px] px-2 py-1 text-[11px] transition"
      style={{ color: on ? H.text : H.mut, border: `1px solid ${on ? H.line : "transparent"}`, background: on ? "rgba(89,175,255,0.06)" : "transparent" }}>
      {icon}<span className="hidden min-[1600px]:inline">{label}</span>
    </button>
  );
}

function Notice({ children, color }: { children: ReactNode; color: string }) {
  return <span className="inline-block rounded-[6px] px-3 py-1.5 text-left text-[11.5px]" style={{ color, border: `1px solid ${color}55`, background: `${color}10` }}>{children}</span>;
}

function GoldBars() {
  return (
    <svg width="40" height="30" viewBox="0 0 44 32" aria-hidden>
      <defs><linearGradient id="gb" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#FFE9A8" /><stop offset=".5" stopColor="#E0AE3F" /><stop offset="1" stopColor="#8A5E14" /></linearGradient></defs>
      <path d="M6 30 L10 20 H24 L28 30 Z" fill="url(#gb)" /><path d="M20 30 L24 20 H38 L42 30 Z" fill="url(#gb)" /><path d="M13 19 L17 9 H31 L35 19 Z" fill="url(#gb)" />
      <path d="M17 9 H31" stroke="#FFF3CF" strokeWidth=".8" />
    </svg>
  );
}

export default CommandCenterHud;
