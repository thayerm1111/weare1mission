"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Activity, ArrowRight, Check, ChevronDown, CircleAlert, Fingerprint, Link2, LockKeyhole,
  Mic, Play, Radio, RotateCw, ShieldCheck, SlidersHorizontal, Sparkles, Square, TrendingDown, TrendingUp, Waves } from "lucide-react";
import { openAtlas } from "@/lib/atlas/open";
import { StrataChart } from "./StrataChart";
import type { Analysis, Bar, Regime, Scenario } from "@/lib/strata/engine";
import type { GeneratedOpportunity } from "@/lib/strata/generate";
import "./strata.css";

type Feed = {
  ok: boolean; analysis: Analysis; asOf: string; lastCandleAt: string; price: number;
  quoteSource: "stream" | "candle"; quoteReceivedAt: string | null; marketClosed: boolean;
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
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [now, setNow] = useState(0);
  const [tick, setTick] = useState<{ price: number; receivedAt: string } | null>(null);
  const [modeGuide, setModeGuide] = useState<Regime | null>(null);
  const [generated, setGenerated] = useState<GeneratedOpportunity | null>(null);
  const [generatedSnapshot, setGeneratedSnapshot] = useState<Feed | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [alternative, setAlternative] = useState(false);
  const [accountData, setAccountData] = useState<Automation | null>(null);
  const [accountKey, setAccountKey] = useState("");
  const [risk, setRisk] = useState(0.25);
  const [maxDaily, setMaxDaily] = useState(2);
  const [settingBusy, setSettingBusy] = useState(false);
  const [confirmPaper, setConfirmPaper] = useState(false);
  const [accountError, setAccountError] = useState("");
  const current = useRef<Feed | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    if (document.visibilityState === "hidden") return;
    const id = ++request.current;
    try {
      const response = await fetch("/api/strata", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.detail ?? "Gold market feed unavailable");
      if (id === request.current) { current.current = body as Feed; setFeed(body as Feed); setError(""); }
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
    void refresh(); void refreshAccounts();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const scanner = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 25_000);
    const accounts = setInterval(() => { if (document.visibilityState === "visible") void refreshAccounts(); }, 45_000);
    const visible = () => { if (document.visibilityState === "visible") { void refresh(); void refreshAccounts(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { request.current++; clearInterval(clock); clearInterval(scanner); clearInterval(accounts);
      document.removeEventListener("visibilitychange", visible); };
  }, [refresh, refreshAccounts]);
  useEffect(() => {
    let active = true, running = false;
    const load = async () => {
      if (!active || running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const response = await fetch("/api/floor/atlas-ticks", { cache: "no-store" });
        const body = await response.json().catch(() => null);
        const found = body?.ticks?.find((r: { symbol?: string }) => r.symbol === "XAU/USD");
        if (active && response.ok && found && num(found.price) !== null &&
          typeof found.receivedAt === "string") {
          setTick((previous) => !previous || Date.parse(found.receivedAt) >= Date.parse(previous.receivedAt)
            ? { price: found.price, receivedAt: found.receivedAt } : previous);
        }
      } catch { /* Only real data changes the live display. */ }
      finally { running = false; }
    };
    void load();
    const id = setInterval(() => void load(), 1500);
    return () => { active = false; clearInterval(id); };
  }, []);

  const generateEntry = async () => {
    if (generating) return;
    setGenerating(true);
    setGenerateError("");
    try {
      const response = await fetch("/api/strata/generate", { method: "POST", cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !payload?.idea || !payload?.state)
        throw new Error(payload?.detail ?? "A verified entry scenario is not available right now.");
      // The scenario and the chart are a single immutable analysis snapshot.
      // A newer live quote can never silently rewrite an earlier generated plan.
      setGenerated(payload.idea as GeneratedOpportunity);
      setGeneratedSnapshot(payload.state as Feed);
      setFeed(payload.state as Feed);
      setAlternative(false);
      setError("");
      window.requestAnimationFrame(() => document.getElementById("strata-opportunity")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      }));
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Unable to generate a verified setup.");
    } finally { setGenerating(false); }
  };

  const analysis = feed?.analysis ?? null;
  const open = !feed?.marketClosed;
  const tickFresh = !!tick && open && now - Date.parse(tick.receivedAt) >= -3000 &&
    now - Date.parse(tick.receivedAt) <= 6000;
  const quote = tickFresh ? tick!.price : num(feed?.price);
  const chosen = alternative && analysis?.secondary ? analysis.secondary : analysis?.primary ?? null;
  const displayedPlan = generated ? generated.scenario : chosen;
  const displayFeed = generated && generatedSnapshot ? generatedSnapshot : feed;
  const displayAnalysis = displayFeed?.analysis ?? analysis;
  const displayedReasons = generated ? generated.reasons : analysis?.reasons ??
    ["Waiting for a confirmed market structure."];
  const stage = analysis?.status ?? "NO_SETUP";
  const planReady = !!analysis && !feed?.marketClosed && !feed?.dataStale &&
    chosen?.stage === "ready" && !generated;
  const reg = analysis?.regime ?? "transition";
  const detectedRegime = analysis && !feed?.dataStale && !error && reg !== "transition"
    ? reg : null;
  const generatedOutdated = !!generated && now > 0 &&
    (now - generated.generatedAt > 20 * 60_000 || (analysis?.asOf ?? 0) > generated.asOf);
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
  return <div className="strata-workstation" data-regime={reg}>
    <header className="strata-header">
      <div className="strata-ident"><span className="strata-emblem"><i /><i /><i /></span>
        <div><span className="strata-kicker">ONE MISSION / PRICE ACTION INTELLIGENCE</span>
          <h1>STRATA<span className="strata-version">01</span></h1>
          <p>See the structure. Read the setup. Trade the retest.</p></div></div>
      <div className="strata-header-side">
        <StatusDot fresh={tickFresh} closed={!!feed?.marketClosed} />
        <button type="button" className="strata-icon-button" onClick={() => { setBusy(true); void refresh(); }}
          aria-label="Refresh price-action analysis"><RotateCw size={17} /></button>
      </div>
    </header>

    <div className="strata-regime-heading">
      <span className="strata-kicker">LIVE MARKET REGIME · 1H + 4H STRUCTURE</span>
      <span className="strata-regime-read">{analysis
        ? feed?.dataStale ? "DATA STALE" : analysis.regimeLabel.toUpperCase()
        : "AWAITING ANALYSIS"}</span>
    </div>
    <section className="strata-regimes" aria-label="Three price-action regimes">
      {CASES.map((p) => <button type="button" className="strata-regime" key={p.key}
        aria-expanded={modeGuide === p.key}
        aria-current={detectedRegime === p.key ? "true" : undefined}
        data-actual={detectedRegime === p.key}
        data-guide={modeGuide === p.key}
        data-session={feed?.marketClosed ? "closed" : "open"}
        onClick={() => setModeGuide(modeGuide === p.key ? null : p.key)}>
        <p.icon size={20} aria-hidden="true" /><span><strong>{p.title}</strong><small>{p.subtitle}</small></span>
        {detectedRegime === p.key && <em><i />{feed?.marketClosed ? "LAST SESSION" :
          p.key === "range" ? "CURRENT RANGE" : "LIVE TREND"}</em>}</button>)}
    </section>
    {reg === "transition" && <p className="strata-transition"><CircleAlert size={15} aria-hidden="true" />
      Mixed structure · no confirmed trend. Generate can still map a speculative watchlist idea.</p>}
    {modeGuide && <div className="strata-playbook">
      <strong>{CASES.find((p) => p.key === modeGuide)?.title} playbook</strong>
      <p>{CASES.find((p) => p.key === modeGuide)?.detail}</p>
      {reg !== modeGuide && <small>Educational example · not the market's current classification.</small>}</div>}

    <section className="strata-generate" aria-label="Generate possible gold trade entry">
      <div className="strata-generate-copy">
        <span className="strata-kicker"><Sparkles size={14} aria-hidden="true" /> ON-DEMAND OPPORTUNITY SCAN</span>
        <h2>Find the best possible entry.</h2>
        <p>Search the current gold structure for a break-and-retest or range reversal.
          Even a mixed market can return a conditional plan—never an invented confirmed signal.</p>
      </div>
      <button className="strata-generate-button" type="button" disabled={generating || !feed}
        onClick={() => void generateEntry()} aria-busy={generating}>
        <Sparkles size={18} aria-hidden="true" />
        {generating ? "Analyzing price action…" : generated ? "Regenerate Entry" : "Generate Possible Entry"}
        <ArrowRight size={17} aria-hidden="true" />
      </button>
    </section>
    <section className="strata-session">
      <div className="strata-session-quote">
        <span className="strata-kicker">XAU/USD · GOLD SPOT</span>
        <strong className="strata-price" data-no-i18n translate="no" data-fresh={tickFresh}>{fixed(quote)}</strong>
        <small>{tickFresh ? "Streaming quote · " + age(tick!.receivedAt, now)
          : feed ? "Last recorded price · " + age(feed.lastCandleAt, now) : "Waiting for verified price data"}</small>
      </div>
      <div className="strata-session-call">
        <span className="strata-kicker">CURRENT PRICE ACTION</span>
        <strong>{analysis ? analysis.regimeLabel : "Reading structure…"}
          <span className="strata-status" data-ready={planReady}>{feed?.dataStale ? "DATA STALE" : stage.replaceAll("_", " ")}</span></strong>
        <p>{analysis ? analysis.reasons[0] : busy ? "Checking the last completed candles on four timeframes."
          : "A confirmed market read is not available."}</p>
      </div>
      <div className="strata-session-count">
        <span className="strata-kicker">SETUP COMPLETION</span>
        <strong>{chosen ? completed + " / " + chosen.checks.length : "—"}</strong>
        <small>{chosen ? "Closed-candle conditions met" : "Awaiting an orderly regime"}</small>
      </div>
    </section>

    {error && <p className="strata-warning" role="alert"><CircleAlert size={15} aria-hidden="true" />
      {error} {feed ? "Showing the last available analysis." : "No trade levels will be shown."}</p>}
    {!!feed?.dataStale && <p className="strata-warning">Confirmed candles are stale. Entries are disabled until they refresh.</p>}
    {!!analysis?.warnings.length && <div className="strata-warnings">
      {analysis.warnings.map((w) => <p key={w}><CircleAlert size={14} aria-hidden="true"/>{w}</p>)}</div>}

    {generateError && <p className="strata-warning" role="alert"><CircleAlert size={15} aria-hidden="true" />
      {generateError}</p>}
    <section id="strata-opportunity" className="strata-setup" data-generated={!!generated}
      data-idea-tier={generated?.tier ?? "default"}>
      {generated && <div className="strata-generated-result" data-tier={generated.tier} role="status">
        <div><span className="strata-kicker">ON-DEMAND RESULT · {age(generated.generatedAt, now)}</span>
          <strong>{generated.label}</strong>
          <small>{generated.tier === "ready" ? "Confirmed standard STRATA setup at generation time." :
            "Reference scenario only · confirmation required · not sent to FLOW"}</small>
          {generatedOutdated && <small className="strata-generated-old">Earlier snapshot. Market conditions have changed—regenerate for a current plan.</small>}
        </div>
        <button type="button" onClick={() => { setGenerated(null); setGeneratedSnapshot(null); setGenerateError(""); }}>
          Back to live read</button>
      </div>}
      <div className="strata-setup-head">
        <div><span className="strata-kicker">{generated ? "GENERATED PRICE-ACTION PLAN" : "OPPORTUNITY RADAR"}</span>
          <h2>{displayedPlan ? displayedPlan.title : generated ? generated.label : "No qualified trade structure"}</h2>
          <p>{displayedPlan ? displayedPlan.trigger :
            generated ? generated.reasons[0] : "STRATA is waiting for a confirmed trend or repeatable range."}</p></div>
        {displayedPlan && <span className="strata-setup-side" data-side={displayedPlan.side}>
          {displayedPlan.side.toUpperCase()} · {generated ? generated.tier.toUpperCase() : displayedPlan.stage.toUpperCase()}</span>}
      </div>
      {!generated && !!analysis?.secondary && <div className="strata-scenario-switch" role="group" aria-label="Range scenarios">
        <button type="button" aria-pressed={!alternative} onClick={() => setAlternative(false)}>Nearest range edge</button>
        <button type="button" aria-pressed={alternative} onClick={() => setAlternative(true)}>Opposite range edge</button>
      </div>}
      {displayedPlan && <p className="strata-score">Structure score
        <strong>{displayedPlan.score}/100</strong>
        <span>Heuristic structure score, never a probability of winning.</span></p>}
      <PlanLevels plan={displayedPlan} />
      <p className="strata-levels-note">{generated
        ? "Generated price levels are a conditional research snapshot. No automatic entry or broker order is authorized."
        : displayedPlan?.stage === "ready" && !feed?.dataStale && !feed?.marketClosed
          ? "Completed trigger detected · execution still requires risk review."
          : "Reference / watch levels only. No automatic entry is authorized."}</p>
      {displayFeed && <StrataChart analysis={displayFeed.analysis} bars={displayFeed.bars}
        price={generated ? generated.quoteAtGeneration ?? displayFeed.price : quote ?? displayFeed.price}
        live={!generated && tickFresh} selected={displayedPlan} snapshot={!!generated} />}
      {!feed && <div className="strata-loading-chart">{busy ? "Loading verified gold candles…" : "Chart unavailable · market feed did not respond."}</div>}
    </section>

    <div className="strata-detail-grid">
      <section className="strata-card strata-reasoning" aria-label="Price-action reasoning">
        <header><span className="strata-kicker">{generated ? "GENERATED REASONING" : "THE READ"}</span>
          <h2>{generated ? "Why this idea was selected" : "Why this structure matters"}</h2></header>
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

    <footer className="strata-footer">
      <span><ShieldCheck size={16} aria-hidden="true"/> Deterministic analysis from completed candles. No predicted result is guaranteed.</span>
      <button type="button" onClick={askAtlas}><Mic size={16} aria-hidden="true"/> Ask Atlas to explain this setup <ArrowRight size={14}/></button>
    </footer>
  </div>;
}
