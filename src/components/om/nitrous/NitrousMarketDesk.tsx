"use client";

import { useMemo, useState } from "react";
import { Activity, CheckCircle2, ChevronDown, Circle, Crosshair, Layers3, RefreshCw, ShieldCheck, TrendingDown, TrendingUp, Waves, Zap } from "lucide-react";
import { OmChart } from "../chart/OmChart";
import type { ChartLevel } from "@/lib/floor/chart";
import type { NitrousAccount, NitrousAnalyze, NitrousMode, NitrousPosition } from "@/lib/nitrous/types";
import { displayableSetup, isObservedTrade, pricePulse, tradeProgress } from "@/lib/nitrous/dashboard";
import { elapsed, money, price, scenarioState } from "./presentation";
import "./nitrous-desk.css";

const familyName=(v:string)=>({trend_pullback:"Pullback",break_retest:"Break & retest",range_reaction:"Range reaction",momentum:"Momentum"} as Record<string,string>)[v]??"Price action";
const checkName=(v:string)=>({no_zone:"No validated zone",stop_too_wide:"Stop too wide",target_room_short:"Target room too small",regime_conflict:"Structure not aligned",reward_risk_short:"Reward/risk too low",arbitration_lost:"Competing setup",no_anchor:"No structural stop",opposite_break:"Opposing breakout",outside_band:"Outside entry zone",expired:"Setup expired",warmup:"Warming up",cost_too_high:"Cost too high",spread_too_wide:"Spread too wide",no_opposing_room:"Insufficient room"} as Record<string,string>)[v]??v.replaceAll("_"," ");
const tone=(v:unknown)=>v==="up"?"positive":v==="down"?"negative":"neutral";
const biasWord=(v:unknown)=>v==="up"?"Bullish":v==="down"?"Bearish":v==="range"?"Range":"Unknown";
const directionWord=(v:unknown)=>v==="up"?"Up":v==="down"?"Down":v==="range"?"Range":"—";
function Pulse({fresh,caption}: {fresh:boolean;caption:string}) {
  return <span className="nt-live" data-fresh={fresh}><i/><span>{caption}</span></span>;
}
export function NitrousMarketDesk({data,loading,error,fresh,now,accountNow,account,onRefresh,simple,mode,busy,onClose}:{
  data:NitrousAnalyze|null; loading:boolean;error:string;fresh:boolean;now:number;accountNow:number;account:NitrousAccount|null;onRefresh:()=>void;simple:boolean;mode:NitrousMode;busy:boolean;onClose:(p:NitrousPosition)=>void;
}) {
  const [chosenId,setChosenId]=useState("");
  const reference=typeof data?.price==="number"&&Number.isFinite(data.price)&&data.price>0?data.price:null;
  const allScenarios=(data?.scenarios??[]).filter(s=>mode==="nitrous"||s.profile!=="nitrous");
  const scenarios=allScenarios.filter(s=>displayableSetup(s,reference,now,fresh));
  const plan=scenarios.find(s=>s.setupId===chosenId)??scenarios[0]??null;
  const flow=data?.flow??[];
  const bias=flow.find(f=>f.timeframe.toUpperCase()==="1H");
  const open=account?.positions.find(p=>p.status==="open"||p.status==="closing")??null;
  const tradeLive=!!open&&isObservedTrade(open,accountNow);
  const zones=fresh?(data?.diagnostics?.watchLevels??[]):[];
  const fastScan=mode==="nitrous"&&!!data?.diagnostics&&data.diagnostics.fastCandidates!==null;
  const checks=(fastScan?data?.diagnostics?.fastChecks:data?.diagnostics?.baselineChecks)??[];
  const pulse=useMemo(()=>pricePulse(data?.bars??[]),[data?.bars]);
  const trigger=tradeLive?(open?.status==="closing"?"Closing":"Trade live"):open?"Trade check":!fresh?"Delayed":plan?.state==="triggered"?"Triggered":plan?.state==="armed"?"Armed":plan?.state==="approaching"?"Approaching":"Watching";
  const direction=plan?.side==="sell"?"down":plan?.side==="buy"?"up":null;
  const trendReady=fresh&&(bias?.direction==="up"||bias?.direction==="down")&&(!direction||direction===bias.direction);
  const entryInZone=!!plan&&reference!==null&&reference>=plan.entryBandLow&&reference<=plan.entryBandHigh;
  const entryDistance=plan&&reference!==null?Math.max(plan.entryBandLow-reference,reference-plan.entryBandHigh,0):null;
  const triggerObserved=!!plan&&(plan.state==="armed"||plan.state==="triggered");
  const checklist=[
    {label:trendReady?`1H trend ${bias?.direction==="up"?"up":"down"}`:"1H trend",done:trendReady,detail:""},
    {label:plan?.family==="break_retest"?"Price retest":"Entry zone",done:entryInZone,detail:entryDistance===null?"":entryInZone?"At zone":`$${entryDistance.toFixed(2)} away`},
    {label:plan?.family==="break_retest"?"Break confirmed":plan?.family==="trend_pullback"||plan?.family==="range_reaction"?`${plan.timeframe.toUpperCase()} rejection`:"Closed trigger",done:triggerObserved,detail:""},
    {label:tradeLive?"Position verified":"Broker risk checks",done:tradeLive,detail:""},
  ];
  const chart=useMemo(()=>{
    const levels:ChartLevel[]=[];
    const add=(kind:ChartLevel["kind"],value:number|null|undefined,label:string)=>{if(typeof value==="number"&&Number.isFinite(value)&&value>0)levels.push({kind,price:value,label});};
    if(open){add("entry",open.entry,"Entry");add("stop",open.stop,"SL");add("target",open.target,"TP");}
    else if(plan){add("entry",plan.refEntry,"Entry");add("stop",plan.stop,"SL");add("target",plan.target,"TP");}
    else for(const z of zones)add(z.role,z.role==="support"?z.high:z.low,z.role==="resistance"?"Supply":"Support");
    return {bars:data?.bars??[],timeKnown:true,tfMs:300000,tfLabel:"5m",price:reference,priceLive:false,dec:2,levels,
      zone:!open&&plan?{low:plan.entryBandLow,high:plan.entryBandHigh}:null,
      structureZones:open?[]:zones.map(z=>({low:z.low,high:z.high,kind:z.role,label:z.role==="resistance"?"Supply":"Support"})),
      viewKey:`nitrous:approved:${open?.id??plan?.setupId??"scan"}`,label:open?"Gold candles and recorded trade levels":"Gold candles and engine-confirmed setup or watch levels",fitLevels:!!open||!!plan,labelStyle:"backed" as const};
  },[data?.bars,reference,open,plan,zones]);
  const Direction=bias?.direction==="up"?TrendingUp:bias?.direction==="down"?TrendingDown:Waves;
  const chartState=open?(tradeLive?`${open.side.toUpperCase()} · Live trade`:"Recorded trade"):plan?`${trigger} ${plan.side} setup`:fresh?"Scanning for setup":"Reference delayed";
  const tfLabels=["D","4H","1H","15M","5M"];
  return <section className="nitrous-market nitrous-panel nt-desk nt-approved" aria-labelledby="nitrous-market-title">
    <div className="nt-approved-title"><div><span className="nitrous-eyebrow">XAUUSD · GOLD</span><h2 id="nitrous-market-title">Market &amp; setups <span className="nt-title-pulse" data-fresh={fresh} aria-label={fresh?"Scanner active":"Scanner delayed"}/></h2></div><Pulse fresh={fresh} caption={fresh?"SCANNING":data?.available?"DELAYED":"CONNECTING"}/></div>
    <div className="nt-approved-metrics" aria-label="Price, bias and status">
      <div className="nt-metric nt-metric-price"><span className="nt-metric-icon"><Layers3 size={21}/></span><div><small>PRICE</small><strong>{price(reference)}</strong><span>{fresh?elapsed(data?.asOf,now):"Last read"}</span></div>{pulse&&<svg className="nt-mini-pulse" viewBox="0 0 120 38" preserveAspectRatio="none" aria-label="Recent actual closing prices" role="img"><polyline points={pulse.points} fill="none" vectorEffect="non-scaling-stroke" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>}</div>
      <div className="nt-metric"><span className="nt-metric-icon" data-tone={fresh?tone(bias?.direction):"neutral"}><Direction size={23}/></span><div><small>BIAS</small><strong data-tone={fresh?tone(bias?.direction):"neutral"}>{fresh?biasWord(bias?.direction):"Delayed"}</strong><span>1H structure</span></div></div>
      <div className="nt-metric"><span className="nt-metric-icon"><Crosshair size={23}/></span><div><small>STATUS</small><strong>{trigger}</strong><span>{plan?familyName(plan.family):tradeLive?"Broker verified":fresh?"Setup scan":"Awaiting data"}</span></div></div>
    </div>
    {error&&<p className="nitrous-error" role="alert">{error}</p>}
    <section className="nt-chart-card" aria-label="Gold market chart">
      <div className="nt-chart-toolbar"><h3><Activity size={17}/>{fresh?"Live Gold":"Gold chart"}</h3><span className="nt-chart-pill"><i data-fresh={fresh}/>{chartState}</span><button type="button" className="nitrous-icon-button" onClick={onRefresh} disabled={loading} aria-label="Refresh gold setups"><RefreshCw size={17} className={loading?"nitrous-spin":""}/></button></div>
      {data?.bars.length?<div className="nitrous-chart nt-chart"><OmChart {...chart}/></div>:<div className="nitrous-chart-empty"><Activity size={28}/><strong>{loading?"Loading gold candles…":"Waiting for market data"}</strong><span>{data?.reason??"The chart appears with the next market read."}</span></div>}
      <div className="nitrous-chart-caption"><span>5m candles · reference feed</span><span>{elapsed(data?.asOf,now)}</span></div>
      {scenarios.length>1&&<div className="nitrous-setup-picker" role="group" aria-label="Available setups">{scenarios.map(p=><button key={p.setupId} type="button" aria-pressed={p.setupId===plan?.setupId} onClick={()=>setChosenId(p.setupId)}>{p.side.toUpperCase()} · {familyName(p.family)}{p.profile==="nitrous"?" · Fast":""}</button>)}</div>}
    </section>
    <div className="nt-tf-strip" aria-label="Market flow by timeframe">{tfLabels.map(label=>{
      const v=flow.find(f=>f.timeframe.toUpperCase()===label);
      return <div key={label} data-focus={label==="5M"}><small>{label}</small><b data-tone={fresh?tone(v?.direction):"neutral"}>{fresh?directionWord(v?.direction):"—"}</b></div>;
    })}</div>
    <div className="nt-bottom-grid" data-position={!!account?.positions.length}>
      <section className="nt-tile nt-checklist"><h3><Activity size={18}/>What Nitrous is waiting for</h3><ul>{checklist.map(row=>{
        const Icon=row.done?CheckCircle2:Circle;
        return <li key={row.label} data-done={row.done}><Icon size={17}/><div><span>{row.label}</span>{row.detail&&<small>{row.detail}</small>}</div></li>;
      })}</ul>{!plan&&!tradeLive&&fresh&&checks[0]&&<p className="nt-wait-reason">{checkName(checks[0].code)}</p>}</section>
      <NitrousLiveTrades account={account} accountNow={accountNow} referencePrice={fresh?reference:null} referenceAt={data?.asOf??null} now={now} simple={simple} busy={busy} onClose={onClose} embedded/>
    </div>
    {!simple&&<details className="nt-details"><summary>Scan details <ChevronDown size={15}/></summary>
      {flow.length>0&&<div className="nt-flow">{flow.map(v=><span key={v.timeframe}><small>{v.timeframe}</small><b data-tone={tone(v.direction)}>{biasWord(v.direction)}</b></span>)}</div>}
      {checks.length>0&&<div className="nt-funnel"><small>{fastScan?"Fast scanner":"Baseline scanner"} · recorded rejection checks</small>{checks.map(c=><div key={c.code}><span>{checkName(c.code)}</span><b>{c.count}</b></div>)}</div>}
      {plan&&<div className="nt-raw"><strong>{familyName(plan.family)} · {scenarioState(plan.state)}</strong>{[...plan.conditionsMet,...plan.conditionsPending].map((c,i)=><p key={i}>{c}</p>)}</div>}
      <p className="nt-detail-note">{data?.explanation??"Waiting for the engine."}</p>{data?.health.reasons.map((r,i)=><p className="nt-detail-note" key={i}>{r}</p>)}
    </details>}
  </section>;
}
export function NitrousLiveTrades({account,accountNow,referencePrice,referenceAt,now,simple,busy,onClose,embedded=false}:{
  account:NitrousAccount|null;embedded?:boolean;accountNow:number;referencePrice:number|null;referenceAt:string|null;now:number;simple:boolean;busy:boolean;onClose:(p:NitrousPosition)=>void;
}) {
  const emptyTitle=!account?"Connect an account":!accountNow?"Checking account":"No active trade";
  const emptyText=!account?"TradeLocker controls below.":!accountNow?"Awaiting account refresh.":account.automationEnabled?"Watching for entry.":"Auto trading is paused.";
  return <section className={`nt-trades ${embedded?"nt-tile nt-trade-embedded":"nitrous-positions nitrous-panel"}`} aria-labelledby="nitrous-positions-title">
    <div className="nt-trades-title"><h3 id="nitrous-positions-title"><Zap size={17}/>Live trade</h3><Pulse fresh={!!accountNow&&!!account?.positions.some(p=>isObservedTrade(p,accountNow))} caption={account?.masked??""}/></div>
    {!account||!account.positions.length?<div className="nt-empty-trade"><Crosshair size={28}/><strong>{emptyTitle}</strong><p>{emptyText}</p><div className="nt-empty-metrics">{["Entry","SL","TP","P&L"].map(label=><div key={label}><small>{label}</small><b>—</b></div>)}</div></div>:<div className="nt-trade-list">{account.positions.map(p=>{
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
