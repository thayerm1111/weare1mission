"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDown, ArrowRight, ArrowUp, CheckCircle2, ChevronDown, Crosshair, Minus, Radio, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { OmChart } from "../chart/OmChart";
import type { ChartLevel } from "@/lib/floor/chart";
import type { NitrousAccount, NitrousAnalyze, NitrousMode, NitrousPosition, NitrousWatchLevel } from "@/lib/nitrous/types";
import { isObservedTrade, tradeProgress } from "@/lib/nitrous/dashboard";
import { buildMarketStory, marketUpdate, rankedSetups } from "@/lib/nitrous/market-story";
import { elapsed, money, price, scenarioState } from "./presentation";
import { sweepAccountMessage } from "./NitrousStrategyOptions";
import "./nitrous-desk.css";

const familyName = (value: string) => ({ trend_pullback: "Pullback", break_retest: "Break & retest", range_reaction: "Range reaction", sweep_reclaim: "Sweep & reclaim", momentum: "Momentum" } as Record<string, string>)[value] ?? "Price action";
const checkName = (value: string) => ({ no_zone: "No validated zone", stop_too_wide: "Stops exceeded the strategy limit", target_room_short: "Not enough room to target", regime_conflict: "Timeframes did not align", reward_risk_short: "Reward/risk below the requirement", arbitration_lost: "Another plan took priority", no_anchor: "No confirmed structural anchor", opposite_break: "An opposing break was recorded", outside_band: "Price outside the entry zone", expired: "Setup expired", warmup: "More candle history needed", cost_too_high: "Trading costs too high", spread_too_wide: "Spread too wide", no_opposing_room: "Not enough room ahead", no_sweep: "No confirmed swing sweep", no_reclaim: "Sweep did not close back through the level", forming_candle: "Reclaim candle must close", stale_quote: "Waiting for a fresh reference close", zone_expired: "Structure has expired", zone_suspended: "Structure is suspended" } as Record<string, string>)[value] ?? value.replaceAll("_", " ");
const tone = (value: unknown) => value === "up" ? "positive" : value === "down" ? "negative" : "neutral";
const directionWord = (value: unknown) => value === "up" ? "Up" : value === "down" ? "Down" : value === "range" ? "Range" : "—";
const tfName = (value: string) => ({ M5: "5m", M15: "15m", M30: "30m", H1: "1h", H4: "4h", D1: "Daily" } as Record<string, string>)[value.toUpperCase()] ?? value;
const age = (ms: number | null) => ms === null || !Number.isFinite(ms) ? "Unavailable" : ms < 5_000 ? "Just updated" : ms < 60_000 ? `${Math.floor(ms / 1000)}s ago` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m ${Math.floor(ms / 1000) % 60}s ago` : `${Math.floor(ms / 3_600_000)}h ago`;
function Pulse({ fresh, caption }: { fresh: boolean; caption: string }) {
  return <span className="nt-live" data-fresh={fresh}><i aria-hidden="true"/><span>{caption}</span></span>;
}
function zoneLabel(zone: NitrousWatchLevel, reference: number | null) {
  const inside = reference !== null && reference >= zone.low && reference <= zone.high;
  return inside ? `Inside ${zone.role === "support" ? "demand" : "supply"}` : zone.role === "support" ? "Support below" : "Resistance above";
}

/** Events reflect changes between successful source reads, never the passage of a polling timer. */
function useMarketActivity(data: NitrousAnalyze | null, fresh: boolean, now: number, mode: NitrousMode) {
  const previous = useRef<NitrousAnalyze | null>(null);
  const previousMode = useRef(mode);
  const [events, setEvents] = useState<Array<{ text: string; at: string }>>([]);
  const [movement, setMovement] = useState<{ key: string; direction: "up" | "down" } | null>(null);
  useEffect(() => {
    if (previousMode.current !== mode || !data?.generatedAt || !fresh) {
      previousMode.current = mode; previous.current = null; setEvents(items => items.length ? [] : items); setMovement(null);
      return;
    }
    const prior = previous.current;
    if (prior?.generatedAt === data.generatedAt) return;
    previous.current = data;
    if (!prior) return;
    const message = marketUpdate(prior, data, now, mode);
    if (message) setEvents(items => items[0]?.text === message ? items : [{ text: message, at: data.generatedAt! }, ...items].slice(0, 3));
    if (data.asOf !== prior.asOf && typeof data.price === "number" && typeof prior.price === "number" && data.price !== prior.price) {
      setMovement({ key: `${data.asOf}:${data.price}`, direction: data.price > prior.price ? "up" : "down" });
    }
  }, [data, fresh, now, mode]);
  return { events, movement };
}

export function NitrousMarketDesk({ data, loading, error, fresh, now, accountNow, account, onRefresh, simple, mode, busy, onClose }: {
  data: NitrousAnalyze | null; loading: boolean; error: string; fresh: boolean; now: number; accountNow: number;
  account: NitrousAccount | null; onRefresh: () => void; simple: boolean; mode: NitrousMode; busy: boolean; onClose: (p: NitrousPosition) => void;
}) {
  const [chosenId, setChosenId] = useState("");
  const [chartView, setChartView] = useState<"trade" | "setup">("trade");
  const reference = typeof data?.price === "number" && Number.isFinite(data.price) && data.price > 0 ? data.price : null;
  const scenarios = useMemo(() => rankedSetups(data?.scenarios ?? [], reference, now, fresh, mode), [data?.scenarios, reference, now, fresh, mode]);
  const selectedPlan = scenarios.find(item => item.setupId === chosenId) ?? scenarios[0] ?? null;
  const story = useMemo(() => buildMarketStory(data, { fresh, now, plan: selectedPlan }), [data, fresh, now, selectedPlan]);
  const opportunity = story.opportunity;
  const marketFresh = opportunity.kind !== "stale";
  const plan = opportunity.plan;
  const availableScenarios = marketFresh ? scenarios : [];
  const open = account?.positions.find(item => item.status === "open" || item.status === "closing") ?? null;
  const tradeLive = !!open && isObservedTrade(open, accountNow);
  const chartPosition = chartView === "trade" ? open : null;
  useEffect(() => { setChartView("trade"); }, [open?.id]);
  const fastScan = mode === "nitrous" && !!data?.diagnostics && data.diagnostics.fastCandidates !== null;
  const checks = (fastScan ? data?.diagnostics?.fastChecks : data?.diagnostics?.baselineChecks) ?? [];
  const sweepChecks = mode === "nitrous" ? data?.diagnostics?.sweepChecks ?? [] : [];
  const sweepCandidates = mode === "nitrous" ? data?.diagnostics?.sweepCandidates : null;
  const activity = useMarketActivity(data, marketFresh, now, mode);
  const flow = data?.flow ?? [];
  const chart = useMemo(() => {
    const levels: ChartLevel[] = [];
    const add = (kind: ChartLevel["kind"], value: number | null | undefined, label: string) => {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) levels.push({ kind, price: value, label });
    };
    if (chartPosition) {
      add("entry", chartPosition.entry, "Trade entry"); add("stop", chartPosition.stop, "Trade stop"); add("target", chartPosition.target, "Trade target");
    } else if (plan) {
      add("entry", plan.refEntry, plan.family === "sweep_reclaim" ? "Reclaim entry" : "Planned entry"); add("stop", plan.stop, "Plan stop"); add("target", plan.target, "Plan target");
      if (plan.family === "sweep_reclaim" && plan.sweepEvidence) add(plan.side === "buy" ? "support" : "resistance", plan.sweepEvidence.pivotPrice,
        `Swept swing ${plan.sweepEvidence.pivotKind}`);
    } else for (const zone of story.zones) {
      const inside = reference !== null && reference >= zone.low && reference <= zone.high;
      add(zone.role, zone.role === "support" ? inside ? zone.low : zone.high : inside ? zone.high : zone.low,
        inside ? zone.role === "support" ? "Demand floor" : "Supply ceiling" : zone.role === "support" ? "Support" : "Resistance");
    }
    return {
      bars: data?.bars ?? [], timeKnown: true, tfMs: 300_000, tfLabel: "5m", price: reference, priceLive: false,
      dec: 2, levels, snapshot: true, appearance: "nitrous" as const,
      levelColors: { support: "#82c8f6", resistance: "#e8bc7a" },
      zone: !chartPosition && plan ? { low: plan.entryBandLow, high: plan.entryBandHigh } : null,
      structureZones: chartPosition || plan ? [] : story.zones.map(zone => ({ low: zone.low, high: zone.high, kind: zone.role,
        label: `${tfName(zone.origin)} ${zone.role === "support" ? "demand" : "supply"} zone` })),
      viewKey: `nitrous:market-story:${chartPosition?.id ?? plan?.setupId ?? "watch"}`,
      label: chartPosition ? "Gold chart with recorded trade levels" : plan ? "Gold chart with conditional setup entry, stop and target" : "Gold chart with actual nearby demand and supply zones",
      fitLevels: !!chartPosition || !!plan, labelStyle: "backed" as const,
    };
  }, [data?.bars, reference, chartPosition, plan, story.zones]);
  const mainRange = opportunity.range;
  const hasBoundary = opportunity.kind === "watch" && opportunity.boundary !== null;
  return <section className="nitrous-market nitrous-panel nt-desk nt-story-desk" aria-labelledby="nitrous-market-title" data-fresh={marketFresh}>
    <header className="nt-market-header">
      <div className="nt-market-price"><span className="nt-eyebrow">GOLD <span>/ XAUUSD</span></span>
        <div><strong key={activity.movement?.key ?? "initial"} className="nt-reference-price" data-movement={marketFresh ? activity.movement?.direction : undefined}>{price(reference)}</strong><span className="nt-price-unit">USD</span></div>
        <small>{marketFresh ? "1m reference close" : "Last reference close"} · {age(story.quoteAgeMs)}</small>
      </div>
      <div className="nt-refresh-state"><div><Pulse fresh={marketFresh} caption={marketFresh ? "AUTO-UPDATING" : loading && !data ? "CONNECTING" : "DATA DELAYED"}/><button type="button" className="nitrous-icon-button" onClick={onRefresh} disabled={loading} aria-label="Refresh market analysis"><RefreshCw size={17} className={loading ? "nitrous-spin" : ""}/></button></div><span>Analysis {age(story.analysisAgeMs).toLowerCase()}</span><small>Checks every 15 seconds</small></div>
    </header>
    {error && <p className="nt-feed-alert" role="alert">{error}</p>}
    <section className="nt-market-brief" aria-label="Current market explanation">
      <span className="nt-eyebrow"><Activity size={14}/>{marketFresh ? "THE MARKET NOW" : "MARKET READ"}</span>
      <h2 id="nitrous-market-title">{story.headline}</h2><p>{story.summary}</p>
      <div className="nt-tf-strip" aria-label="Timeframe context">{["D", "4H", "1H", "15M", "5M"].map(label => {
        const value = flow.find(item => item.timeframe.toUpperCase() === label);
        const Icon = !marketFresh ? Minus : value?.direction === "up" ? ArrowUp : value?.direction === "down" ? ArrowDown : ArrowRight;
        return <div key={label}><small>{label === "D" ? "Daily" : label}</small><b data-tone={marketFresh ? tone(value?.direction) : "neutral"}><Icon size={12}/>{marketFresh ? directionWord(value?.direction) : "—"}</b></div>;
      })}</div>
    </section>
    {open && <div className="nt-position-banner"><Zap size={17}/><span>{tradeLive ? "Open trade" : "Recorded position"}: <b>{open.side.toUpperCase()} XAUUSD</b> · {tradeLive ? "broker observed" : "awaiting broker refresh"}</span><a href="#nitrous-positions-title">View trade <ArrowRight size={14}/></a></div>}
    <section className="nt-next" aria-labelledby="nitrous-next-title" data-kind={opportunity.kind}>
      <div className="nt-next-heading"><span className="nt-eyebrow"><Crosshair size={15}/>{opportunity.kind === "setup" ? "NEXT SETUP" : opportunity.kind === "watch" ? "NEXT AREA TO WATCH" : "NEXT SETUP"}</span><span className="nt-condition-badge">{opportunity.status}</span></div>
      <h3 id="nitrous-next-title">{opportunity.title}</h3>
      {mainRange && <div className="nt-watch-price"><strong>{hasBoundary ? price(opportunity.boundary) : `${price(mainRange.low)} – ${price(mainRange.high)}`}</strong><span>{hasBoundary ? opportunity.boundaryText : opportunity.distanceText}</span>{hasBoundary && <small>Full {opportunity.zone?.role === "support" ? "demand" : "supply"} zone {price(mainRange.low)} – {price(mainRange.high)}</small>}</div>}
      <p className="nt-next-detail">{opportunity.detail}</p>
      {plan?.family === "sweep_reclaim" && <p className="nt-detail-note" style={{fontSize:13,lineHeight:1.6,margin:"10px 0 14px"}} role="status">{sweepAccountMessage(account, accountNow > 0)}</p>}
      <div className="nt-confirmation"><span className="nt-step-icon"><Activity size={17}/></span><div><strong>{plan?.state === "triggered" ? "Execution status" : plan?.state === "armed" ? "What happens next" : opportunity.kind === "setup" ? "What confirms the entry" : opportunity.kind === "watch" ? "What Nitrous needs next" : "What happens next"}</strong><p>{opportunity.trigger}</p></div></div>
      {plan && <div className="nt-plan-facts"><div><small>Planned stop</small><b>{price(opportunity.stop)}</b></div><div><small>Planned target</small><b>{price(opportunity.target)}</b></div><div><small>Valid until</small><b>{new Date(plan.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</b></div>{opportunity.invalidationText && <p>{opportunity.invalidationText}</p>}</div>}
      {availableScenarios.length > 1 && <div className="nitrous-setup-picker" role="group" aria-label="Current engine setups">{availableScenarios.map(item => <button key={item.setupId} type="button" aria-pressed={item.setupId === plan?.setupId} onClick={() => { setChosenId(item.setupId); setChartView("setup"); }}>{item.side.toUpperCase()} · {familyName(item.family)}</button>)}</div>}
    </section>
    {story.zones.length > 0 && !plan && <div className="nt-location-map" aria-label="Nearby market levels">{story.zones.map(zone => <div key={`${zone.role}:${zone.low}:${zone.high}`}><span><i data-role={zone.role}/>{zoneLabel(zone, reference)} <small>{tfName(zone.origin)}</small></span><strong>{price(zone.low)} – {price(zone.high)}</strong></div>)}</div>}
    <section className="nt-chart-card" aria-label="Gold market chart">
      <div className="nt-chart-toolbar"><h3><Activity size={17}/>{chartPosition ? "Your trade on the chart" : "The market map"}</h3><span>5 minute candles</span></div>
      {open && <div className="nt-chart-views" role="group" aria-label="Chart levels"><button type="button" aria-pressed={!!chartPosition} onClick={() => setChartView("trade")}>Open trade</button><button type="button" aria-pressed={!chartPosition} disabled={!marketFresh || (!plan && !story.zones.length)} onClick={() => setChartView("setup")}>{plan ? "Next setup" : "Watch areas"}</button></div>}
      {data?.bars.length ? <div className="nitrous-chart nt-chart"><OmChart {...chart}/></div> : <div className="nitrous-chart-empty"><Activity size={28}/><strong>{loading ? "Loading gold candles…" : "Waiting for market data"}</strong><span>{data?.reason ?? "The chart appears with the next market read."}</span></div>}
      <div className="nt-chart-explainer"><span><i/>{chartPosition ? "Your recorded trade levels" : plan ? "Shaded band = planned entry area" : story.zones.length ? "Shaded bands = observed supply / demand" : "No nearby validated zone in this read"}</span><small>Completed candles · reference feed</small></div>
    </section>
    {marketFresh && activity.events.length > 0 && <section className="nt-market-activity" aria-label="Recent observed market change"><Radio size={16}/><div><small>LATEST CHANGE · {elapsed(activity.events[0].at, now)}</small><p role="status">{activity.events[0].text}</p></div></section>}
    <NitrousLiveTrades account={account} accountNow={accountNow} referencePrice={marketFresh ? reference : null} referenceAt={data?.asOf ?? null} now={now} simple={simple} busy={busy} onClose={onClose} embedded/>
    {!simple && <details className="nt-details"><summary>Why Nitrous is waiting <ChevronDown size={16}/></summary>
      {plan && <div className="nt-raw"><strong>{familyName(plan.family)} · {plan.family === "sweep_reclaim" && plan.state === "armed" ? "Waiting for broker entry checks" : scenarioState(plan.state)}</strong>{plan.conditionsMet.filter(condition => typeof condition === "string" && !/no extra rejection candle required/i.test(condition)).map((condition, index) => <p className="nt-met-condition" key={`met:${index}`}><CheckCircle2 size={14}/>{condition}</p>)}{plan.conditionsPending.map((condition, index) => <p key={`pending:${index}`}>{condition}</p>)}</div>}
      {checks.length > 0 && <div className="nt-funnel"><small>{fastScan ? "Fast scanner" : "Baseline scanner"} · reasons candidates were filtered in this read</small>{checks.map(check => <div key={check.code}><span>{checkName(check.code)}</span><b>{check.count}</b></div>)}<p className="nt-detail-note">These counts cover all candidates; they are not a checklist for the selected area.</p></div>}
      {typeof sweepCandidates === "number" && <div className="nt-funnel"><small>Sweep &amp; reclaim scanner · {sweepCandidates} qualifying {sweepCandidates === 1 ? "candidate" : "candidates"}</small>{sweepChecks.map(check => <div key={check.code}><span>{checkName(check.code)}</span><b>{check.count}</b></div>)}<p className="nt-detail-note">Confirmed swing sweeps need a completed reclaim candle and price near its close. Account authorization and broker checks apply separately.</p></div>}
      <p className="nt-detail-note">{data?.explanation || "Waiting for a market read."}</p>{data?.health.reasons.map((reason, index) => <p className="nt-detail-note" key={index}>{reason}</p>)}
      <p className="nt-detail-note">The reference price comes from completed one-minute candles. Analysis checks about every 15 seconds; broker quotes and fills can differ.</p>
    </details>}
  </section>;
}
export function NitrousLiveTrades({account,accountNow,referencePrice,referenceAt,now,simple,busy,onClose,embedded=false}:{
  account:NitrousAccount|null;embedded?:boolean;accountNow:number;referencePrice:number|null;referenceAt:string|null;now:number;simple:boolean;busy:boolean;onClose:(p:NitrousPosition)=>void;
}) {
  const emptyTitle=!account?"Connect an account":!accountNow?"Checking account":"No active trade";
  const entryCheck = accountNow && account?.automationEnabled && !account.blockers.length ? account.lastEntryCheck : null;
  const emptyText = !account ? "TradeLocker controls below." : !accountNow ? "Awaiting account refresh."
    : !account.automationEnabled ? "Auto trading is paused." : account.blockers[0] ?? entryCheck?.reason ?? "Watching for entry.";
  return <section className={`nt-trades ${embedded?"nt-tile nt-trade-embedded":"nitrous-positions nitrous-panel"}`} aria-labelledby="nitrous-positions-title">
    <div className="nt-trades-title"><h3 id="nitrous-positions-title"><Zap size={17}/>Live trade</h3><Pulse fresh={!!accountNow&&!!account?.positions.some(p=>isObservedTrade(p,accountNow))} caption={account?.masked??""}/></div>
    {!account||!account.positions.length?<div className="nt-empty-trade"><Crosshair size={28}/><strong>{emptyTitle}</strong><p>{entryCheck && <small className="nt-last-check">Last recorded entry check · <time dateTime={entryCheck.at}>{elapsed(entryCheck.at, accountNow)}</time></small>}{emptyText}</p><div className="nt-empty-metrics">{["Entry","SL","TP","P&L"].map(label=><div key={label}><small>{label}</small><b>—</b></div>)}</div></div>:<div className="nt-trade-list">{account.positions.map(p=>{
      const live=isObservedTrade(p,accountNow);
      const pnl=live&&typeof p.unrealizedPnl==="number"&&Number.isFinite(p.unrealizedPnl)?p.unrealizedPnl:null;
      const progress=live?tradeProgress(p,referencePrice):null;
      const rejected=p.closeRequestState==="rejected";
      const pending=!rejected&&(!!p.closeRequestState||p.status==="closing"||!!p.closeRequestedAt);
      const closeLabel=p.closeRequestState==="uncertain"?"Close pending · reconciling with broker":pending?"Close requested · awaiting confirmation":rejected?"Retry position close":"Close position";
      return <article key={p.id} className="nt-trade" data-side-trade={p.side} data-observed={live}>
        <header><div><Crosshair size={18}/><strong><span data-side={p.side}>{p.side.toUpperCase()}</span> XAUUSD</strong></div><Pulse fresh={live} caption={live?(p.status==="closing"?"CLOSING":"LIVE"):"CHECKING"}/></header>
        <div className="nt-trade-values"><div><small>Entry</small><b>{price(p.entry)}</b></div><div><small>SL</small><b data-tone="negative">{price(p.stop)}</b></div><div><small>TP</small><b data-tone="positive">{price(p.target)}</b></div><div><small>Size</small><b>{p.quantity} lot</b></div><div><small>Risk preset</small><b>{p.riskPct==null?"—":`${p.riskPct}%`}</b></div><div className="nt-floating"><small>Floating P&amp;L</small><b data-tone={pnl==null?"neutral":pnl>=0?"positive":"negative"}>{pnl==null?"—":`${pnl>0?"+":""}${account.currency?money(pnl,account.currency):price(pnl)}`}</b><span>{pnl===null?"Awaiting broker value":account.currency?"Broker reported":"Broker value · currency unknown"}</span></div></div>
        {progress&&<div className="nt-progress"><div className="nt-progress-label"><small>Price progress · reference</small><strong>{price(referencePrice)}</strong></div><div className="nt-progress-track" role="img" aria-label={`Reference price ${price(referencePrice)} between initial stop ${price(p.initialStop??p.stop)} and target ${price(p.target)}`}>
          <i className="nt-progress-fill" data-tone={progress.towardTarget?"positive":"negative"} style={{left:`${Math.min(progress.entry,progress.current)}%`,width:`${Math.abs(progress.current-progress.entry)}%`}}/><i className="nt-entry-mark" style={{left:`${progress.entry}%`}}/>{progress.stop!==null&&<i className="nt-stop-mark" style={{left:`${progress.stop}%`}}/>}<i className="nt-now-mark" style={{left:`${progress.current}%`}}/></div><div className="nt-progress-ends"><span>Initial stop {price(p.initialStop??p.stop)}</span><span>TP {price(p.target)}</span></div><small className="nt-detail-note">Reference · {elapsed(referenceAt,now)} · not an executable quote</small></div>}
        <div className="nt-trade-footer"><p><ShieldCheck size={14}/>{p.protectionState==="protected"||p.protectionState==="verified"?"Broker stop verified":"Protection check pending"}{!simple&&` · Management ${p.managementEnabled?"on":"off"}`}{live&&` · ${elapsed(p.liveObservedAt,accountNow)}`}</p><button type="button" className="nitrous-position-close" disabled={busy||pending} onClick={()=>onClose(p)}>{closeLabel}</button></div>
        {rejected&&<p className="nt-detail-note" role="status">{p.closeRequestError||"Broker rejected the close. Position remains open."}</p>}
      </article>;
    })}</div>}
  </section>;
}
