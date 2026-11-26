"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Activity, ArrowRight, Check, ChevronDown, CircleAlert, Fingerprint, Link2, LockKeyhole,
  Mic, Play, Radio, RotateCw, ShieldCheck, SlidersHorizontal, Sparkles, Square, TrendingDown, TrendingUp, Waves } from "lucide-react";
import { openAtlas } from "@/lib/atlas/open";
import { StrataChart } from "./StrataChart";
import { priceStructure, type ChartFrame } from "./priceStructure";
import type { Analysis, Bar, Regime, Scenario } from "@/lib/strata/engine";
import { generatePossibleEntry, type GeneratedOpportunity } from "@/lib/strata/generate";
import { VisionDirection, VisionLevels, type VisionFact } from "@/components/om/vision/VisionDirection";
import { MarketStory, storyDirection, type StoryFeed } from "../simple/MarketStory";
import { useExperienceMode } from "@/components/om/experience";
import "./strata.css";

type Feed = {
  ok?: boolean; analysis: Analysis; asOf: string; lastCandleAt: string; price: number;
  quoteSource: "stream" | "delayed" | "candle"; quoteReceivedAt: string | null; quoteProviderAt?: string | null; marketClosed: boolean;
  dataStale: boolean; bars: { m5: Bar[]; m15: Bar[]; h1: Bar[]; h4: Bar[] };
};
type Account = { accountId: string; connectionId: string; name: string; masked: string;
  environment: "demo" | "live"; connected: boolean; selected: boolean };
type Setting = { account_id: string; connection_id: string; environment: "demo" | "live";
  mode: "off" | "paper"; risk_pct: number | string; max_entries_per_day: number };
type Paper = { id: string; account_id: string; connection_id: string; side: "buy" | "sell";
  entry: number; stop: number; target: number; opened_at: string; closed_at: string | null;
  status: "open" | "target" | "stopped"; exit_price: number | null };
type Automation = { ok?: boolean; accounts?: Account[]; settings?: Setting[]; paper?: Paper[];
  execution?: { mode: string; liveOrdersEnabled: boolean; demoBrokerOrdersEnabled: boolean } };
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const fixed = (n: number | null) => n === null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const positive = (value: unknown): value is number => num(value) !== null && Number(value) > 0;
const dated = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
function validScenario(value: unknown): value is Scenario | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const plan = value as Scenario;
  return ["break_retest", "range_fade"].includes(plan.type) && ["buy", "sell"].includes(plan.side) &&
    ["watch", "breakout", "retest", "ready"].includes(plan.stage) &&
    [plan.id, plan.title, plan.trigger, plan.invalidation].every((item) => typeof item === "string") &&
    positive(plan.level) && (plan.entry === null || positive(plan.entry)) && (plan.stop === null || positive(plan.stop)) &&
    Array.isArray(plan.targets) && plan.targets.every(positive) && (plan.riskReward === null || num(plan.riskReward) !== null) &&
    num(plan.score) !== null && typeof plan.reference === "boolean" && num(plan.startedAt) !== null &&
    !!plan.zone && positive(plan.zone.low) && positive(plan.zone.high) && plan.zone.low <= plan.zone.high &&
    Array.isArray(plan.checks) && plan.checks.every((step) => step && typeof step.label === "string" && typeof step.detail === "string" && typeof step.done === "boolean");
}
function validFeed(value: unknown): value is Feed {
  if (!value || typeof value !== "object") return false;
  const state = value as Feed, analysis = state.analysis;
  return positive(state.price) && dated(state.asOf) && dated(state.lastCandleAt) &&
    ["stream", "delayed", "candle"].includes(state.quoteSource) && (state.quoteReceivedAt === null || dated(state.quoteReceivedAt)) &&
    (state.quoteProviderAt == null || dated(state.quoteProviderAt)) &&
    typeof state.marketClosed === "boolean" && typeof state.dataStale === "boolean" && !!state.bars &&
    [state.bars.m5, state.bars.m15, state.bars.h1, state.bars.h4].every((bars) => Array.isArray(bars) && bars.every((bar) => bar &&
      [bar.t, bar.o, bar.h, bar.l, bar.c].every(positive) && bar.h >= Math.max(bar.o, bar.c, bar.l) && bar.l <= Math.min(bar.o, bar.c, bar.h))) &&
    !!analysis && ["uptrend", "downtrend", "range", "transition"].includes(analysis.regime) &&
    [analysis.regimeLabel, analysis.structure, analysis.momentum, analysis.status].every((item) => typeof item === "string") &&
    [analysis.asOf, analysis.atr, analysis.efficiency].every((item) => num(item) !== null) &&
    !!analysis.range && [analysis.range.high, analysis.range.low, analysis.range.topTouches, analysis.range.bottomTouches].every((item) => num(item) !== null) &&
    strings(analysis.reasons) && strings(analysis.warnings) && validScenario(analysis.primary) && validScenario(analysis.secondary);
}
function validOpportunity(value: unknown): value is GeneratedOpportunity {
  if (!value || typeof value !== "object") return false;
  const idea = value as GeneratedOpportunity;
  return ["ready", "conditional", "aggressive", "none"].includes(idea.tier) && typeof idea.label === "string" &&
    strings(idea.reasons) && strings(idea.confirmationNeeded) && typeof idea.disclaimer === "string" &&
    positive(idea.asOf) && positive(idea.generatedAt) && (idea.quoteAtGeneration === null || positive(idea.quoteAtGeneration)) &&
    validScenario(idea.scenario) && (idea.tier === "none" ? idea.scenario === null && idea.direction === null :
      idea.scenario !== null && idea.direction === idea.scenario.side && (idea.tier !== "ready" || idea.scenario.stage === "ready" && !idea.scenario.reference));
}
function age(timestamp: string | number | null | undefined, now: number): string {
  const t = typeof timestamp === "number" ? timestamp : Date.parse(timestamp ?? "");
  if (!Number.isFinite(t) || !now) return "No timestamp";
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  return seconds < 2 ? "just now" : seconds < 60 ? seconds + "s ago"
    : seconds < 3600 ? Math.round(seconds / 60) + "m ago" : Math.round(seconds / 3600) + "h ago";
}
const CASES: { key: Exclude<Regime, "transition">; title: string; subtitle: string;
  detail: string; icon: typeof TrendingUp }[] = [
  { key: "uptrend", title: "Trending up", subtitle: "Break the high", icon: TrendingUp,
    detail: "Higher highs + higher lows. Let a candle close above the previous confirmed high, then buy only after the new support is successfully retested." },
  { key: "downtrend", title: "Trending down", subtitle: "Break the low", icon: TrendingDown,
    detail: "Lower highs + lower lows. Let a candle close below the previous confirmed low, then sell only after the broken low is retested as resistance." },
  { key: "range", title: "Moving sideways", subtitle: "Trade the edges", icon: Waves,
    detail: "Buy a bullish rejection at range support or sell a bearish rejection at range resistance. A break through the boundary cancels the range-fade idea." },
];

function StatusDot({ fresh, closed }: { fresh: boolean; closed: boolean }) {
  return <span className="strata-live-state" data-fresh={fresh} data-closed={closed}>
    <i />{closed ? "SESSION CLOSED" : fresh ? "LIVE PRICE" : "QUOTE DELAYED"}</span>;
}
function PlanLevels({ plan }: { plan: Scenario | null }) {
  const rows = [
    ["ENTRY", plan?.entry ?? null],
    ["STOP LOSS", plan?.stop ?? null],
    ["TARGET 01", plan?.targets[0] ?? null],
    ["TARGET 02", plan?.targets[1] ?? null],
    ["R : R", plan?.riskReward ?? null],
  ] as const;
  return <div className="strata-levels" aria-label="Price-action trade levels">
    {rows.map(([label, value]) => <div key={label} data-kind={label}>
      <small>{label}</small><strong>{label === "R : R" ? value === null ? "—" : value.toFixed(2) + "R" : fixed(value)}</strong>
    </div>)}
  </div>;
}
export function StrataWorkspace() {
  const { isSimple } = useExperienceMode();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [now, setNow] = useState(0);
  const [tick, setTick] = useState<{ price: number; receivedAt: string; providerAt: string | null } | null>(null);
  const [modeGuide, setModeGuide] = useState<Regime | null>(null);
  const [generated, setGenerated] = useState<GeneratedOpportunity | null>(null);
  const [generatedSnapshot, setGeneratedSnapshot] = useState<Feed | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [alternative, setAlternative] = useState(false);
  const [chartFrame, setChartFrame] = useState<ChartFrame>("m15");
  const [accountData, setAccountData] = useState<Automation | null>(null);
  const [accountKey, setAccountKey] = useState("");
  const [risk, setRisk] = useState(0.25);
  const [maxDaily, setMaxDaily] = useState(2);
  const [settingBusy, setSettingBusy] = useState(false);
  const [confirmPaper, setConfirmPaper] = useState(false);
  const [accountError, setAccountError] = useState("");
  const request = useRef(0);
  const generation = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (document.visibilityState === "hidden") return;
    const id = ++request.current;
    try {
      const response = await fetch("/api/strata", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok || !validFeed(body)) throw new Error(body?.detail ?? "Gold market feed unavailable");
      if (id === request.current) { setFeed(body); setError(""); }
    } catch (err) { if (id === request.current) setError(err instanceof Error ? err.message : "Unable to read gold."); }
    finally { if (id === request.current) setBusy(false); }
  }, []);
  const refreshAccounts = useCallback(async () => {
    try {
      const response = await fetch("/api/strata/automation", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.ok) { setAccountData(payload as Automation); setAccountError(""); }
      else setAccountError("Account connection status is temporarily unavailable.");
    } catch { setAccountError("Unable to refresh connected accounts."); }
  }, []);

  useEffect(() => {
    setNow(Date.now());
    void refresh(); void refreshAccounts();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const scanner = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 25_000);
    const accounts = setInterval(() => { if (document.visibilityState === "visible") void refreshAccounts(); }, 45_000);
    const visible = () => { if (document.visibilityState === "visible") { void refresh(); void refreshAccounts(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { request.current++; clearInterval(clock); clearInterval(scanner); clearInterval(accounts);
      document.removeEventListener("visibilitychange", visible); };
  }, [refresh, refreshAccounts]);
  useEffect(() => () => {
    const pending = generation.current;
    generation.current = null;
    pending?.abort();
  }, []);
  useEffect(() => {
    if (!generated) return;
    const frame = window.requestAnimationFrame(() => {
      const result = document.getElementById("strata-opportunity");
      result?.focus({ preventScroll: true });
      result?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [generated]);
  useEffect(() => {
    let active = true, running = false;
    const load = async () => {
      if (!active || running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const response = await fetch("/api/floor/atlas-ticks", { cache: "no-store" });
        const body = await response.json().catch(() => null);
        const found = body?.ticks?.find((r: { symbol?: string }) => r.symbol === "XAU/USD");
        if (active && response.ok && found && positive(found.price) && dated(found.receivedAt) &&
          (found.providerAt == null || found.providerAt === "" || dated(found.providerAt))) {
          setTick((previous) => !previous || Date.parse(found.receivedAt) >= Date.parse(previous.receivedAt)
            ? { price: found.price, receivedAt: found.receivedAt, providerAt: found.providerAt || null } : previous);
        }
      } catch { /* Only real data changes the live display. */ }
      finally { running = false; }
    };
    void load();
    const id = setInterval(() => void load(), 1500);
    return () => { active = false; clearInterval(id); };
  }, []);

  const generateEntry = async () => {
    if (generation.current) return;
    const controller = new AbortController();
    generation.current = controller;
    const timeout = setTimeout(() => controller.abort(), 22_000);
    setGenerating(true);
    setGenerateError("");
    try {
      const response = await fetch("/api/strata/generate", { method: "POST", cache: "no-store", signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (generation.current !== controller) return;
      if (controller.signal.aborted) throw new Error("Generation timed out");
      if (!response.ok || !payload?.ok || !validOpportunity(payload?.idea) || !validFeed(payload?.state))
        throw new Error(response.status === 401 ? "Your session has ended. Sign in again to generate a current setup." :
          typeof payload?.detail === "string" ? payload.detail : "STRATA could not verify this response. Retry to request a fresh market read.");
      // The scenario and the chart are a single immutable analysis snapshot.
      // A newer live quote can never silently rewrite an earlier generated plan.
      request.current++; // An older background read must not overwrite this completed request.
      setGenerated(payload.idea);
      setGeneratedSnapshot(payload.state);
      setFeed(payload.state);
      setBusy(false);
      setAlternative(false);
      setError("");
    } catch (err) {
      if (generation.current === controller) setGenerateError(controller.signal.aborted
        ? "The current market read took too long. Retry generation; no trade was submitted."
        : err instanceof Error ? err.message : "Unable to generate a verified setup. Please retry.");
    } finally {
      clearTimeout(timeout);
      if (generation.current === controller) { generation.current = null; setGenerating(false); }
    }
  };

  const analysis = feed?.analysis ?? null;
  const open = !feed?.marketClosed;
  const tickFresh = !!tick && open && now - Date.parse(tick.receivedAt) >= -3000 &&
    now - Date.parse(tick.receivedAt) <= 6000 && (!tick.providerAt ||
      now - Date.parse(tick.providerAt) >= -3000 && now - Date.parse(tick.providerAt) <= 6000);
  const feedQuoteFresh = !!feed && open && feed.quoteSource === "stream" && !!feed.quoteReceivedAt &&
    now - Date.parse(feed.quoteReceivedAt) >= -3000 && now - Date.parse(feed.quoteReceivedAt) <= 6000 &&
    (!feed.quoteProviderAt || now - Date.parse(feed.quoteProviderAt) >= -3000 && now - Date.parse(feed.quoteProviderAt) <= 6000);
  const quote = tickFresh ? tick!.price : num(feed?.price);
  const chosen = alternative && analysis?.secondary ? analysis.secondary : analysis?.primary ?? null;
  // The first screen always maps a defensible CONDITIONAL watch when one exists,
  // even when the strict auto-execution engine says "NO_SETUP".
  const liveIdea = useMemo(() => {
    if (!feed) return null;
    return generatePossibleEntry({
      analysis: feed.analysis, bars: feed.bars.m15, price: quote ?? feed.price,
      generatedAt: now || Date.parse(feed.asOf), marketOpen: !feed.marketClosed,
      quoteFresh: tickFresh || feedQuoteFresh, dataStale: feed.dataStale || !!error,
    });
  }, [feed, quote, now, tickFresh, feedQuoteFresh, error]);
  const displayedPlan = generated ? generated.scenario : chosen ?? liveIdea?.scenario ?? null;
  const displayFeed = generated && generatedSnapshot ? generatedSnapshot : feed;
  const displayAnalysis = displayFeed?.analysis ?? analysis;
  const chartPrice = generated ? generated.quoteAtGeneration ?? displayFeed?.price : quote ?? displayFeed?.price;
  const structure = useMemo(() => priceStructure(displayFeed?.bars[chartFrame] ?? [], displayedPlan?.side, chartPrice ?? null),
    [displayFeed?.bars, chartFrame, displayedPlan?.side, chartPrice]);
  const displayedReasons = generated ? generated.reasons : chosen ? analysis?.reasons ?? [] :
    liveIdea?.scenario ? liveIdea.reasons : analysis?.reasons ??
      ["Waiting for a confirmed market structure."];
  const stage = analysis?.status ?? "NO_SETUP";
  const planReady = !generated && !error && liveIdea?.tier === "ready" && chosen?.id === liveIdea.scenario?.id;
  const reg = analysis?.regime ?? "transition";
  const detectedRegime = analysis && !feed?.dataStale && !error && reg !== "transition"
    ? reg : null;
  const generatedOutdated = !!generated && now > 0 &&
    (now - generated.generatedAt > 20 * 60_000 || (analysis?.asOf ?? 0) > generated.asOf);
  const heroBias = reg === "uptrend" ? "buy" : reg === "downtrend" ? "sell"
    : reg === "range" ? "range" : "mixed";
  const contextH4 = feed?.bars.h4 ?? [];
  const changeH4 = contextH4.length > 1 ? contextH4[contextH4.length-1].c -
    contextH4[contextH4.length-2].c : null;
  const facts: VisionFact[] = [
    {label:"4H TREND",value:changeH4===null?"Unavailable":
      changeH4>0?"Up":changeH4<0?"Down":"Flat",
      tone:changeH4===null?"watch":changeH4>0?"up":changeH4<0?"down":"neutral"},
    {label:"1H STRUCTURE",value:analysis?.structure ?? "Reading",
      tone:reg==="uptrend"?"up":reg==="downtrend"?"down":
        reg==="range"?"neutral":"watch"},
    {label:"15M MOMENTUM",value:analysis?.momentum ?? "Reading",
      tone:analysis?.momentum==="Rising"?"up":analysis?.momentum==="Falling"?"down":"watch"},
    {label:"RANGE TESTS",value:analysis?
      Math.min(analysis.range.topTouches,analysis.range.bottomTouches)+" both sides":"Reading",
      tone:analysis&&analysis.range.topTouches>=2&&analysis.range.bottomTouches>=2?"ok":"watch"},
    {label:"ENTRY TRIGGER",value:planReady?"Qualified":
      displayedPlan?"Watch confirmation":"Awaiting",
      tone:planReady?"ok":"watch"},
  ];
  const tacticalWatch = reg === "transition" && !!displayedPlan;
  const displayedBias = tacticalWatch && displayedPlan ? displayedPlan.side : heroBias;
  const signalHeadline = tacticalWatch && displayedPlan
    ? (displayedPlan.side === "buy" ? "BULLISH WATCH" : "BEARISH WATCH") : undefined;
  const referenceLevels = !displayedPlan || displayedPlan.reference ||
    displayedPlan.stage !== "ready" || (generated ? generated.tier !== "ready" : !planReady);
  const accounts = accountData?.accounts ?? [];
  const selectedAccount = accounts.find((a) => a.connectionId + ":" + a.accountId === accountKey) ??
    accounts.find((a) => a.selected) ?? accounts[0] ?? null;
  const saved = accountData?.settings?.find((s) => s.connection_id === selectedAccount?.connectionId &&
    s.account_id === selectedAccount?.accountId) ?? null;
  const currentMode = saved?.mode ?? "off";
  useEffect(() => {
    if (currentMode === "paper" && saved) {
      setRisk(Number(saved.risk_pct));
      setMaxDaily(Number(saved.max_entries_per_day));
    }
  }, [currentMode, saved?.risk_pct, saved?.max_entries_per_day]);
  const paper = accountData?.paper?.filter((p) =>
    p.connection_id === selectedAccount?.connectionId && p.account_id === selectedAccount?.accountId) ?? [];
  const activePaper = paper.find((p) => p.status === "open");
  const completed = displayedPlan?.checks.filter((c) => c.done).length ?? 0;
  const togglePaper = async (next: "off" | "paper") => {
    if (!selectedAccount || settingBusy) return;
    setSettingBusy(true); setAccountError("");
    try {
      const response = await fetch("/api/strata/automation", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "settings", accountId: selectedAccount.accountId,
          connectionId: selectedAccount.connectionId, mode: next, riskPct: risk, maxEntriesPerDay: maxDaily }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.detail ?? "Could not update paper automation.");
      setConfirmPaper(false);
      await refreshAccounts();
    } catch (err) { setAccountError(err instanceof Error ? err.message : "Unable to save settings."); }
    finally { setSettingBusy(false); }
  };
  const askAtlas = () => {
    const detail = analysis ? [
      "STRATA current gold regime: " + analysis.regimeLabel,
      "Current stage: " + analysis.status,
      "Key range " + fixed(analysis.range.low) + "–" + fixed(analysis.range.high),
      displayedPlan ? (generated ? "Generated " + generated.label + ", not a confirmed trade. " : "") +
        displayedPlan.title + "; " + displayedPlan.trigger + " Invalidation: " + displayedPlan.invalidation
        : "No trade is qualified",
    ].join(". ") : "Explain how to analyze the gold price action";
    openAtlas({ question: "Explain this price action map in simple terms. " + detail,
      context: { source: "floor", label: "STRATA · gold price action", data: {
        symbol: "XAUUSD", price: quote, stage, asOf: feed?.asOf ?? null,
        ...(displayedPlan ? { direction: displayedPlan.side, entry: displayedPlan.entry, stop: displayedPlan.stop, targets: displayedPlan.targets } : {}),
      } } });
  };
  const storyFeed: StoryFeed = feed?.marketClosed ? "closed" : error || feed?.dataStale || generatedOutdated ? "delayed" :
    !displayFeed ? busy ? "loading" : "unavailable" : generated ? "recorded" : !tickFresh && !feedQuoteFresh ? "delayed" : "current";
  const storyHeadline = !displayedPlan ? "Waiting for a clear pattern." :
    !referenceLevels ? "Gold confirmed the setup." :
    structure?.reaction === "Recovery" ? "Gold bounced. Can it hold?" :
    structure?.reaction === "Pullback" ? "Gold turned lower. Will it hold?" :
    displayedPlan.type === "range_fade" ? "Watching the edge of the range." :
    displayedPlan.stage === "watch" ? "Watching for a break." : "Watching the retest.";
  const storyNext = !displayedPlan ? "Strata is checking the recent swings." :
    !referenceLevels ? "Review the entry and stop in the plan." :
    displayedPlan.type === "range_fade" ? "Watch for price to turn near " + fixed(displayedPlan.level) + "." :
    displayedPlan.stage === "breakout" ? "Watch for price to return to " + fixed(displayedPlan.level) + "." :
    displayedPlan.stage === "retest" ? "Watch for a 15m close back " + (displayedPlan.side === "buy" ? "above " : "below ") + fixed(displayedPlan.level) + "." :
    "Watch for a 15m close " + (displayedPlan.side === "buy" ? "above " : "below ") + fixed(displayedPlan.level) + ".";
  return <div className="strata-workstation" data-regime={reg} data-experience={isSimple ? "simple" : "advanced"}>
    <header className="strata-header">
      <div className="strata-ident"><span className="strata-emblem"><i /><i /><i /></span>
        <div>{!isSimple && <span className="strata-kicker">ONE MISSION / PRICE ACTION INTELLIGENCE</span>}
          <h1>STRATA{!isSimple && <span className="strata-version">01</span>}</h1>
          <p>{isSimple ? "Gold price action" : "See the structure. Read the setup. Trade the retest."}</p></div></div>
      <div className="strata-header-side">
        <StatusDot fresh={tickFresh} closed={!!feed?.marketClosed} />
        <button type="button" className="strata-icon-button" onClick={() => { setBusy(true); void refresh(); }}
          aria-label="Refresh price-action analysis"><RotateCw size={17} /></button>
      </div>
    </header>

    {isSimple ? <MarketStory compact headline={storyHeadline} className="strata-market-story" market="Gold" direction={storyDirection(displayAnalysis?.regime)}
      stage={displayedPlan ? referenceLevels ? "forming" : "review" : "looking"} feed={storyFeed} next={storyNext}
      stamp={generated ? "Saved plan · " + age(generated.generatedAt, now) : undefined}/> : <VisionDirection product="STRATA" bias={displayedBias} headline={signalHeadline}
      eyebrow="ONE MISSION · GOLD PRICE ACTION INTELLIGENCE"
      status={feed?.marketClosed?"LAST SESSION":tickFresh?"LIVE FEED":"QUOTE DELAYED"}
      quote={quote} quoteLabel={tickFresh?"LIVE TICK":feed?"LAST RECORDED":"AWAITING DATA"}
      tagline={tacticalWatch?"MIXED STRUCTURE · SPECULATIVE SCENARIO ONLY":reg==="uptrend"?"HIGHER HIGHS / HIGHER LOWS":
        reg==="downtrend"?"LOWER HIGHS / LOWER LOWS":
        reg==="range"?"TRADING BETWEEN SUPPORT AND RESISTANCE":
        "HIGHER TIMEFRAMES NOT ALIGNED"}
      score={displayedPlan?.score ?? null} scoreName="STRUCTURE SCORE"
      facts={facts}
      note={reg==="transition"?"Tactical directional watch, not a confirmed trend or executable signal. All entry levels require a completed price-action trigger.":undefined} />}
    {error && <p className="strata-warning" role="alert"><CircleAlert size={15} aria-hidden="true" />
      {error} {feed ? "Showing the last available analysis." : "No trade levels will be shown."}</p>}
    {!!feed?.dataStale && <p className="strata-warning">Confirmed candles are stale. Entries are disabled until they refresh.</p>}
    {!isSimple && !!analysis?.warnings.length && <div className="strata-warnings">
      {analysis.warnings.map((w) => <p key={w}><CircleAlert size={14} aria-hidden="true"/>{w}</p>)}</div>}

    <section id="strata-opportunity" className="strata-setup strata-vision-setup"
      tabIndex={-1} data-generated={!!generated} data-idea-tier={generated?.tier ?? liveIdea?.tier ?? "default"}>
      {generated && <div className="strata-generated-result" data-tier={generated.tier} role="status">
        <div><span className="strata-kicker">GENERATED · {age(generated.generatedAt, now)}</span>
          <strong>{generated.label}</strong>
          <small>{generated.tier === "ready"?"Confirmed by the standard engine when generated":
            generated.tier === "none" ? "Read complete · no qualified trade" : "Conditional reference · confirmation required"}</small>
          {!isSimple && <small>Gold {fixed(generated.quoteAtGeneration)} · Captured {new Date(generated.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small>}
          {generatedOutdated && <small className="strata-generated-old">Previous snapshot. Regenerate for current conditions.</small>}
        </div>
        <button type="button" onClick={()=>{setGenerated(null);setGeneratedSnapshot(null);setGenerateError("");}}>
          Back to live</button>
      </div>}
      {!isSimple && <div className="strata-vision-setup-top">
        <div><span className="strata-kicker">PRICE ACTION OPPORTUNITY · XAU/USD</span>
          <h2>{displayedPlan ? displayedPlan.title : generated ? "No current trade is qualified" : "Watching for a qualifying price-action setup"}</h2>
          <span className="strata-vision-setup-state" data-side={displayedPlan?.side ?? "none"}>
            {generated ? generated.label : planReady ? "ENGINE CONFIRMED" :
              displayedPlan ? liveIdea?.label ?? "CONDITIONAL WATCH" : "NO DEFENSIBLE SETUP"}
          </span>
        </div>
        {displayedPlan?.riskReward != null && <b className="strata-vision-rr">R:R {displayedPlan.riskReward.toFixed(2)} : 1</b>}
      </div>}
      {!generated && analysis?.secondary && <div className="strata-scenario-switch" role="group" aria-label="Range scenarios">
        <button type="button" aria-pressed={!alternative} onClick={()=>setAlternative(false)}>Near edge</button>
        <button type="button" aria-pressed={alternative} onClick={()=>setAlternative(true)}>Opposite edge</button>
      </div>}
      {displayFeed ? <StrataChart frame={chartFrame} onFrame={setChartFrame} structure={structure}
        watchPrice={storyFeed === "current" || storyFeed === "recorded" ? displayedPlan?.level : null} analysis={displayFeed.analysis} bars={displayFeed.bars}
        price={chartPrice ?? displayFeed.price} live={!generated && storyFeed === "current"} selected={displayedPlan && referenceLevels && !displayedPlan.reference
          ? { ...displayedPlan, reference: true } : displayedPlan} snapshot={!!generated} simple={isSimple} />
        : <div className="strata-loading-chart">{busy?"Loading actual gold candles…":"Verified candles unavailable."}</div>}
      {isSimple ? displayedPlan && <details className="om-simple-fold"><summary>Plan prices and rules</summary><PlanLevels plan={displayedPlan}/>
        <div className="strata-simple-next om-simple-next"><p><strong>Wait for </strong>{displayedPlan.trigger}</p>
          <p><strong>Cancel if </strong>{displayedPlan.invalidation}</p></div>
        {!!displayAnalysis?.warnings.length && displayAnalysis.warnings.map(w => <p key={w}>{w}</p>)}</details>
        : <VisionLevels symbol="XAUUSD" entry={displayedPlan?.entry} stop={displayedPlan?.stop}
          targets={displayedPlan?.targets ?? []} rr={displayedPlan?.riskReward} reference={referenceLevels} />}
      {!isSimple && <p className="strata-vision-setup-caption">{displayedPlan
        ? referenceLevels?"WATCH ONLY · "+displayedPlan.trigger:"Engine-confirmed setup · review risk before acting"
        : "No executable price-action setup is confirmed. This chart shows recorded structure."}</p>}
      {generated && !isSimple && <div className="strata-generation-summary">
        <p>{generated.reasons[0] ?? "The current market read is complete."}</p>
        {!!generated.confirmationNeeded.length && <p><strong>Next:</strong> {generated.confirmationNeeded[0]}</p>}
      </div>}
      <button className="strata-generate-button strata-vision-generate" type="button"
        disabled={generating} onClick={()=>void generateEntry()} aria-busy={generating}
        aria-controls="strata-opportunity" aria-describedby="strata-generation-feedback">
        <Sparkles size={18} aria-hidden="true" />
        {isSimple ? generating ? "Checking gold…" : generateError ? "Try again" : generated ? "Refresh my plan" : "Generate a gold plan"
          : generating?"SCANNING GOLD…":generateError?"RETRY GENERATION":generated?"REGENERATE BEST OPPORTUNITY":"GENERATE BEST OPPORTUNITY"}
        <ArrowRight size={17} aria-hidden="true"/>
      </button>
      <div id="strata-generation-feedback" className="strata-generation-feedback">
        {generating && <p role="status">Checking current gold price action and completed candles…</p>}
        {generateError && <p className="strata-warning" role="alert"><CircleAlert size={15} aria-hidden="true" />
          <span>{generateError}{generated && " The previous generated snapshot is still shown above."}</span></p>}
      </div>
      {generated && !isSimple && <p className="strata-vision-result-note">Generated scenarios cannot submit a trade or enable FLOW. The chart uses the same recorded candles as the analysis.</p>}
    </section>

    <details className="strata-vision-deep">
      <summary>{isSimple ? "Why this setup?" : "Why this setup? · Price action evidence and confirmations"} <ChevronDown size={17} /></summary>
    <div className="strata-detail-grid">
      <section className="strata-card strata-reasoning" aria-label="Price-action reasoning">
        <header><span className="strata-kicker">{generated ? "GENERATED REASONING" : "THE READ"}</span>
          <h2>{generated ? "Why this idea was selected" : "Why this structure matters"}</h2></header>
        {isSimple && !displayedPlan && displayAnalysis?.warnings.map(w => <p key={w}>{w}</p>)}
        {isSimple && generated && <p>Captured {new Date(generated.generatedAt).toLocaleString()} · Gold {fixed(generated.quoteAtGeneration)}</p>}
        {displayedReasons.map((line, i) =>
          <div className="strata-reason-line" key={i}><span>0{i+1}</span><p>{line}</p></div>)}
        {generated && <p className="strata-generated-conditions"><strong>Still required:</strong>
          {generated.confirmationNeeded.slice(0, 3).map((item, i) => <span key={i}>{item}</span>)}</p>}
        {displayAnalysis && <div className="strata-higher-context">
          <span>1H STRUCTURE <b>{displayAnalysis.structure}</b></span>
          <span>15M MOMENTUM <b>{displayAnalysis.momentum}</b></span>
          <span>15M ATR <b>{fixed(displayAnalysis.atr)}</b></span>
          <span>REGIME EFFICIENCY <b>{Math.round(displayAnalysis.efficiency*100)}%</b></span>
        </div>}
      </section>
      <section className="strata-card strata-checks" aria-label="Trade trigger checklist">
        <header><span className="strata-kicker">TRADE PLAYBOOK</span><h2>What needs to happen</h2></header>
        {displayedPlan?.checks.map((step, i) => <div key={i} className="strata-step" data-complete={step.done}>
          <span className="strata-step-icon">{step.done ? <Check size={15} /> : String(i+1).padStart(2,"0")}</span>
          <div><strong>{step.label}</strong><p>{step.detail}</p></div></div>)
          ?? <p className="strata-plain">Wait for structure confirmation. No setup is being forced.</p>}
        <div className="strata-invalidation"><CircleAlert size={16} aria-hidden="true" />
          <span><b>Invalidation</b>{displayedPlan?.invalidation ?? "A directional trade is not qualified."}</span></div>
      </section>
    </div>

    </details>
    {isSimple && (currentMode === "paper" || activePaper) && <section className="strata-simple-paper" aria-label="Active paper trading">
      <div><strong>{currentMode === "paper" ? "Paper automation is on" : "A simulated trade is open"}</strong>
        <p>{selectedAccount?.name} {selectedAccount?.masked} · Simulation only; no broker orders.</p>
        {activePaper && <p>{activePaper.side === "buy" ? "Buy" : "Sell"} · Entry {fixed(Number(activePaper.entry))} · Stop {fixed(Number(activePaper.stop))} · Target {fixed(Number(activePaper.target))}</p>}</div>
      {currentMode === "paper" && <button type="button" className="strata-paper-action" disabled={settingBusy}
        onClick={() => void togglePaper("off")}><Square size={15} />{settingBusy ? "Stopping…" : "Stop paper automation"}</button>}
      <Link className="strata-text-link" href="/portal/trading?view=flow">Manage accounts in FLOW <ArrowRight size={14} /></Link>
      {accountError && <p role="alert" className="strata-error">{accountError}</p>}
    </section>}
    <details className="strata-vision-deep strata-vision-automation">
      <summary>Connected accounts · Paper automation and trade journal <ChevronDown size={17}/></summary>
    <section className="strata-card strata-automation" aria-label="Account and paper automation">
      <div className="strata-automation-header"><div><span className="strata-kicker">STRATA / EXECUTION BRIDGE</span>
        <h2>Connect. Observe. Validate.</h2>
        <p>Your existing TradeLocker connection is shared through FLOW. STRATA has its own independent paper-automation settings.</p></div>
        <span className="strata-automation-label"><LockKeyhole size={14} /> LIVE ORDERS OFF</span></div>
      <div className="strata-automation-columns">
        <div className="strata-automation-connection">
          <span className="strata-kicker">SELECT CONNECTED ACCOUNT</span>
          {accounts.length ? <select aria-label="STRATA account for paper automation"
            value={selectedAccount?.connectionId + ":" + selectedAccount?.accountId}
            onChange={(e) => { setAccountKey(e.target.value); setConfirmPaper(false); const found=accountData?.settings?.find((s)=>
              e.target.value===s.connection_id+":"+s.account_id);setRisk(Number(found?.risk_pct??.25));setMaxDaily(Number(found?.max_entries_per_day??2)); }}>
            {accounts.map((a) => <option key={a.connectionId+":"+a.accountId}
              value={a.connectionId+":"+a.accountId}>{a.name} {a.masked} · {a.environment === "live" ? "Live" : "Demo"}{a.connected ? "" : " · Offline"}</option>)}
          </select> : <p className="strata-plain">No TradeLocker accounts connected yet.</p>}
          {selectedAccount && <p className="strata-connection-state">
            <span className={selectedAccount.connected ? "strata-connected" : "strata-offline"} />
            {selectedAccount.connected ? "Broker connected" : "Reconnect required"} · {selectedAccount.environment === "live" ? "LIVE" : "DEMO"} account · Paper simulation only
          </p>}
          <Link className="strata-text-link" href="/portal/trading?view=flow"><Link2 size={15} aria-hidden="true"/> Connect or manage in FLOW <ArrowRight size={14} /></Link>
        </div>
        <div className="strata-automation-settings">
          <div className="strata-paper-heading"><span className="strata-kicker">PAPER AUTOPILOT</span>
            <span className="strata-paper-chip" data-on={currentMode === "paper"}>{currentMode === "paper" ? "ON" : "OFF"}</span></div>
          <div className="strata-risk-controls">
            <label>Illustrative risk
              <select value={risk}
                disabled={currentMode === "paper"} onChange={(e) => setRisk(Number(e.target.value))}>
                {[0.1,0.25,0.5].map((v) => <option key={v} value={v}>{v.toFixed(2)}%</option>)}</select></label>
            <label>Maximum paper entries / day
              <select value={maxDaily}
                disabled={currentMode === "paper"} onChange={(e) => setMaxDaily(Number(e.target.value))}>
                {[1,2,3,4].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
          </div>
          {confirmPaper && <div className="strata-confirm">
            <strong>Start simulated automated entries?</strong>
            <p>No actual TradeLocker order will be placed, even if the selected account is Live. The paper log excludes spread, slippage and commission.</p>
            <button type="button" onClick={() => void togglePaper("paper")} disabled={settingBusy}>Confirm paper mode</button>
            <button type="button" onClick={() => setConfirmPaper(false)}>Cancel</button></div>}
          {!confirmPaper && <button type="button" className="strata-paper-action" disabled={!selectedAccount || !selectedAccount.connected || settingBusy}
            onClick={() => currentMode === "paper" ? void togglePaper("off") : setConfirmPaper(true)}>
            {currentMode === "paper" ? <Square size={15} /> : <Play size={15} />}
            {settingBusy ? "Saving…" : currentMode === "paper" ? "Stop paper automation" : "Start paper automation"}</button>}
          {accountError && <p role="alert" className="strata-error">{accountError}</p>}
          <small className="strata-auto-foot">Paper mode monitors completed 15-minute setups and records simulated fills only. Live and demo broker orders remain disabled pending separate validation and activation.</small>
        </div>
      </div>
      <div className="strata-paper-log"><div><span className="strata-kicker">PAPER JOURNAL</span>
        <strong>{paper.length ? paper.length + " recent simulation" + (paper.length === 1 ? "" : "s") : "No simulated trades yet"}</strong></div>
        {paper.slice(0,4).map((t) => <div className="strata-paper-row" key={t.id}>
          <span data-side={t.side}>{t.side.toUpperCase()} GOLD</span><b>{fixed(Number(t.entry))} → {t.status === "open" ? "OPEN" : fixed(Number(t.exit_price))}</b>
          <em data-status={t.status}>{t.status}</em></div>)}
      </div>
    </section>

    </details>
    <footer className="strata-footer">
      <span><ShieldCheck size={16} aria-hidden="true"/> Deterministic analysis from completed candles. No predicted result is guaranteed.</span>
      <button type="button" onClick={askAtlas}><Mic size={16} aria-hidden="true"/> Ask Atlas to explain this setup <ArrowRight size={14}/></button>
    </footer>
  </div>;
}
