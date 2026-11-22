"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bitcoin, Gem, TrendingUp, Globe, BarChart3, Zap, X, ChevronLeft, Loader2, Check,
  ArrowUp, ArrowDown, Target, ShieldAlert, Sparkles, Clock, Minus, RefreshCw, Trash2,
  Activity, Eye, Ban, Search, ChevronDown, ChevronRight, MoreHorizontal,
} from "lucide-react";
import { MARKETS, findAsset, type Market, type Asset } from "@/data/signalAssets";
import { earnMission } from "@/lib/earnMission";
import { CREDIT_COST } from "@/lib/creditConfig";
import { statsSince } from "@/lib/statsClock";
import { DeepDiveModal } from "./floor/DeepDive";
import { CopyAllBtn, buildTradeText } from "./copykit";
import { TradeChat } from "./TradeChat";
import { Levels } from "./quantUi";
import { useNextShell } from "@/components/om/shell";
import { PlayDetail } from "@/components/om/plays/PlayDetail";
import { analysisOf, trackingOf, playPip } from "@/lib/plays/lifecycle";
import { takeGenerateIntent } from "@/lib/plays/intent";
import { openAtlas } from "@/lib/atlas/open";
import { mergeSavedPlays, SIGNALS_UPDATED_EVENT } from "@/lib/atlas/signals";
import { pairName, priceFor, lotsText } from "@/lib/flow/display";
import { accountName, maskAccount, money } from "@/lib/floor/overview";
import type { PlacementSize } from "@/lib/flow/ticketSizing";
import { ProductIcon } from "@/components/om/ProductIcon";
import "@/components/om/plays/plays-mobile.css";

const MARKET_ICON: Record<Market["id"], typeof Bitcoin> = { crypto: Bitcoin, metal: Gem, stock: TrendingUp, forex: Globe, index: BarChart3 };
const MARKET_TINT: Record<Market["id"], string> = { crypto: "text-orange-400", metal: "text-amber-300", stock: "text-emerald-400", forex: "text-sky-400", index: "text-violet-400" };

type Method = "best" | "smc" | "structure";
const METHODS: { k: Method; label: string; sub: string }[] = [
  { k: "best", label: "Best", sub: "OM AI's optimal mix" },
  { k: "smc", label: "Smart Money", sub: "ICT / SMC" },
  { k: "structure", label: "Structure", sub: "Market structure" },
];
const CONFS: { k: string; label: string }[] = [
  { k: "structure", label: "Market Structure" },
  { k: "ob", label: "Order Blocks" },
  { k: "fvg", label: "Fair Value Gaps" },
  { k: "liquidity", label: "Liquidity Sweeps" },
  { k: "sr", label: "Support / Resistance" },
  { k: "trend", label: "Trend (MAs)" },
  { k: "rsi", label: "RSI Momentum" },
  { k: "fib", label: "Fib / OTE" },
  { k: "breakRetest", label: "Break & Retest" },
  { k: "volume", label: "Volume" },
];
const METHOD_DEFAULTS: Record<Method, string[]> = {
  best: ["trend", "structure", "fvg", "liquidity", "sr", "fib", "breakRetest", "rsi"],
  smc: ["structure", "ob", "fvg", "liquidity", "breakRetest"],
  structure: ["structure", "sr", "trend", "breakRetest"],
};

type Candle = { t: string; o: number; h: number; l: number; c: number };
type Signal = {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  entry: number; stopLoss: number; takeProfits: number[];
  confidence: string; riskReward: string; timeframe: string; rationale: string; invalidation: string;
  setup?: string; bias?: string; poi?: string; liquidityTarget?: string;
  checklist?: { label: string; ok: boolean }[]; confirmed?: number; total?: number;
  // Scalp multi-timeframe extras (present only on scalp plays).
  flow?: { h4: string; h1: string; dir: string; aligned: boolean };
  timeframes?: { tf: string; trend: string; confirmed: number; total: number; checklist: { label: string; ok: boolean }[]; unavailable?: boolean }[];
  verdict?: string;
  // Institutional confirmation gate (Phase 1): the setup only releases as a
  // trade once the market confirms; otherwise status is "no_trade" (waiting).
  status?: "setup" | "no_trade"; grade?: "A+" | "A" | "B" | "C" | "D" | null; gate_score?: number;
  gate_decision?: "TRADE" | "NO_TRADE"; no_trade_reason?: string;
  mode?: "institutional" | "accelerator"; momentum_rating?: string; trend_rating?: string;
  // Chase guard: set when live price has run so far past the ideal limit entry
  // that a retest is no longer worth taking (price truly left).
  chased?: boolean; ran_r?: number; chase_note?: string; live_price?: number; as_of?: string;
};
type Status = "open" | "win" | "loss";
// Live "Get Update" snapshot for an open call — computed server-side in code and
// explained in plain English. Every number here is locked by the engine.
type TradeUpdate = {
  headline: string; thesis: "intact" | "weakening" | "invalidated"; price: number;
  pnl: { r: number; pips: number; side: string; percent: number };
  distance: { to_stop_pips: number; to_next_target_pips: number; next_target_label: string };
  market?: { flow_1h?: string; flow_4h?: string; rsi?: number | null };
  explanation: string[]; what_to_watch: string;
};
type Result = {
  id: number; symbol: string; name: string; market: string; td: string; interval: string;
  orderType: string; style?: string; method?: string; price: number; asOf: string; as_of?: string; live_price?: number; marketClosed?: boolean;
  signal: Signal; candles?: Candle[]; status: Status;
  hitTp?: number; hitAt?: string;   // which take-profit filled (1|2|3) on a win
  createdAt?: string;               // when the server saved it (sent by /api/signals)
};

const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/** When a play was made: its id is that moment for one made on this page; a play saved another way (the
 *  phone app's "I took this trade" keys it by symbol and price) goes by when the server saved it. */
const madeAt = (r: Result): number => {
  const n = Number(r.id);
  if (Number.isFinite(n) && n > 1e12) return n;
  const saved = Date.parse(r.createdAt ?? "");
  return Number.isFinite(saved) ? saved : Date.parse(r.asOf ?? "");
};
const fmt = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "—";
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  const d = Math.abs(x) >= 1000 ? 2 : Math.abs(x) >= 1 ? 4 : 6;
  return x.toLocaleString(undefined, { minimumFractionDigits: d > 2 ? 2 : d, maximumFractionDigits: d });
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Pip size per instrument class, so we can total the pips a winning trade caught.
// FX standard = 0.0001, JPY pairs = 0.01, gold = 0.1 ($1 = 10 pips), silver = 0.01,
// crypto & index CFDs are quoted in points (treat 1 point = 1 pip). The rule lives in lib/plays/lifecycle.ts.
const pipSize = playPip;
// Pips captured on a winning trade: entry → the take-profit that filled (fallback TP1).
const winPips = (r: Result): number => {
  const entry = r.signal?.entry;
  const tps = r.signal?.takeProfits || [];
  const tp = (typeof r.hitTp === "number" ? tps[r.hitTp - 1] : undefined) ?? tps[0];
  if (!numOk(entry) || !numOk(tp)) return 0;
  return Math.abs(tp - entry) / pipSize(r.symbol);
};
const GEN_STEPS = ["Connecting to market data…", "Fetching live candles…", "Mapping structure & liquidity…", "Checking confirmations…", "Generating trade signal…"];
/** Markets to start from in the new shell, after the member's own recent ones. A choice offered, never one made. */
const POPULAR = ["XAU/USD", "EUR/USD", "GBP/USD", "USD/JPY", "NAS100", "BTC/USD"];

export function SignalGenerator() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"market" | "asset" | "config" | "loading" | "result" | "error">("market");
  const [market, setMarket] = useState<Market | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [orderType, setOrderType] = useState<"market" | "limit">("limit");
  const [style, setStyle] = useState<"scalp" | "intraday" | "swing">("intraday");
  const [method, setMethod] = useState<Method>("best");
  const [mode, setMode] = useState<"institutional" | "accelerator">("institutional");
  const [confs, setConfs] = useState<string[]>(METHOD_DEFAULTS.best);
  const [genStep, setGenStep] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [recent, setRecent] = useState<Result[]>([]);
  const [checking, setChecking] = useState<number | null>(null);
  const [dive, setDive] = useState<Result | null>(null);
  const [updating, setUpdating] = useState<number | null>(null);
  const [updates, setUpdates] = useState<Record<number, TradeUpdate>>({});
  const [needCredits, setNeedCredits] = useState(false);
  // The header's win rate counts plays made since the record reset (owner 10-11: "please reset all the
  // stats on the platform"). The server sends the clock it runs on; until then, the one built into the page.
  const [sinceMs, setSinceMs] = useState(() => Date.parse(statsSince()));
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const backfilled = useRef<Set<number>>(new Set());
  // The trading platform's shell draws this tool as a workspace (below); these are that view's own choices.
  const next = useNextShell();
  const [find, setFind] = useState("");
  const [picking, setPicking] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [show, setShow] = useState<"all" | Status>("all");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    try { const raw = localStorage.getItem("om_signals"); if (raw) setRecent(JSON.parse(raw)); } catch { /* ignore */ }
  }, []);

  // An Atlas play is this tool's play too. The browser's storage event does not fire in this same tab.
  useEffect(() => {
    const generated = (event: Event) => {
      const play = (event as CustomEvent<{ play?: Result }>).detail?.play;
      if (play?.id != null && play.signal) setRecent((current) => mergeSavedPlays(current, [play]));
    };
    window.addEventListener(SIGNALS_UPDATED_EVENT, generated);
    return () => window.removeEventListener(SIGNALS_UPDATED_EVENT, generated);
  }, []);

  // Auto-generate the full play when opened from a deep link, e.g. the Market
  // Pulse scanner's "Generate the full play": /portal/signals?td=BTC/USD&style=intraday
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const td = q.get("td");
    if (!td) return;
    const found = findAsset(td);
    if (!found) return;
    const st = q.get("style");
    if (st === "scalp" || st === "intraday" || st === "swing") setStyle(st);
    setMarket(found.market); setAsset(found.asset); setOpen(true);
    // Strip the consumed td/style from the CURRENT path (works on /portal/signals, the
    // portal Floor, and the standalone floor.weare1mission.com — never hard-code a path).
    // Keep the Floor's ?view= param so the workspace stays on the OM AI Plays tab.
    try {
      const keepView = q.get("view");
      window.history.replaceState({}, "", window.location.pathname + (keepView ? `?view=${encodeURIComponent(keepView)}` : ""));
    } catch { /* ignore */ }
    // THE NEW SHELL (owner 11-21 brief §9): an address only fills in the market and style. A play is generated on
    // arrival only for the member's own fresh intent — left by a button that said the price — and only once
    // (lib/plays/intent.ts). A refresh, Back, a remount or a shared address therefore charges nothing. The same
    // holds in the classic view for an address that says so — "open=1" (fill in only) or "generate=<nonce>" —
    // as Atlas's links do; the classic Market Pulse button, which carries neither, generates as it always has.
    const gen = q.get("generate"), openOnly = q.get("open") === "1";
    if (next || gen || openOnly) {
      if (openOnly && !gen) return;
      let mine = false;
      try { mine = takeGenerateIntent(window.sessionStorage, gen, td); } catch { mine = false; }
      if (!mine) return;
    }
    void generate(found.asset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // When an already-won card is opened but was recorded before we tracked which
  // TP filled, quietly re-evaluate once to backfill the hit level so the card
  // can show it. (The check isn't credit-gated, so this costs the member nothing.)
  useEffect(() => {
    if (!result || result.status !== "win" || result.hitTp != null) return;
    if (result.signal?.direction === "NEUTRAL") return;
    if (backfilled.current.has(result.id)) return;
    backfilled.current.add(result.id);
    void checkResult(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.id, result?.status]);

  function persist(next: Result[]) { setRecent(next); try { localStorage.setItem("om_signals", JSON.stringify(next.slice(0, 20))); } catch { /* ignore */ } }

  // Cloud sync — signals are saved server-side so they follow the member across
  // every device and survive a cleared browser. localStorage stays as an instant
  // local cache; these calls fail quietly when offline.
  async function cloudSave(items: Result[]) {
    if (!items.length) return;
    try { await fetch("/api/signals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signals: items }) }); } catch { /* offline */ }
  }
  async function cloudDelete(id: number) {
    try { await fetch(`/api/signals?id=${encodeURIComponent(String(id))}`, { method: "DELETE" }); } catch { /* offline */ }
  }

  // On open, pull the member's signals from the server (source of truth) and, the
  // first time, migrate anything already saved only in this browser up to the cloud.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/signals", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const d = await res.json().catch(() => ({}));
        if (typeof d.since === "string" && Number.isFinite(Date.parse(d.since))) setSinceMs(Date.parse(d.since));
        const cloud: Result[] = Array.isArray(d.signals) ? d.signals : [];
        let local: Result[] = [];
        try { const raw = localStorage.getItem("om_signals"); if (raw) local = JSON.parse(raw); } catch { /* ignore */ }
        if (cancelled) return;
        if (cloud.length) {
          const seen = new Set(cloud.map((r) => r.id));
          const extras = local.filter((r) => r && !seen.has(r.id));
          const merged = [...cloud, ...extras].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 20);
          // An Atlas read may finish while this initial cloud request is in flight. Keep that new
          // in-memory result even when this browser has disabled local storage; cloud wins matching ids.
          setRecent((current) => {
            const combined = mergeSavedPlays(current, merged);
            try { localStorage.setItem("om_signals", JSON.stringify(combined)); } catch { /* keep it in memory */ }
            return combined;
          });
          if (extras.length) void cloudSave(extras);
        } else if (local.length) {
          void cloudSave(local); // first run with cloud storage — back up this device's signals
        }
      } catch { /* offline — keep the local cache */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickMethod(m: Method) { setMethod(m); setConfs(METHOD_DEFAULTS[m]); }
  function toggleConf(k: string) { setConfs((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k])); }
  function reset() {
    setStep("market"); setMarket(null); setAsset(null); setOrderType("limit"); setStyle("intraday");
    setMethod("best"); setConfs(METHOD_DEFAULTS.best); setResult(null); setErrorMsg(""); setGenStep(0);
  }
  function close() { if (timer.current) clearInterval(timer.current); setOpen(false); }

  async function generate(a: Asset | null = asset) {
    if (!a) return;
    setStep("loading"); setGenStep(0); setErrorMsg(""); setNeedCredits(false);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => setGenStep((s) => Math.min(s + 1, GEN_STEPS.length - 1)), 700);
    try {
      const [res] = await Promise.all([
        fetch("/api/om-signal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ td: a.td, orderType, style, method, confirmations: confs, mode }) }),
        delay(3000),
      ]);
      if (timer.current) clearInterval(timer.current);
      const data = await res.json().catch(() => ({}));
      if (data.notConfigured === "marketdata") { setErrorMsg("Live market data isn't connected yet — add a TWELVEDATA_API_KEY in Vercel and I'll pull real prices."); setStep("error"); return; }
      if (data.notConfigured === "ai") { setErrorMsg("OM AI isn't switched on yet — the Anthropic key is missing."); setStep("error"); return; }
      if (data.error === "ratelimit") { setErrorMsg(data.detail || "You've hit the free market-data limit (8 requests a minute). Give it about a minute, then generate again."); setStep("error"); return; }
      if (data.error === "system_busy") { setErrorMsg(data.detail || "The data desk is at capacity for a moment — try again in a few seconds."); setStep("error"); return; }
      if (res.status === 402 || data.error === "insufficient_credits") { setNeedCredits(true); setErrorMsg("You're out of credits. Your free credits reset weekly — or grab more to keep generating plays now."); setStep("error"); try { window.dispatchEvent(new Event("open-credits-flyer")); } catch { /* ignore */ } return; }
      if (data.error || !data.signal) { setErrorMsg(data.detail ? `Couldn't build a signal: ${data.detail}` : "Couldn't build a signal right now. Try another asset or try again shortly."); setStep("error"); return; }
      const r: Result = { ...data, id: Date.now(), status: "open" };
      setResult(r); setStep("result");
      persist([r, ...recent].slice(0, 20));
      void cloudSave([r]);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("credits-updated"));
      void earnMission("signal"); // auto-earn the daily "generate a play" mission
    } catch { if (timer.current) clearInterval(timer.current); setErrorMsg("Something interrupted the connection. Try again."); setStep("error"); }
  }

  async function checkResult(r: Result) {
    if (checking) return;
    setChecking(r.id);
    try {
      const tps = (r.signal.takeProfits || []).filter((n) => typeof n === "number" && Number.isFinite(n));
      const res = await fetch("/api/om-signal-check", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ td: r.td, interval: r.interval, since: r.asOf, direction: r.signal.direction, entry: r.signal.entry, sl: r.signal.stopLoss, tp1: tps[0], tps }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.status === "win" || d.status === "loss") {
        const patch = { status: d.status as Status, hitTp: typeof d.hitTp === "number" ? d.hitTp : undefined, hitAt: typeof d.at === "string" ? d.at : undefined };
        const updated = { ...r, ...patch };
        const next = recent.map((x) => (x.id === r.id ? updated : x));
        persist(next);
        if (result?.id === r.id) setResult({ ...result, ...patch });
        void cloudSave([updated]); // keep the server copy's status/TP in sync
      }
    } catch { /* ignore */ } finally { setChecking(null); }
  }

  // "Get Update" — re-read the live market and explain what's happening to THIS
  // open call right now (profit/drawdown, stop-run vs real break, flow flip).
  // Free to run; never charges a credit.
  async function getUpdate(r: Result) {
    if (updating) return;
    setUpdating(r.id);
    try {
      const res = await fetch("/api/om-signal-update", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ td: r.td, symbol: r.symbol, style: r.style, direction: r.signal.direction, entry: r.signal.entry, stopLoss: r.signal.stopLoss, takeProfits: r.signal.takeProfits, since: r.asOf }),
      });
      const d = await res.json().catch(() => ({}));
      if (d && d.status === "update") setUpdates((u) => ({ ...u, [r.id]: d as TradeUpdate }));
    } catch { /* ignore */ } finally { setUpdating(null); }
  }

  function deleteResult(id: number) {
    persist(recent.filter((x) => x.id !== id));
    if (result?.id === id) { setResult(null); }
    void cloudDelete(id);
  }

  const counted = recent.filter((r) => madeAt(r) >= sinceMs);
  const wins = counted.filter((r) => r.status === "win").length;
  const losses = counted.filter((r) => r.status === "loss").length;
  const rate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : null;
  const totalPips = Math.round(counted.filter((r) => r.status === "win").reduce((sum, r) => sum + winPips(r), 0));

  /* ── THE TRADING PLATFORM'S WORKSPACE (owner's brief, 11-20) ─────────────────────────────────────
   * The same generator, the same saved plays, the same requests and the same price — drawn as one
   * workspace instead of a banner, a wall of cards and a three-step dialog: what to generate on the left
   * (market, style, the saved method under Advanced, one Generate action with what it costs), the play
   * being looked at on the right, and the saved plays as rows beneath it. Nothing is generated by
   * opening this page or by choosing a market; opening Advanced resets nothing. */
  if (next) {
    const q = find.trim().toLowerCase();
    const groups = MARKETS.map((m) => ({ m, list: m.assets.filter((a) => !q || `${a.symbol} ${a.name} ${m.name}`.toLowerCase().includes(q)) })).filter((g) => g.list.length);
    // Each style in words, from what the engine reads for it (the timeframes it is given).
    const STYLES = [
      ["scalp", "Scalp", "Quick trades, read on the 5, 15 and 30-minute charts."],
      ["intraday", "Intraday", "Trades within the day, read on the 1-hour chart."],
      ["swing", "Swing", "Trades held over days, read on the daily chart."],
    ] as const;
    const rows = recent.filter((r) => show === "all" || r.status === show);
    const displayedRows = showAll || show !== "all" ? rows : rows.slice(0, 3);
    const busy = step === "loading";
    const cost: number = CREDIT_COST.signal;
    // Markets to start from: the member's own recent ones, then the most traded. Each is a choice offered —
    // nothing is chosen for them, and nothing is analysed by choosing.
    const quick: { m: Market; a: Asset }[] = [];
    const offer = (td: string) => { if (quick.length >= 6 || quick.some((x) => x.a.td === td)) return; const f = findAsset(td); if (f) quick.push({ m: f.market, a: f.asset }); };
    for (const r of recent) offer(r.td);
    for (const td of POPULAR) offer(td);
    // What is missing, said at the control that cannot be pressed yet.
    const need = !asset ? "Choose a market to continue." : confs.length === 0 ? "Choose at least one confirmation in Advanced settings." : null;
    const methodLine = `${mode === "institutional" ? "Institutional" : "Accelerator"} · ${METHODS.find((m) => m.k === method)!.label} · ${confs.length} confirmation${confs.length === 1 ? "" : "s"} · ${orderType === "limit" ? "limit entry" : "market entry"}`;
    // Ask Atlas about a play: the question carries the play's own words and levels. Free, as asking always is.
    const askAtlas = (r: Result) => {
      const a = analysisOf(r.signal), s = r.signal;
      const lv = s.direction !== "NEUTRAL" && numOk(s.entry) && numOk(s.stopLoss) ? ` Entry ${fmt(s.entry)}, stop ${fmt(s.stopLoss)}${(s.takeProfits || []).filter(numOk).length ? `, targets ${(s.takeProfits || []).filter(numOk).map((x) => fmt(x)).join(", ")}` : ""}.` : "";
      const made = madeAt(r);
      const question = `Explain my OM AI Play on ${r.symbol} (${r.style ?? s.timeframe}, made ${Number.isFinite(made) ? new Date(made).toLocaleString() : r.asOf}): ${a.label}.${lv} What is it waiting for, and what would cancel it?`;
      openAtlas({ question, context: { source: "OM AI Plays", label: r.symbol + " · " + a.label, data: { symbol: r.symbol, style: r.style, asOf: r.as_of ?? r.asOf, marketClosed: r.marketClosed, signal: s } } });
    };
    return (
      <div className="om-ws om-plays om-os-product om-plays-premium" data-play-open={!!result || undefined}>
        <header className="om-ws-head om-product-header">
          <div className="om-product-heading">
            <ProductIcon kind="plays" size="lg" />
            <div className="om-product-copy">
              <p className="om-product-kicker"><span className="om-plays-desktop">Trade planning</span><span className="om-plays-phone">OM AI Plays</span></p>
              <h1 className="om-title"><span className="om-plays-desktop">OM AI Plays</span><span className="om-plays-phone">{result ? "Your play" : "Create a play"}</span></h1>
              <p className="om-sub">Choose a market and a style. OM AI builds the complete read from live market data.</p>
            </div>
          </div>
          {result && <button type="button" className="om-btn-quiet om-plays-new" onClick={() => { setResult(null); setStep("config"); }}>New play</button>}
          {rate !== null && (
            <p className="om-ws-note om-num" title="Your saved plays since the record was reset, counted by what price did against each play's levels — not orders on an account">
              <b className={rate >= 50 ? "om-pos" : undefined}>{rate}%</b> of tracked plays reached a target first · {wins} of {wins + losses}{totalPips > 0 ? ` · +${totalPips.toLocaleString("en-US")} pips on those` : ""}
            </p>
          )}
        </header>

        <div className="om-plays-grid">
          <aside className="om-panel om-plays-config" aria-label="Generate a play">
            <div className="om-product-section-head om-plays-desktop">
              <h2>Build a play</h2>
              <p className="om-label">Three steps, one complete read.</p>
            </div>
            <div className="om-field">
              <span className="om-step" id="om-plays-market-label" data-done={asset ? "" : undefined}><span className="om-step-n" aria-hidden="true">1</span><span className="om-label">Market</span></span>
              <button id="om-plays-market" type="button" className="om-plays-market-row" aria-haspopup="dialog" aria-labelledby="om-plays-market-label om-plays-market-name" onClick={() => setPicking(true)}>
                <MarketGlyph symbol={asset?.symbol} market={market?.id} />
                <span id="om-plays-market-name"><b>{asset ? asset.symbol === "XAU/USD" ? "Gold" : asset.symbol : "Choose a market"}</b><small>{asset ? asset.symbol === "XAU/USD" ? asset.symbol : asset.name : "Search all assets"}</small></span>
                <ChevronRight aria-hidden="true" />
              </button>
            </div>

            <div className="om-field">
              <span className="om-step" id="om-plays-style" data-done=""><span className="om-step-n" aria-hidden="true">2</span><span className="om-label">Trading style</span></span>
              <div className="om-seg" role="group" aria-labelledby="om-plays-style">
                {STYLES.map(([v, label, sub]) => <button key={v} type="button" aria-pressed={style === v} title={sub} onClick={() => setStyle(v)}>{label}</button>)}
              </div>
              <p className="om-label om-plays-desktop">{STYLES.find((x) => x[0] === style)![2]}</p>
            </div>

            <div className="om-field om-plays-advanced">
              <button type="button" className="om-disclose" aria-expanded={advanced} aria-controls="om-plays-adv" onClick={() => setAdvanced((v) => !v)}>
                <span><span className="om-plays-advanced-label">Advanced settings</span><span className="om-label om-plays-desktop">{methodLine}</span></span>
                <ChevronDown aria-hidden="true" />
              </button>
              {advanced && (
                <div id="om-plays-adv" className="om-adv">
                  <span className="om-label" id="om-plays-mode">Trading mode</span>
                  <div className="om-choices" role="group" aria-labelledby="om-plays-mode">
                    <button type="button" aria-pressed={mode === "institutional"} onClick={() => setMode("institutional")}><b>Institutional</b><small>Strict: A+ and A setups, 2.5R or better</small></button>
                    <button type="button" aria-pressed={mode === "accelerator"} onClick={() => setMode("accelerator")}><b>Accelerator</b><small>Aggressive: momentum, 1.8R or better</small></button>
                  </div>
                  <span className="om-label" id="om-plays-method">Analysis method</span>
                  <div className="om-choices" role="group" aria-labelledby="om-plays-method">
                    {METHODS.map((m) => <button key={m.k} type="button" aria-pressed={method === m.k} onClick={() => pickMethod(m.k)}><b>{m.label}</b><small>{m.sub}</small></button>)}
                  </div>
                  <span className="om-label" id="om-plays-confs">Confirmations · {confs.length} on</span>
                  <div className="om-toggles" role="group" aria-labelledby="om-plays-confs">
                    {CONFS.map((c) => <button key={c.k} type="button" aria-pressed={confs.includes(c.k)} onClick={() => toggleConf(c.k)}>{c.label}</button>)}
                  </div>
                  <span className="om-label" id="om-plays-order">Order type</span>
                  <div className="om-choices" role="group" aria-labelledby="om-plays-order">
                    <button type="button" aria-pressed={orderType === "limit"} onClick={() => setOrderType("limit")}><b>Limit</b><small>An exact entry level</small></button>
                    <button type="button" aria-pressed={orderType === "market"} onClick={() => setOrderType("market")}><b>Market</b><small>Around the current price</small></button>
                  </div>
                  <button type="button" className="om-go" onClick={() => setAdvanced(false)}>Done</button>
                </div>
              )}
            </div>

            {/* One explicit paid action. Opening settings or choosing an asset never generates a play. */}
            <div className="om-plays-go">
              <span className="om-step"><span className="om-step-n" aria-hidden="true">3</span><span className="om-label">Generate</span></span>
              <button type="button" className="om-btn" onClick={() => void generate()} disabled={!!need || busy} aria-busy={busy} aria-describedby="om-plays-need">
                {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                {busy ? "Analyzing…" : "Generate play"}
              </button>
              {need && <p className="om-plays-need" id="om-plays-need" role="status">{need}</p>}
              <p className="om-label" id={need ? undefined : "om-plays-need"}>{cost} {cost === 1 ? "credit" : "credits"}<span className="om-plays-desktop"> a play · included with the FLOW Pass · charged only when a play is made</span></p>
            </div>
          </aside>

          <section className="om-plays-main">
            <div className="om-panel om-plays-result" data-empty={!busy && step !== "error" && !result || undefined} aria-live="polite">
              {busy ? (
                <div className="om-state" role="status"><Loader2 className="animate-spin" aria-hidden="true" /><p>Analyzing {asset?.symbol ?? "the market"}…</p><span className="om-label">Reading live candles and checking your confirmations. This usually takes a few seconds; nothing is charged unless a play is made.</span></div>
              ) : step === "error" ? (
                <div className="om-state" role="alert">
                  <p>{errorMsg}</p>
                  <span className="om-state-acts">
                    {needCredits && <a href="/portal/credits" className="om-btn">Get credits</a>}
                    {!needCredits && asset && <button type="button" className="om-btn" onClick={() => void generate()}>Try again</button>}
                    <button type="button" className="om-btn-quiet" onClick={() => { setErrorMsg(""); setNeedCredits(false); setStep("config"); }}>Dismiss</button>
                  </span>
                </div>
              ) : result ? (
                <PlayDetail r={result} key={result.id} madeMs={madeAt(result)}
                  checking={checking === result.id} onCheck={() => checkResult(result)}
                  updating={updating === result.id} onUpdate={() => getUpdate(result)}
                  update={updates[result.id] ? <UpdatePanel u={updates[result.id]} /> : null}
                  onDive={() => setDive(result)} onAsk={() => askAtlas(result)} onClose={() => setResult(null)}
                  live={result.td ? <LivePrice td={result.td} entry={numOk(result.signal.entry) ? result.signal.entry : null} direction={result.signal.direction} closed={result.marketClosed} /> : null}
                  copy={result.signal.direction !== "NEUTRAL" ? <span className="om-legacy"><CopyAllBtn text={buildTradeText({ direction: result.signal.direction, entry: result.signal.entry, stopLoss: result.signal.stopLoss, takeProfits: result.signal.takeProfits, fmt })} /></span> : null}
                  ticket={(result.signal.direction === "LONG" || result.signal.direction === "SHORT") && numOk(result.signal.entry) && numOk(result.signal.stopLoss)
                    ? <ExecuteSignal key={result.id} symbol={result.symbol} direction={result.signal.direction} entry={result.signal.entry as number} stop={result.signal.stopLoss as number}
                        tp={(result.signal.takeProfits || []).filter(numOk)[0] ?? null} unconfirmed={result.signal.status === "no_trade"} orderType={result.orderType} />
                    : null}
                  chat={result.signal.direction !== "NEUTRAL" && result.signal.status !== "no_trade" && numOk(result.signal.entry) && numOk(result.signal.stopLoss)
                    ? <TradeChat trade={{ td: result.td, symbol: result.symbol, style: result.style, interval: result.interval, direction: result.signal.direction, entry: result.signal.entry, stopLoss: result.signal.stopLoss, takeProfits: (result.signal.takeProfits || []).filter(numOk), since: result.asOf || result.as_of }} />
                    : null} />
              ) : (
                <div className="om-plays-preview">
                  <ProductIcon kind="plays" size="lg" />
                  <h2>{asset ? `Ready to analyze ${asset.symbol}` : "Your play appears here"}</h2>
                  <p className="om-product-preview-copy">Your analysis, plan, and next step in one place.</p>
                  <ul className="om-product-outcomes">
                    <li><b>The market read</b><span>A setup, an unconfirmed idea, or a reason to wait.</span></li>
                    <li><b>The chart and the levels</b><span>Entry, stop, targets, and reward to risk when a plan is available.</span></li>
                    <li><b>What to do next</b><span>Track the play, review the outcome, or open an account ticket.</span></li>
                  </ul>
                  <p className="om-label">Nothing is analyzed until you press Generate. Your saved plays are below, and open without generating anything.</p>
                </div>
              )}
            </div>

            <div className="om-saved">
              <div className="om-saved-head">
                <h2>Recent plays</h2>
                <details className="om-plays-filters">
                  <summary>{show === "all" ? "Filter" : show === "open" ? "Open" : show === "win" ? "Target reached" : "Stop reached"}<ChevronDown aria-hidden="true" /></summary>
                  <div className="om-tf" role="group" aria-label="Show saved plays">
                    {([["all", "All"], ["open", "Open"], ["win", "Target reached"], ["loss", "Stop reached"]] as const).map(([k, label]) => <button key={k} type="button" aria-pressed={show === k} onClick={(event) => { setShow(k); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{label}</button>)}
                  </div>
                </details>
              </div>
              {rows.length === 0 ? <p className="om-empty">{recent.length === 0 ? "You have no saved plays yet. A play you generate is saved here." : "No saved play matches that filter."}</p> : (
                <ul className="om-rows">
                  {displayedRows.map((r) => <PlayRow key={r.id} r={r} current={result?.id === r.id} checking={checking === r.id} onDelete={() => deleteResult(r.id)} onCheck={() => checkResult(r)}
                    onOpen={() => {
                      setResult(r); setStep("result");
                      // Opened from the list below: bring the play into view (it opens above the list).
                      requestAnimationFrame(() => document.querySelector(".om-plays-result")?.scrollIntoView({ block: "nearest" }));
                    }} />)}
                </ul>
              )}
              {show === "all" && rows.length > 3 && <button type="button" className="om-go om-plays-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>{showAll ? "Show recent" : `View all ${rows.length} plays`}<ChevronRight aria-hidden="true" /></button>}
              {rate !== null && <details className="om-plays-record om-plays-phone"><summary>Play results<ChevronDown aria-hidden="true" /></summary><p><b>{rate}%</b> reached a target first · {wins} of {wins + losses} tracked plays{totalPips > 0 ? ` · +${totalPips.toLocaleString("en-US")} pips on those` : ""}.</p><p>Saved plays since the record reset. These are tracked prices, not account returns.</p></details>}
            </div>
          </section>
        </div>

        {picking && <PlayMarketPicker find={find} onFind={setFind} groups={groups} quick={quick} selected={asset?.td ?? null}
          onPick={(m, a) => { setMarket(m); setAsset(a); setPicking(false); setFind(""); }}
          onClose={() => { setPicking(false); setFind(""); }} />}

        {dive && (
          <DeepDiveModal ticker={dive.symbol} name={dive.name} type={dive.market} td={dive.td} context="signal"
            dir={dive.signal.direction === "LONG" || dive.signal.direction === "SHORT" ? dive.signal.direction : undefined}
            style={dive.style} source="plays" onClose={() => setDive(null)} />
        )}
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-3xl bg-[#0a0b10] text-white ring-1 ring-white/10">
      <div className="pointer-events-none absolute inset-x-0 -top-24 h-64 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(198,166,103,0.18),transparent)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(#fff_1px,transparent_1px),linear-gradient(90deg,#fff_1px,transparent_1px)] [background-size:40px_40px]" />

      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-gold-light to-[#8a6d35]"><Zap className="h-4 w-4 text-[#0a0b10]" /></span>
          <div>
            <p className="font-serif text-base font-semibold uppercase tracking-[0.14em]">OM AI Plays</p>
            <p className="text-[11px] uppercase tracking-[0.14em] text-white/40">AI trade signals · real market data</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {rate !== null && (
            <div className="text-right">
              <p className="font-serif text-lg font-bold text-emerald-400">{rate}%<span className="ml-1 text-xs font-normal text-white/40">win</span></p>
              <p className="text-[10px] uppercase tracking-[0.1em] text-white/40">{wins}W · {losses}L</p>
              {totalPips > 0 && <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-emerald-400/80">+{totalPips.toLocaleString()} pips</p>}
            </div>
          )}
          <button onClick={() => { reset(); setOpen(true); }} className="inline-flex items-center gap-2 rounded-none bg-gradient-to-br from-gold-light to-[#8a6d35] px-6 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-[#0a0b10] transition-opacity hover:opacity-90">
            <Sparkles className="h-4 w-4" /> Generate Signal <span className="rounded-full bg-black/15 px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal">{CREDIT_COST.signal} credit</span>
          </button>
        </div>
      </div>

      <div className="relative z-10 px-6 py-6 sm:px-8">
        {recent.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white/[0.04] ring-1 ring-white/10"><Sparkles className="h-6 w-6 text-white/30" /></span>
            <p className="mt-4 font-serif text-lg font-semibold">No active signals</p>
            <p className="mt-1 max-w-xs text-sm text-white/40">Generate your first signal to start tracking opportunities across every market.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {recent.map((r) => (
              <CompactCard key={r.id} r={r} checking={checking === r.id}
                onOpen={() => { setResult(r); setStep("result"); setOpen(true); }}
                onCheck={() => checkResult(r)}
                onDelete={() => deleteResult(r.id)} />
            ))}
          </div>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={close}>
          <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-[#0d0e15] text-white ring-1 ring-white/12" onClick={(e) => e.stopPropagation()}>
            <div className="pointer-events-none absolute inset-x-0 -top-16 h-48 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(198,166,103,0.22),transparent)]" />
            <div className="relative z-10 flex items-center justify-between px-6 py-4">
              <div className="flex items-center gap-2">
                {(step === "asset" || step === "config") && (
                  <button onClick={() => setStep(step === "config" ? "asset" : "market")} className="grid h-7 w-7 place-items-center rounded-full text-white/60 hover:bg-white/10"><ChevronLeft className="h-4 w-4" /></button>
                )}
                <span className="text-[11px] uppercase tracking-[0.16em] text-white/45">
                  {step === "market" && "Step 1 · Market Type"}
                  {step === "asset" && "Step 2 · Select Asset"}
                  {step === "config" && "Step 3 · Configure"}
                  {step === "loading" && "Generating…"}
                  {step === "result" && "Your Signal"}
                  {step === "error" && "Heads up"}
                </span>
              </div>
              <button onClick={close} className="grid h-7 w-7 place-items-center rounded-full text-white/60 hover:bg-white/10"><X className="h-4 w-4" /></button>
            </div>

            <div className="relative z-10 px-6 pb-7 pt-1">
              {step === "market" && (
                <>
                  <h2 className="text-center font-serif text-2xl font-bold">Select Market Type</h2>
                  <p className="mt-1 text-center text-sm text-white/45">Choose the market you want to trade in</p>
                  <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {MARKETS.map((m) => {
                      const Icon = MARKET_ICON[m.id];
                      return (
                        <button key={m.id} onClick={() => { setMarket(m); setStep("asset"); }} className="flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-center transition-colors hover:border-gold-light/40 hover:bg-white/[0.06]">
                          <Icon className={`h-7 w-7 ${MARKET_TINT[m.id]}`} />
                          <span className="mt-2.5 text-sm font-semibold">{m.name}</span>
                          <span className="mt-0.5 text-[11px] leading-tight text-white/40">{m.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {step === "asset" && market && (
                <>
                  <h2 className="text-center font-serif text-2xl font-bold">Select Asset</h2>
                  <p className="mt-1 text-center text-sm text-white/45">Pick a {market.name.toLowerCase()} asset to analyze</p>
                  <div className="mt-5 space-y-2">
                    {market.assets.map((a) => (
                      <button key={a.td} onClick={() => { setAsset(a); setStep("config"); }} className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition-colors hover:border-gold-light/40 hover:bg-white/[0.06]">
                        <div><p className="font-semibold">{a.symbol}</p><p className="text-xs text-white/40">{a.name}</p></div>
                        <span className="text-white/30">›</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {step === "config" && asset && (
                <>
                  <h2 className="text-center font-serif text-2xl font-bold">Configure</h2>
                  <p className="mt-1 text-center text-sm text-white/45">Setup for <span className="text-gold-light">{asset.symbol}</span></p>

                  <p className="mt-5 text-[11px] uppercase tracking-[0.12em] text-white/45">Trading Mode</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button onClick={() => setMode("institutional")} className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${mode === "institutional" ? "border-gold-light/60 bg-gold-light/10" : "border-white/12 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                      <span className="block text-sm font-semibold">Institutional</span><span className="mt-0.5 block text-[10px] leading-tight text-white/40">Strict · A+/A · ≥2.5R</span>
                    </button>
                    <button onClick={() => setMode("accelerator")} className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${mode === "accelerator" ? "border-amber-400/60 bg-amber-400/10" : "border-white/12 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                      <span className="block text-sm font-semibold">Accelerator</span><span className="mt-0.5 block text-[10px] leading-tight text-white/40">Aggressive · momentum · ≥1.8R</span>
                    </button>
                  </div>

                  <p className="mt-5 text-[11px] uppercase tracking-[0.12em] text-white/45">Trade Style</p>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {([["scalp", "Scalp", "5·15·30m"], ["intraday", "Intraday", "1H"], ["swing", "Swing", "Daily"]] as const).map(([v, label, sub]) => (
                      <button key={v} onClick={() => setStyle(v)} className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${style === v ? "border-gold-light/60 bg-gold-light/10" : "border-white/12 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                        <span className="block text-sm font-semibold">{label}</span><span className="mt-0.5 block text-[10px] text-white/40">{sub}</span>
                      </button>
                    ))}
                  </div>

                  <p className="mt-5 text-[11px] uppercase tracking-[0.12em] text-white/45">Analysis Method</p>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {METHODS.map((m) => (
                      <button key={m.k} onClick={() => pickMethod(m.k)} className={`rounded-xl border px-2 py-2.5 text-center transition-colors ${method === m.k ? "border-gold-light/60 bg-gold-light/10" : "border-white/12 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                        <span className="block text-[13px] font-semibold">{m.label}</span><span className="mt-0.5 block text-[10px] leading-tight text-white/40">{m.sub}</span>
                      </button>
                    ))}
                  </div>

                  <div className="mt-5 flex items-center justify-between">
                    <p className="text-[11px] uppercase tracking-[0.12em] text-white/45">Confirmations</p>
                    <span className="text-[10px] text-white/35">tap to toggle</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {CONFS.map((c) => {
                      const on = confs.includes(c.k);
                      return (
                        <button key={c.k} onClick={() => toggleConf(c.k)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${on ? "border-gold-light/50 bg-gold-light/10 text-white" : "border-white/12 bg-white/[0.02] text-white/50 hover:text-white/80"}`}>
                          {on && <Check className="h-3 w-3 text-gold-light" />} {c.label}
                        </button>
                      );
                    })}
                  </div>

                  <p className="mt-5 text-[11px] uppercase tracking-[0.12em] text-white/45">Order Type</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {(["market", "limit"] as const).map((o) => (
                      <button key={o} onClick={() => setOrderType(o)} className={`rounded-xl border px-4 py-2.5 text-left transition-colors ${orderType === o ? "border-gold-light/60 bg-gold-light/10" : "border-white/12 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                        <span className="text-sm font-semibold capitalize">{o}</span>
                        <span className="mt-0.5 block text-[10px] text-white/40">{o === "market" ? "Around current price" : "Exact entry level"}</span>
                      </button>
                    ))}
                  </div>

                  <button onClick={() => generate()} disabled={confs.length === 0} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-none bg-gradient-to-br from-gold-light to-[#8a6d35] px-6 py-3.5 text-[13px] font-semibold uppercase tracking-[0.14em] text-[#0a0b10] transition-opacity hover:opacity-90 disabled:opacity-40">
                    <Sparkles className="h-4 w-4" /> Generate Signal <span className="rounded-full bg-black/15 px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal">{CREDIT_COST.signal} credit</span>
                  </button>
                </>
              )}

              {step === "loading" && (
                <div className="py-4">
                  <div className="flex flex-col items-center">
                    <span className="grid h-16 w-16 animate-pulse place-items-center rounded-full bg-gradient-to-br from-gold-light to-[#8a6d35]"><Sparkles className="h-7 w-7 text-[#0a0b10]" /></span>
                    <p className="mt-4 text-sm text-white/50">Analyzing</p>
                    <p className="font-serif text-2xl font-bold">{asset?.symbol}</p>
                  </div>
                  <div className="mt-6 space-y-3">
                    {GEN_STEPS.map((s, i) => (
                      <div key={i} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${i === genStep ? "bg-white/[0.06] ring-1 ring-gold-light/30" : ""}`}>
                        <span className={`grid h-5 w-5 place-items-center rounded-full ${i < genStep ? "bg-emerald-500/20 text-emerald-400" : i === genStep ? "text-gold-light" : "text-white/20"}`}>
                          {i < genStep ? <Check className="h-3.5 w-3.5" /> : i === genStep ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                        </span>
                        <span className={`text-sm ${i <= genStep ? "text-white/80" : "text-white/30"}`}>{s}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {step === "result" && result && (
                <>
                  <FullCard r={result} onCheck={() => checkResult(result)} checking={checking === result.id} onUpdate={() => getUpdate(result)} updating={updating === result.id} update={updates[result.id]} />
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <button onClick={() => setDive(result)} className="inline-flex w-full items-center justify-center gap-2 rounded-none border border-gold-light/40 bg-gold-light/10 px-6 py-3 text-[12px] font-medium uppercase tracking-[0.14em] text-gold-light transition-colors hover:bg-gold-light/20"><Sparkles className="h-4 w-4" /> Deep dive <span className="rounded-full bg-gold-light/20 px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal">{CREDIT_COST.deepdive} credit</span></button>
                    <button onClick={reset} className="inline-flex w-full items-center justify-center gap-2 rounded-none border border-white/20 px-6 py-3 text-[12px] font-medium uppercase tracking-[0.14em] text-white transition-colors hover:bg-white/10"><RefreshCw className="h-4 w-4" /> New Signal</button>
                  </div>
                </>
              )}

              {step === "error" && (
                <div className="py-6 text-center">
                  <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-amber-500/15 text-amber-400"><ShieldAlert className="h-6 w-6" /></span>
                  <p className="mt-4 text-sm text-white/70">{errorMsg}</p>
                  {needCredits && (
                    <a href="/portal/credits" className="mt-5 inline-flex items-center justify-center gap-2 rounded-none bg-gradient-to-br from-gold-light to-[#8a6d35] px-6 py-2.5 text-[12px] font-semibold uppercase tracking-[0.14em] text-[#0a0b10] hover:opacity-90"><Sparkles className="h-4 w-4" /> Get credits</a>
                  )}
                  <button onClick={reset} className="mt-3 block rounded-none border border-white/20 px-6 py-2.5 text-[12px] font-medium uppercase tracking-[0.14em] text-white hover:bg-white/10">Back to start</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {dive && (
        <DeepDiveModal
          ticker={dive.symbol}
          name={dive.name}
          type={dive.market}
          td={dive.td}
          context="signal"
          dir={dive.signal.direction === "LONG" || dive.signal.direction === "SHORT" ? dive.signal.direction : undefined}
          style={dive.style}
          source="plays"
          onClose={() => setDive(null)}
        />
      )}
    </div>
  );
}

function MarketGlyph({ symbol, market }: { symbol?: string; market?: string }) {
  if (symbol === "XAU/USD") return <svg className="om-market-glyph om-market-gold" viewBox="0 0 36 30" fill="currentColor" aria-hidden="true"><path d="M14 3h8l4 10H10L14 3ZM5 17h10l4 10H1L5 17ZM22 17h9l4 10H18l4-10Z" /></svg>;
  const Icon = market && market in MARKET_ICON ? MARKET_ICON[market as Market["id"]] : Search;
  return <Icon className="om-market-glyph" aria-hidden="true" />;
}

/** A native modal keeps selection reachable by touch and keyboard without cluttering the builder. */
function PlayMarketPicker({ find, onFind, groups, quick, selected, onPick, onClose }: {
  find: string; onFind: (value: string) => void;
  groups: { m: Market; list: Asset[] }[];
  quick: { m: Market; a: Asset }[];
  selected: string | null;
  onPick: (market: Market, asset: Asset) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node.showModal();
    // Focusing the heading leaves the phone keyboard closed until Search is chosen.
    node.querySelector<HTMLElement>("h2")?.focus();
    return () => { node.close(); previous?.focus({ preventScroll: true }); };
  }, []);
  return (
    <dialog ref={dialog} className="om-market-dialog" aria-labelledby="om-market-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="om-market-dialog-body">
        <header><h2 id="om-market-dialog-title" tabIndex={-1}>Choose market</h2><button type="button" aria-label="Close market selector" onClick={onClose}><X aria-hidden="true" /></button></header>
        <label className="om-market-search"><Search aria-hidden="true" /><input value={find} onChange={(event) => onFind(event.target.value)} placeholder="Search assets" aria-label="Search markets" autoComplete="off" /></label>
        <div className="om-market-dialog-scroll">
          {!find.trim() && quick.length > 0 && <section className="om-market-quick"><h3>Quick picks</h3><div>{quick.map(({ m, a }) => <button key={a.td} type="button" onClick={() => onPick(m, a)} aria-pressed={selected === a.td}>{a.symbol}</button>)}</div></section>}
          {groups.length === 0 ? <p className="om-market-no-result">No matching markets.</p> : groups.map(({ m, list }) => <section key={m.id} className="om-market-group" aria-label={m.name}><h3>{m.name}</h3>{list.map((a) => <button key={a.td} type="button" onClick={() => onPick(m, a)} aria-pressed={selected === a.td}><MarketGlyph symbol={a.symbol} market={m.id} /><span><b>{a.symbol === "XAU/USD" ? "Gold" : a.symbol}</b><small>{a.symbol === "XAU/USD" ? a.symbol : a.name}</small></span>{selected === a.td ? <Check aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</button>)}</section>)}
        </div>
      </div>
    </dialog>
  );
}

function dirStyle(dir: string) {
  const color = dir === "LONG" ? "text-emerald-400 bg-emerald-500/15" : dir === "SHORT" ? "text-red-400 bg-red-500/15" : "text-white/60 bg-white/10";
  const Icon = dir === "LONG" ? ArrowUp : dir === "SHORT" ? ArrowDown : Minus;
  return { color, Icon };
}
function StatusBadge({ status, hitTp }: { status: Status; hitTp?: number }) {
  if (status === "win") return <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-400">Win{typeof hitTp === "number" ? ` · TP${hitTp}` : ""}</span>;
  if (status === "loss") return <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-red-400">Loss</span>;
  return <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase text-white/50">Open</span>;
}
// Institutional trade grade (A+/A only ever released as a trade). Shows the
// quality score, never a win-probability. Amber for A+, softer gold for A.
function GradeBadge({ grade, score }: { grade: string; score?: number }) {
  const strong = grade === "A+";
  const cls = strong
    ? "bg-amber-400/20 text-amber-300 border border-amber-400/40"
    : grade === "A"
    ? "bg-gold-light/15 text-gold-light border border-gold-light/35"
    : "bg-white/8 text-white/55 border border-white/15";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${cls}`}>
      Grade {grade}{typeof score === "number" ? ` · ${score}/100` : ""}
    </span>
  );
}

/** What a saved play says about ITSELF, in words. The setup's state (what the engine concluded) and the
 *  record's outcome (what happened after) are two things and are shown as two. Neither is a broker order. */
function playWords(r: Result): { setup: string; outcome: string; tone: "pos" | "neg" | null } {
  // Seen on the owner's saved plays (11-20, 11-21): "Sell idea, not confirmed" beside "Target reached" read as
  // if an unconfirmed idea had been a winning trade. The setup column says what the engine concluded; the
  // outcome column, what price did against the play's levels — said as price, and for an idea in a neutral
  // voice (lib/plays/lifecycle.ts). Neither is an order.
  const a = analysisOf(r.signal), t = trackingOf(r);
  return { setup: a.label, outcome: t.label, tone: t.tone };
}

function PlayRow({ r, current, checking, onOpen, onCheck, onDelete }: { r: Result; current: boolean; checking: boolean; onOpen: () => void; onCheck: () => void; onDelete: () => void }) {
  const [menu, setMenu] = useState(false);
  const [sure, setSure] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) { setMenu(false); setSure(false); } };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(false); setSure(false); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [menu]);
  const w = playWords(r);
  const made = madeAt(r);
  const when = Number.isFinite(made) ? new Date(made).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const canCheck = r.status === "open" && r.signal.direction !== "NEUTRAL";
  return (
    <li data-current={current || undefined}>
      <button type="button" className="om-row-main" onClick={onOpen} aria-label={`Open the ${r.symbol} play: ${w.setup}. ${w.outcome}`}>
        <span className="om-play-row-market"><MarketGlyph symbol={r.symbol} market={r.market?.toLowerCase()} /><span className="om-row-sym" data-no-i18n translate="no">{r.symbol === "XAU/USD" ? "Gold" : r.symbol}<small>{r.style ? r.style.charAt(0).toUpperCase() + r.style.slice(1) : r.signal.timeframe}</small></span></span>
        <span className="om-play-row-analysis">{w.setup}</span>
        <span className={`om-play-row-outcome ${w.tone === "pos" ? "om-pos" : w.tone === "neg" ? "om-neg" : "om-dim"}`}>{w.outcome}</span>
        <span className="om-dim om-num om-play-row-date" data-no-i18n translate="no">{when}</span>
        <span className="om-play-row-open">View setup<ChevronRight aria-hidden="true" /></span>
      </button>
      <div ref={box} className="om-row-more">
        <button type="button" className="om-icon-btn" aria-haspopup="menu" aria-expanded={menu} aria-label={`More for the ${r.symbol} play`} onClick={() => { setMenu((m) => !m); setSure(false); }}><MoreHorizontal aria-hidden="true" /></button>
        {menu && (
          <div className="om-menu" role="menu">
            {canCheck && <button type="button" role="menuitem" disabled={checking} onClick={() => { onCheck(); setMenu(false); }}><RefreshCw aria-hidden="true" />{checking ? "Checking…" : "Check result"}</button>}
            {sure
              ? <button type="button" role="menuitem" className="om-danger" onClick={() => { onDelete(); setMenu(false); setSure(false); }}><Trash2 aria-hidden="true" />Yes, delete this play</button>
              : <button type="button" role="menuitem" onClick={() => setSure(true)}><Trash2 aria-hidden="true" />Delete…</button>}
          </div>
        )}
      </div>
    </li>
  );
}

function CompactCard({ r, onOpen, onCheck, onDelete, checking }: { r: Result; onOpen: () => void; onCheck: () => void; onDelete: () => void; checking: boolean }) {
  const s = r.signal; const { color, Icon } = dirStyle(s.direction);
  const [confirmDel, setConfirmDel] = useState(false);
  return (
    <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{r.symbol}</span>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${color}`}><Icon className="h-3 w-3" />{s.direction}</span>
          <StatusBadge status={r.status} hitTp={r.hitTp} />
        </div>
        <p className="mt-0.5 truncate text-[11px] text-white/40">
          Entry {fmt(s.entry)} · {s.timeframe}
          {typeof s.confirmed === "number" && <span className="text-white/55"> · {s.confirmed}/{s.total ?? s.checklist?.length ?? 5} confirmed</span>}
        </p>
      </button>
      <div className="ml-2 flex flex-shrink-0 items-center gap-1.5">
        {r.status === "open" && s.direction !== "NEUTRAL" && (
          <button onClick={onCheck} disabled={checking} title="Check result" className="grid h-8 w-8 place-items-center rounded-full border border-white/12 text-white/60 hover:bg-white/10 disabled:opacity-40">
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        )}
        {confirmDel ? (
          <div className="flex items-center gap-1">
            <button onClick={() => { onDelete(); setConfirmDel(false); }} title="Confirm delete" className="grid h-8 w-8 place-items-center rounded-full bg-red-500/90 text-white hover:bg-red-500">
              <Check className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setConfirmDel(false)} title="Cancel" className="grid h-8 w-8 place-items-center rounded-full border border-white/12 text-white/60 hover:bg-white/10">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmDel(true)} title="Delete play" className="grid h-8 w-8 place-items-center rounded-full border border-white/12 text-white/50 hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-400">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function LivePrice({ td, entry, direction, closed }: { td: string; entry: number | null; direction: Signal["direction"]; closed?: boolean }) {
  const [price, setPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // Load the price ONCE on open, then only on manual refresh — no background
  // timer, so an open card never quietly burns market-data credits.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/om-price?td=${encodeURIComponent(td)}`, { cache: "no-store" });
      const d = await res.json();
      if (typeof d.price === "number" && Number.isFinite(d.price)) { setPrice(d.price); setFailed(false); }
      else setFailed(true);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }, [td]);

  useEffect(() => { void load(); }, [load]);

  const diff = price !== null && entry !== null ? price - entry : null;
  const favor = diff === null ? 0 : direction === "SHORT" ? -diff : direction === "LONG" ? diff : 0;
  const pct = diff !== null && entry ? (diff / entry) * 100 : null;
  const col = favor > 0 ? "text-emerald-400" : favor < 0 ? "text-red-400" : "text-white";

  return (
    <div className="mt-3 flex items-center justify-between rounded-xl border border-white/10 bg-black/40 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          {!closed && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${closed ? "bg-amber-400" : "bg-emerald-400"}`} />
        </span>
        <span className="text-[10px] uppercase tracking-[0.14em] text-white/45">{closed ? "Last price" : "Current price"}</span>
        {!closed && (
          <button onClick={() => void load()} disabled={loading} title="Refresh price" className="grid h-6 w-6 place-items-center rounded-full text-white/40 hover:bg-white/10 hover:text-white/70 disabled:opacity-40">
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>
      <div className="text-right">
        {loading && price === null ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-white/50"><Loader2 className="h-3.5 w-3.5 animate-spin" /> loading…</span>
        ) : price === null ? (
          <span className="text-sm text-white/40">{failed ? "unavailable" : "—"}</span>
        ) : (
          <div className="flex items-baseline justify-end gap-2">
            <span className={`font-serif text-xl font-bold tabular-nums ${col}`}>{fmt(price)}</span>
            {diff !== null && (direction === "LONG" || direction === "SHORT") && (
              <span className={`text-xs tabular-nums ${col}`}>{diff >= 0 ? "+" : ""}{fmt(diff)}{pct !== null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)` : ""}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Live trade-update panel — plain-English "what's happening to my trade & why".
function UpdatePanel({ u }: { u: TradeUpdate }) {
  const side = u.pnl?.side;
  const tone = side === "profit" ? "emerald" : side === "drawdown" ? "amber" : "sky";
  const border = tone === "emerald" ? "border-emerald-400/30 bg-emerald-500/[0.06]" : tone === "amber" ? "border-amber-500/30 bg-amber-500/[0.06]" : "border-sky-400/30 bg-sky-400/[0.06]";
  const chip = u.thesis === "intact" ? "bg-emerald-500/15 text-emerald-300" : u.thesis === "weakening" ? "bg-amber-500/15 text-amber-300" : "bg-red-500/15 text-red-300";
  const rStr = `${u.pnl.r >= 0 ? "+" : ""}${u.pnl.r}R`;
  return (
    <div className={`mt-4 rounded-2xl border px-4 py-3.5 ${border}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/70"><Activity className="h-3.5 w-3.5 text-sky-300" /> Live update</p>
        <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${chip}`}>Idea {u.thesis}</span>
      </div>
      <p className="mt-2 text-sm font-semibold text-white">{u.headline}</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/55">
        <span>Now: <span className="font-semibold tabular-nums text-white/85">{fmt(u.price)}</span></span>
        <span>P/L: <span className={`font-semibold tabular-nums ${side === "profit" ? "text-emerald-400" : side === "drawdown" ? "text-amber-300" : "text-white/70"}`}>{rStr} · {u.pnl.pips >= 0 ? "+" : ""}{u.pnl.pips} pips</span></span>
        <span>To stop: <span className="tabular-nums text-white/75">{u.distance.to_stop_pips} pips</span></span>
        <span>To {u.distance.next_target_label}: <span className="tabular-nums text-white/75">{u.distance.to_next_target_pips} pips</span></span>
      </div>
      {Array.isArray(u.explanation) && u.explanation.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {u.explanation.map((e, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-white/80"><span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-sky-300/70" /> {e}</li>
          ))}
        </ul>
      )}
      {u.what_to_watch && (
        <p className="mt-3 inline-flex items-start gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-white/70"><Eye className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-white/50" /> <span><span className="text-white/50">What to watch:</span> {u.what_to_watch}</span></p>
      )}
      <p className="mt-2 text-[10px] text-white/35">Educational market-management context, not financial advice. Live data via Twelve Data.</p>
    </div>
  );
}

/* ---------- Execute (risk-sized) — take this OM AI play on TradeLocker ---------- */

type SizingInfo = { estLossAtStop?: number } | null;
type PerAcct = {
  accountId: string; name?: string | null; accNum?: string | null; environment?: string | null; equity?: number | null; lots?: number | null;
  currency?: string | null; estLossAtStop?: number | null; reason?: string; placement?: PlacementSize | null;
};
type TicketFill = { accountId: string; status: "placed" | "error" | "skipped"; qty?: number; lots?: number; orderId?: string | null; reason?: string };

export function ExecuteSignal({ symbol, direction, entry, stop, tp, unconfirmed = false, orderType }: {
  symbol: string; direction: "LONG" | "SHORT"; entry: number; stop: number; tp: number | null;
  /** New shell: the engine had not confirmed this play. Placing it is labelled a manual override. */
  unconfirmed?: boolean;
  /** New shell: the play's own order type, so the ticket can say how it is actually placed. */
  orderType?: string;
}) {
  const side: "buy" | "sell" = direction === "SHORT" ? "sell" : "buy";
  const [risk, setRisk] = useState(1);
  const [acct, setAcct] = useState("");
  const [connected, setConnected] = useState(false);
  const [equity, setEquity] = useState<number | null>(null);
  const [lots, setLots] = useState<number | null>(null);
  const [sizing, setSizing] = useState<SizingInfo>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ orderId?: string | null; placed?: number } | null>(null);
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [acctCount, setAcctCount] = useState(0);
  // WHERE the play lands (owner directive 08-31): every connected account, or one the
  // member picks. "all" keeps the classic fan-out; an accountId places on that one only.
  const [target, setTarget] = useState<string>("all");
  const [acctList, setAcctList] = useState<PerAcct[]>([]);
  // The new shell shows every account the ticket goes to, as the service sized it, each account's result, and
  // asks once more before anything is placed. The requests are the same ones.
  const next = useNextShell();
  const [per, setPer] = useState<PerAcct[] | null>(null);
  const [fills, setFills] = useState<TicketFill[] | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    fetch("/api/flow/prefs", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d) {
          if (d.riskPct) setRisk(d.riskPct);
          if (d.connected) { setConnected(true); setEquity(d.liveEquity ?? null); }
          else if (d.accountSize) setAcct(String(d.accountSize));
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const bodyFor = (extra?: Record<string, unknown>) => {
    const b: Record<string, unknown> = { source: "play", symbol, side, entry, stop, tp, riskPct: risk };
    if (target !== "all") b.accountId = target;
    if (!connected && acct) b.accountSize = +acct;
    return { ...b, ...(extra || {}) };
  };

  const preview = useCallback(() => {
    fetch("/api/flow/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyFor({ preview: true })) })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.preview) {
          setLots(d.lots); setSizing(d.sizing ?? null); if (d.equity != null) setEquity(d.equity); setAcctCount(d.accountCount ?? 0); setErr("");
          setPer(Array.isArray(d.accounts) ? (d.accounts as PerAcct[]) : null);
          // Only an unfiltered ("all") preview carries the FULL account list — keep it for the picker.
          if (target === "all" && Array.isArray(d.accounts)) setAcctList(d.accounts as PerAcct[]);
        }
        else if (d && d.detail) { setLots(null); setErr(d.detail); setPer(null); }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [risk, acct, connected, target]);

  useEffect(() => { if (loaded) preview(); }, [loaded, risk, acct, target, preview]);

  function execute() {
    if (busy || lots == null) return;
    setBusy(true); setErr("");
    fetch("/api/flow/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyFor()) })
      .then((r) => r.json())
      .then((d) => {
        if (d && Array.isArray(d.accounts) && d.accounts.some((x: { status?: string }) => typeof x?.status === "string")) setFills(d.accounts as TicketFill[]);
        if (d && d.ok && d.outcome && d.outcome.status === "placed") setDone({ ...d.outcome, placed: d.placed });
        else setErr((d && (d.detail || (d.outcome && d.outcome.reason))) || "Couldn't place the order.");
      })
      .catch(() => setErr("Network error — try again."))
      .finally(() => setBusy(false));
  }

  function saveAcct() {
    if (acct) fetch("/api/flow/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountSize: +acct, riskPct: risk }) }).catch(() => {});
  }

  const RISKS = [0.5, 1, 2, 3];
  const sym = symbol.replace("/", "");

  /* THE NEW SHELL (owner 11-21 brief §13): the same preview and the same placement request, drawn as an explicit
     ticket — each account it goes to with its own size, how the order is actually placed, whether the play was
     confirmed, and one more tap to confirm. Nothing about what is placed changes. */
  if (next) {
    const sideW = side === "sell" ? "Sell" : "Buy";
    const env = (e?: string | null) => (String(e ?? "").toLowerCase() === "live" ? "live" : "demo");
    const nameFor = (p: PerAcct) => accountName(p.name, env(p.environment), maskAccount(p.accountId, p.accNum));
    const many = acctCount > 1;
    const live = (per ?? []).some((p) => env(p.environment) === "live");
    const fillFor = (id: string) => fills?.find((f) => String(f.accountId) === String(id)) ?? null;
    const why = (r?: string) => (!r ? "" : r === "no_equity" ? "no equity reading from the broker" : r.replace(/_/g, " "));
    const limit = String(orderType ?? "").toLowerCase() === "limit";
    return (
      <div className="om-ticket">
        <div className="om-ticket-head">
          <h3>Ticket</h3>
          <span className="om-label" data-no-i18n translate="no">{sideW} {pairName(symbol)} · stop {priceFor(symbol, stop)}{tp != null ? ` · target ${priceFor(symbol, tp)}` : ""}</span>
        </div>
        {unconfirmed && (
          <p className="om-play-note" role="note"><b>Manual override.</b> The engine has not confirmed this idea. Placing it is your own decision: the play stays an unconfirmed idea, and it does not become an engine signal.</p>
        )}
        <div className="om-field">
          <span className="om-label">Risk for this ticket · an account with its own risk uses its own</span>
          <div className="om-toggles" role="group" aria-label="Risk for this ticket">
            {RISKS.map((rp) => <button key={rp} type="button" aria-pressed={risk === rp} onClick={() => { setRisk(rp); setConfirming(false); }}>{rp}%</button>)}
          </div>
        </div>
        {connected && acctList.length > 1 && (
          <div className="om-field">
            <span className="om-label">Place on</span>
            <div className="om-toggles" role="group" aria-label="Accounts this ticket goes to" data-no-i18n translate="no">
              <button type="button" aria-pressed={target === "all"} onClick={() => { setTarget("all"); setConfirming(false); }}>All {acctList.length} accounts</button>
              {acctList.map((a) => <button key={a.accountId} type="button" aria-pressed={target === String(a.accountId)} onClick={() => { setTarget(String(a.accountId)); setConfirming(false); }}>{nameFor(a)}</button>)}
            </div>
          </div>
        )}
        {connected ? (
          per && per.length ? (
            <table className="om-table om-ticket-accts">
              <thead><tr><th scope="col">Account</th><th scope="col" className="om-r">Equity</th><th scope="col" className="om-r">Risk</th><th scope="col" className="om-r">Size</th><th scope="col" className="om-r">At the stop</th></tr></thead>
              <tbody>
                {per.map((p) => {
                  const pl = p.placement ?? null, f = fillFor(p.accountId);
                  return (
                    <tr key={p.accountId}>
                      <td className="om-lead" data-no-i18n translate="no"><b>{nameFor(p)}</b> <span className="om-faint">· {env(p.environment) === "live" ? "Live" : "Demo"}</span>
                        {f && <span className={`om-ticket-fill ${f.status === "placed" ? "om-pos" : "om-neg"}`}>{f.status === "placed" ? `Placed ${lotsText(f.qty ?? f.lots ?? null)}${f.orderId ? ` · #${f.orderId}` : ""}` : `Not placed · ${why(f.reason)}`}</span>}
                      </td>
                      <td data-label="Equity" className="om-r om-num" data-no-i18n translate="no">{money(p.equity ?? null, p.currency ?? "USD")}</td>
                      <td data-label="Risk" className="om-r om-num">{pl ? `${pl.riskPct}%` : "—"}{pl && (pl.own || pl.capped) ? <small className="om-faint">{pl.capped ? " · capped" : " · its own"}</small> : null}</td>
                      <td data-label="Size" className="om-r om-num">{pl?.lots != null ? lotsText(pl.lots) : p.reason ? <span className="om-faint">{why(p.reason)}</span> : "—"}</td>
                      <td data-label="At the stop" className="om-r om-num" data-no-i18n translate="no">{pl?.estLossAtStop != null ? money(-pl.estLossAtStop, p.currency ?? "USD") : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <p className="om-label">{err || "Sizing it for each account…"}</p>
        ) : (
          <div className="om-field">
            <span className="om-label">No broker connected · an account size, to see the size</span>
            <input className="om-input om-num" type="number" inputMode="decimal" value={acct} placeholder="e.g. 5000" onChange={(e) => setAcct(e.target.value)} onBlur={saveAcct} />
            <span className="om-label">{lots != null ? `${lotsText(lots)} · about ${money(-(sizing?.estLossAtStop ?? 0), "USD")} at the stop` : err || "Enter an account size."}</span>
          </div>
        )}
        <dl className="om-kv">
          <div><dt>How it is placed</dt><dd>{limit ? `Now, at the current price with a price limit — not left waiting at the play's limit entry of ${priceFor(symbol, entry)}.` : "Now, at the current price with a price limit."}</dd></div>
          <div><dt>After it is placed</dt><dd>Nothing manages it: the stop and target stay where they were placed.</dd></div>
        </dl>
        {done ? (
          <p className="om-flow-ok" role="status">Placed {sideW.toLowerCase()} {pairName(symbol)}{done.placed && done.placed > 1 ? ` on ${done.placed} accounts` : done.orderId ? ` · #${done.orderId}` : ""}.</p>
        ) : connected ? (
          confirming ? (
            <div className="om-ticket-confirm" role="group" aria-label="Confirm the order">
              <p>{unconfirmed ? "Place this unconfirmed idea anyway: " : "Place it: "}{sideW.toLowerCase()} {pairName(symbol)} on {many ? `${acctCount} accounts` : "this account"}{live ? ", including a live account with real money" : ""}.</p>
              <div className="om-ticket-confirm-acts">
                <button type="button" className="om-btn" onClick={() => { setConfirming(false); execute(); }} disabled={busy || lots == null}>{unconfirmed ? "Yes, place it · manual override" : `Yes, place ${sideW.toLowerCase()}`}</button>
                <button type="button" className="om-btn-quiet" onClick={() => setConfirming(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="om-btn om-ticket-go" onClick={() => setConfirming(true)} disabled={busy || lots == null}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {busy ? "Placing…" : `Execute ${sideW.toUpperCase()}${unconfirmed ? " · manual override" : ""}${many ? ` · ${acctCount} accounts` : ""}`}
            </button>
          )
        ) : (
          <p className="om-label">Connect a broker account in FLOW to place it. <a href="/portal/trading?view=flow" className="om-go">Open FLOW</a></p>
        )}
        {err && !done && connected && per && per.length > 0 && <p className="om-flow-err" role="alert">{err}</p>}
        {connected && <p className="om-faint om-flow-small">A real order on {many ? `each of the ${acctCount} accounts above` : "the account above"} once you confirm. FLOW&rsquo;s checks still run as it is placed, so an account can be skipped — it says why.</p>}
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.04] p-4">
      <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-300/80">Execute · risk-sized</p>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs text-white/50">Risk</span>
        <div className="flex gap-1.5">
          {RISKS.map((rp) => (
            <button key={rp} onClick={() => setRisk(rp)}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-colors ${risk === rp ? "bg-emerald-500 text-[#04140b]" : "border border-white/15 text-white/70 hover:bg-white/10"}`}>
              {rp}%
            </button>
          ))}
        </div>
      </div>

      {/* Account picker (owner directive 08-31): choose where this play lands — every
          connected account (classic fan-out) or one specific account. Only shows when
          the member actually has more than one account. */}
      {connected && acctList.length > 1 && (
        <div className="mt-3">
          <span className="text-xs text-white/50">Place on</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button
              onClick={() => setTarget("all")}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-colors ${target === "all" ? "bg-emerald-500 text-[#04140b]" : "border border-white/15 text-white/70 hover:bg-white/10"}`}
            >
              All accounts ({acctList.length})
            </button>
            {acctList.map((a) => {
              const sel = target === String(a.accountId);
              const label = `#${a.accNum || a.accountId}${a.equity != null ? ` · $${Math.round(a.equity).toLocaleString()}` : ""}`;
              return (
                <button
                  key={a.accountId}
                  onClick={() => setTarget(String(a.accountId))}
                  title={a.name || undefined}
                  className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-colors ${sel ? "bg-emerald-500 text-[#04140b]" : "border border-white/15 text-white/70 hover:bg-white/10"}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {connected ? (
        <p className="mt-2 text-xs text-white/55">Equity <b className="text-white/85">{equity != null ? "$" + Math.round(equity).toLocaleString() : "—"}</b> · live from TradeLocker</p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-white/50">Account $</span>
          <input type="number" inputMode="decimal" value={acct} placeholder="e.g. 5000" onChange={(e) => setAcct(e.target.value)} onBlur={saveAcct}
            className="w-28 rounded-lg border border-white/15 bg-white/[0.04] px-2 py-1 text-sm text-white placeholder:text-white/25 focus:border-emerald-400/40 focus:outline-none" />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        {lots != null ? (
          <>
            <span className="text-white/80">Size <b className="text-white">{lots} lots</b></span>
            <span className="text-xs text-white/45">risking ~${sizing?.estLossAtStop ?? "—"} at stop</span>
          </>
        ) : (
          <span className="text-xs text-white/45">{err || "Calculating size…"}</span>
        )}
      </div>

      {!connected && (
        <a href="/portal/trading?view=flow" className="mt-2 inline-block text-xs font-semibold text-sky-300 hover:underline">◆ Connect TradeLocker to execute →</a>
      )}

      {done ? (
        <p className="mt-3 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-sm font-semibold text-emerald-300">
          ✓ Placed {side === "sell" ? "SELL" : "BUY"} {sym}{done.placed && done.placed > 1 ? ` on ${done.placed} accounts` : (done.orderId ? " · #" + done.orderId : "")}
        </p>
      ) : (
        <button onClick={execute} disabled={busy || lots == null}
          className={`mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${side === "sell" ? "bg-red-500 text-white hover:bg-red-400" : "bg-emerald-500 text-[#04140b] hover:bg-emerald-400"}`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy ? "Placing…" : acctCount > 1 ? `Execute ${side === "sell" ? "SELL" : "BUY"} · ${acctCount} accounts` : `Execute ${side === "sell" ? "SELL" : "BUY"}${lots != null ? " · " + lots + " lots" : ""}`}
        </button>
      )}
      {err && !done && <p className="mt-2 text-xs text-red-300">{err}</p>}
      <p className="mt-2 text-[11px] text-white/35">Places a real order on your connected account when you tap Execute. Stop + TP1 attached automatically.</p>
    </div>
  );
}

function FullCard({ r, onCheck, checking, onUpdate, updating, update }: { r: Result; onCheck: () => void; checking: boolean; onUpdate?: () => void; updating?: boolean; update?: TradeUpdate }) {
  const s = r.signal; const { color, Icon } = dirStyle(s.direction);
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-serif text-xl font-bold">{r.symbol}</p>
          <p className="text-xs text-white/40">
            {r.name} · {r.market} · {r.orderType}
            {s.mode && <span className={`ml-2 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${s.mode === "accelerator" ? "bg-amber-400/15 text-amber-300" : "bg-gold-light/15 text-gold-light"}`}>{s.mode === "accelerator" ? "Accelerator" : "Institutional"}</span>}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {s.status === "no_trade"
            ? <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white/60"><Ban className="h-4 w-4" /> No trade</span>
            : <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${color}`}><Icon className="h-4 w-4" />{s.direction}</span>}
          {s.grade && <GradeBadge grade={s.grade} score={s.gate_score} />}
          {s.chased && r.status === "open"
            ? <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-300"><ShieldAlert className="h-3.5 w-3.5" /> Price extended</span>
            : <StatusBadge status={r.status} hitTp={r.hitTp} />}
        </div>
      </div>

      {s.status === "no_trade" && (
        <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-3">
          <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-white/10 text-white/70"><Ban className="h-4 w-4" /></span>
          <div>
            <p className="text-sm font-bold text-white/85">NO TRADE — waiting for confirmation</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-white/70">{s.no_trade_reason || "The market hasn't confirmed this setup yet — the engine reacts only after price proves itself. Read the analysis below."}</p>
          </div>
        </div>
      )}

      {/* As-of stamp — proves the analysis reflects live price at the moment of the click */}
      {(r.as_of || r.live_price != null) && (
        <p className="mt-2 text-[11px] text-white/40">
          Analyzed at {r.as_of ? new Date(r.as_of).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "now"} · live price {fmt(r.live_price ?? r.price)}
        </p>
      )}

      {s.chased && (
        <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3">
          <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-amber-500/20 text-amber-300"><ShieldAlert className="h-4 w-4" /></span>
          <div>
            <p className="text-sm font-bold text-amber-300">Heads up — price has extended past the ideal entry</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-white/75">{s.chase_note}</p>
          </div>
        </div>
      )}

      {r.td && <LivePrice td={r.td} entry={numOk(s.entry) ? s.entry : null} direction={s.direction} closed={r.marketClosed} />}

      {r.status === "win" && (
        <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-emerald-400/30 bg-emerald-500/[0.08] px-4 py-2.5">
          <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-emerald-500/20 text-emerald-400"><Check className="h-4 w-4" /></span>
          <span className="text-sm font-semibold text-emerald-300">
            {typeof r.hitTp === "number"
              ? `Target hit — reached TP${r.hitTp} at ${fmt((s.takeProfits || [])[r.hitTp - 1])}`
              : "Target hit — this play reached take-profit"}
          </span>
        </div>
      )}
      {r.status === "loss" && (
        <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-red-500/25 bg-red-500/[0.07] px-4 py-2.5">
          <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-red-500/15 text-red-400"><ShieldAlert className="h-4 w-4" /></span>
          <span className="text-sm font-semibold text-red-300">Stopped out — price hit the stop loss before a target.</span>
        </div>
      )}

      {r.marketClosed && <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-1.5 text-xs text-amber-300/90">Market is currently closed — analysis based on the last session.</p>}

      {(s.setup || s.bias) && (
        <div className="mt-3 rounded-xl border border-gold-light/25 bg-gold-light/[0.06] px-3.5 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gold-light/80">Market read — what OM AI processed{r.method ? ` · ${r.method === "smc" ? "Smart Money" : r.method === "structure" ? "Market Structure" : "Best"}` : ""}</p>
          {s.bias && (
            <div className="mt-2">
              <p className="text-[10px] uppercase tracking-wide text-white/40">Regime / higher-timeframe bias</p>
              <p className="text-[13px] font-semibold text-white">{s.bias}</p>
            </div>
          )}
          {s.setup && (
            <div className="mt-2">
              <p className="text-[10px] uppercase tracking-wide text-white/40">Strategy chosen</p>
              <p className="text-sm font-semibold text-white">{s.setup}</p>
            </div>
          )}
        </div>
      )}

      {s.direction === "NEUTRAL" && <p className="mt-3 rounded-xl border border-white/12 bg-white/[0.03] px-3 py-2 text-xs text-white/65">No A+ setup right now — OM AI recommends standing aside. Read the analysis below.</p>}

      {Array.isArray(s.timeframes) && s.timeframes.length > 0 ? (
        <div className="mt-4 space-y-3">
          {s.flow && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <p className="mb-2 text-[10px] uppercase tracking-[0.14em] text-white/45">Market flow · bigger picture</p>
              <div className="flex flex-wrap items-center gap-2">
                <TrendChip label="4H" trend={s.flow.h4} />
                <TrendChip label="1H" trend={s.flow.h1} />
                <span className="text-white/30">→</span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase ${s.flow.dir === "LONG" ? "bg-emerald-500/15 text-emerald-400" : s.flow.dir === "SHORT" ? "bg-red-500/15 text-red-400" : "bg-white/10 text-white/60"}`}>
                  {s.flow.dir === "LONG" ? "Up" : s.flow.dir === "SHORT" ? "Down" : "Mixed"} flow
                </span>
                <span className="text-[10px] text-white/40">{s.flow.aligned ? "4H & 1H aligned" : "mixed — following the 1H"}</span>
              </div>
            </div>
          )}
          <div>
            <p className="mb-2 text-[10px] uppercase tracking-[0.14em] text-white/45">Timing · confirmations per timeframe</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {s.timeframes.map((t) => <TFBlock key={t.tf} t={t} />)}
            </div>
          </div>
          {s.verdict && (
            <div className="rounded-xl border border-gold-light/25 bg-gold-light/[0.06] px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-gold-light/80">Verdict</p>
              <p className="mt-0.5 text-sm text-white/85">{s.verdict}</p>
            </div>
          )}
        </div>
      ) : Array.isArray(s.checklist) && s.checklist.length > 0 ? (
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <p className="mb-2.5 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-white/45">
            <span>Confirmations</span>
            <span className="font-semibold text-white/70">{s.confirmed ?? s.checklist.filter((c) => c.ok).length} of {s.checklist.length} confirmed</span>
          </p>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {s.checklist.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <span className={`grid h-4 w-4 flex-shrink-0 place-items-center rounded-full ${c.ok ? "bg-emerald-500/15 text-emerald-400" : "bg-white/[0.04] text-white/25"}`}>
                  {c.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                </span>
                <span className={c.ok ? "text-white/80" : "text-white/40"}>{c.label}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {r.candles && r.candles.length > 3 && <MiniChart candles={r.candles} entry={numOk(s.entry) ? s.entry : null} sl={numOk(s.stopLoss) ? s.stopLoss : null} tps={(s.takeProfits || []).filter(numOk)} hitTp={r.status === "win" ? r.hitTp : undefined} />}

      {numOk(s.entry) && numOk(s.stopLoss) && (s.takeProfits || []).some(numOk) && (
        <div className="mt-4">
          <Levels direction={s.direction} entry={s.entry} stop={s.stopLoss} pip={pipSize(r.symbol)}
            rr={(s.takeProfits || []).filter(numOk).reduce((m, t) => Math.max(m, Math.abs(s.entry! - s.stopLoss!) > 0 ? +(Math.abs(t - s.entry!) / Math.abs(s.entry! - s.stopLoss!)).toFixed(2) : 0), 0) || undefined}
            targets={(s.takeProfits || []).filter(numOk).map((t, i) => ({ label: `TP${i + 1}`, price: t }))} />
        </div>
      )}
      {s.direction !== "NEUTRAL" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <CopyAllBtn text={buildTradeText({ direction: s.direction, entry: s.entry, stopLoss: s.stopLoss, takeProfits: s.takeProfits, fmt })} />
        </div>
      )}

      {/* Execute on desktop (owner 09-04): ANY directional play with an entry and a
          stop can be placed on the member's accounts — no status gate, and a
          missing TP no longer hides the panel (the order just goes out without one). */}
      {(s.direction === "LONG" || s.direction === "SHORT") && numOk(s.entry) && numOk(s.stopLoss) && (
        <ExecuteSignal
          symbol={r.symbol}
          direction={s.direction}
          entry={s.entry as number}
          stop={s.stopLoss as number}
          tp={(s.takeProfits || []).filter(numOk)[0] ?? null}
        />
      )}

      {s.direction !== "NEUTRAL" && s.status !== "no_trade" && numOk(s.entry) && numOk(s.stopLoss) && (
        <TradeChat trade={{ td: r.td, symbol: r.symbol, style: r.style, interval: r.interval, direction: s.direction, entry: s.entry, stopLoss: s.stopLoss, takeProfits: (s.takeProfits || []).filter(numOk), since: r.asOf || r.as_of }} />
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/50">
        <span>Confidence: <span className="font-semibold text-white/80">{s.confidence}</span></span>
        {s.trend_rating && <span>Trend: <span className="font-semibold text-white/80">{s.trend_rating}</span></span>}
        {s.momentum_rating && <span>Momentum: <span className="font-semibold text-white/80">{s.momentum_rating}</span></span>}
        <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {s.timeframe}</span>
        {r.status === "open" && s.direction !== "NEUTRAL" && (
          <span className="ml-auto inline-flex items-center gap-2">
            {onUpdate && (
              <button onClick={onUpdate} disabled={updating} className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/40 bg-sky-400/10 px-3 py-1 text-[11px] font-semibold text-sky-300 hover:bg-sky-400/20 disabled:opacity-40">
                {updating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />} Get update
              </button>
            )}
            <button onClick={onCheck} disabled={checking} className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/70 hover:bg-white/10 disabled:opacity-40">
              {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Check result
            </button>
          </span>
        )}
      </div>

      {update && <UpdatePanel u={update} />}

      <p className="mt-3 text-sm leading-relaxed text-white/80">{s.rationale}</p>
      <div className="mt-3 space-y-1 text-xs text-white/55">
        {s.bias && <p><span className="text-white/40">HTF bias:</span> {s.bias}</p>}
        {s.poi && <p><span className="text-white/40">POI:</span> {s.poi}</p>}
        {s.liquidityTarget && <p><span className="text-white/40">Targeting:</span> {s.liquidityTarget}</p>}
      </div>
      {s.invalidation && <p className="mt-2 text-xs text-white/45"><span className="text-white/60">Invalidation:</span> {s.invalidation}</p>}

      <p className="mt-4 border-t border-white/10 pt-3 text-[11px] text-white/35">Price {fmt(r.price)} · as of {r.asOf} · live data via Twelve Data. Educational analysis, not financial advice — verify before trading.</p>
    </div>
  );
}

function MiniChart({ candles, entry, sl, tps, hitTp }: { candles: Candle[]; entry: number | null; sl: number | null; tps: number[]; hitTp?: number }) {
  const W = 320, H = 160, padT = 8, padB = 8, padL = 4, padR = 42;
  // Robust price window from the candle BODIES (open/close are trustworthy; a
  // glitch feed only lies in the high/low wicks). We take the 2nd–98th
  // percentile of all body values, allow a margin for genuine wicks, then clip
  // every candle into that window — so one bad spike bar can never blow out the
  // whole scale and flatten the real price action.
  const bodyVals = candles.flatMap((c) => [c.o, c.c]).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const pctl = (p: number) => bodyVals[Math.min(bodyVals.length - 1, Math.max(0, Math.round(p * (bodyVals.length - 1))))];
  const bodyLo = bodyVals.length ? pctl(0.02) : Math.min(...candles.map((c) => c.l));
  const bodyHi = bodyVals.length ? pctl(0.98) : Math.max(...candles.map((c) => c.h));
  const margin = (bodyHi - bodyLo || Math.abs(bodyHi) * 0.002 || 1) * 0.5;
  const winLo = bodyLo - margin, winHi = bodyHi + margin;
  const clip = (n: number) => Math.min(winHi, Math.max(winLo, n));
  // Draw with clipped wicks so a spike bar renders as a normal candle.
  const cand = candles.map((c) => ({ ...c, h: clip(Math.max(c.h, c.o, c.c)), l: clip(Math.min(c.l, c.o, c.c)), o: clip(c.o), c: clip(c.c) }));
  const cHi = Math.max(...cand.map((c) => c.h));
  const cLo = Math.min(...cand.map((c) => c.l));
  const cRange = cHi - cLo || 1;
  // Only levels within a sane band of the candle range are plotted/scaled.
  const inBand = (n: unknown): n is number => numOk(n) && n >= cLo - cRange * 0.6 && n <= cHi + cRange * 0.6;
  const levels = [entry, sl, ...tps].filter(inBand);
  const max0 = Math.max(cHi, ...levels), min0 = Math.min(cLo, ...levels);
  const pad = (max0 - min0 || 1) * 0.06;
  const max = max0 + pad, min = min0 - pad, span = max - min || 1;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / cand.length, bodyW = Math.max(1.2, slot * 0.6);
  const y = (p: number) => padT + ((max - p) / span) * plotH;
  const x = (i: number) => padL + i * slot + slot / 2;
  const price = (p: number) => (Math.abs(p) >= 1000 ? p.toFixed(0) : Math.abs(p) >= 1 ? p.toFixed(2) : p.toFixed(4));

  // Build the labelled levels, then push their TEXT apart so labels never overlap
  // when entry/SL/TP sit close together (the dashed line stays at the true price).
  const raw: { col: string; p: number; label: string; hit?: boolean }[] = [
    { col: "#ffffff", p: entry as number, label: "Entry" },
    { col: "#f87171", p: sl as number, label: "SL" },
    ...tps.map((t, i) => ({ col: "#34d399", p: t, label: `TP${i + 1}`, hit: typeof hitTp === "number" && i + 1 <= hitTp })),
  ].filter((L) => inBand(L.p));
  const placed = raw
    .map((L) => ({ ...L, ly: y(L.p) }))
    .sort((a, b) => a.ly - b.ly);
  const GAP = 9;
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].ly - placed[i - 1].ly < GAP) placed[i].ly = placed[i - 1].ly + GAP;
  }
  // keep the stack inside the frame
  const overflow = placed.length ? placed[placed.length - 1].ly - (H - 4) : 0;
  if (overflow > 0) placed.forEach((L) => { L.ly -= overflow; });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 w-full rounded-xl border border-white/10 bg-black/30">
      {cand.map((c, i) => {
        const col = c.c >= c.o ? "#34d399" : "#f87171";
        const yo = y(c.o), yc = y(c.c);
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={0.5} opacity={0.7} />
            <rect x={x(i) - bodyW / 2} y={Math.min(yo, yc)} width={bodyW} height={Math.max(0.6, Math.abs(yc - yo))} fill={col} opacity={0.85} />
          </g>
        );
      })}
      {placed.map((L, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(L.p)} y2={y(L.p)} stroke={L.col} strokeWidth={L.hit ? 1.2 : 0.7} strokeDasharray={L.hit ? undefined : "3 2"} opacity={L.hit ? 1 : 0.85} />
          {/* thin connector from the true line to the (possibly nudged) label */}
          <line x1={W - padR} x2={W - padR + 3} y1={y(L.p)} y2={L.ly} stroke={L.col} strokeWidth={0.5} opacity={0.5} />
          <text x={W - padR + 4} y={L.ly + 2} fill={L.col} fontSize={6.5} fontWeight="bold">{L.label}{L.hit ? " ✓" : ""} {price(L.p)}</text>
        </g>
      ))}
    </svg>
  );
}

function TrendChip({ label, trend }: { label: string; trend: string }) {
  const up = trend === "bullish", down = trend === "bearish";
  const col = up ? "text-emerald-400 bg-emerald-500/10" : down ? "text-red-400 bg-red-500/10" : "text-white/50 bg-white/[0.06]";
  const Icon = up ? ArrowUp : down ? ArrowDown : Minus;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${col}`}>
      <span className="text-white/40">{label}</span><Icon className="h-3 w-3" />{up ? "Bull" : down ? "Bear" : "Range"}
    </span>
  );
}

function TFBlock({ t }: { t: { tf: string; trend: string; confirmed: number; total: number; checklist: { label: string; ok: boolean }[]; unavailable?: boolean } }) {
  const up = t.trend === "bullish", down = t.trend === "bearish";
  const tcol = up ? "text-emerald-400" : down ? "text-red-400" : "text-white/45";
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-white/80">{t.tf}</span>
        <span className={`text-[10px] font-semibold uppercase ${tcol}`}>{up ? "Bull" : down ? "Bear" : "Range"}</span>
      </div>
      {t.unavailable ? (
        <p className="mt-2 text-[11px] text-white/30">data unavailable</p>
      ) : (
        <>
          <p className="mt-1 text-[10px] uppercase tracking-wide text-white/40">{t.confirmed}/{t.total} confirmed</p>
          <ul className="mt-1.5 space-y-1">
            {t.checklist.map((c, i) => (
              <li key={i} className="flex items-center gap-1.5 text-[11px]">
                <span className={`grid h-3.5 w-3.5 flex-shrink-0 place-items-center rounded-full ${c.ok ? "bg-emerald-500/15 text-emerald-400" : "bg-white/[0.04] text-white/25"}`}>
                  {c.ok ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
                </span>
                <span className={c.ok ? "text-white/75" : "text-white/35"}>{c.label}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

