"use client";

import { useMemo, useState } from "react";
import { Activity, ChevronDown, Crosshair, Layers3, RefreshCw, ShieldCheck, Sparkles, TrendingDown, TrendingUp, Waves, Zap } from "lucide-react";
import { OmChart } from "../chart/OmChart";
import type { ChartLevel } from "@/lib/floor/chart";
import type { NitrousAccount, NitrousAnalyze, NitrousMode, NitrousPosition } from "@/lib/nitrous/types";
import { isObservedTrade, pricePulse, tradeProgress } from "@/lib/nitrous/dashboard";
import { elapsed, money, price, scenarioState } from "./presentation";
import "./nitrous-desk.css";

const familyName=(v:string)=>({trend_pullback:"Pullback",break_retest:"Break & retest",range_reaction:"Range reaction",momentum:"Momentum"} as Record<string,string>)[v]??"Price action";
const checkName=(v:string)=>({no_zone:"No validated zone",stop_too_wide:"Stop too wide",target_room_short:"Target room too small",regime_conflict:"Structure not aligned",reward_risk_short:"Reward/risk too low",arbitration_lost:"Competing setup",no_anchor:"No structural stop",opposite_break:"Opposing breakout",outside_band:"Outside entry zone",expired:"Setup expired",warmup:"Warming up",cost_too_high:"Cost too high",spread_too_wide:"Spread too wide",no_opposing_room:"Insufficient room"} as Record<string,string>)[v]??v.replaceAll("_"," ");
const tone=(v:unknown)=>v==="up"?"positive":v==="down"?"negative":"neutral";
const biasWord=(v:unknown)=>v==="up"?"Bullish":v==="down"?"Bearish":v==="range"?"Range":"Unknown";
function Pulse({fresh,caption}: {fresh:boolean;caption:string}) {
  return <span className="nt-live" data-fresh={fresh}><i/><span>{caption}</span></span>;
}
export function NitrousMarketDesk({data,loading,error,fresh,now,accountNow,account,onRefresh,simple,mode}:{
  data:NitrousAnalyze|null; loading:boolean;error:string;fresh:boolean;now:number;accountNow:number;account:NitrousAccount|null;onRefresh:()=>void;simple:boolean;mode:NitrousMode;
}) {
  const [chosenId,setChosenId]=useState("");
  const scenarios=(data?.scenarios??[]).filter(s=>mode==="nitrous"||s.profile!=="nitrous");
  const plan=scenarios.find(s=>s.setupId===chosenId)??scenarios[0]??null;
  const flow=data?.flow??[];
  const bias=flow.find(f=>f.timeframe.toUpperCase()==="1H");
  const m15=flow.find(f=>f.timeframe.toUpperCase()==="15M");
  const m5=flow.find(f=>f.timeframe.toUpperCase()==="5M");
  const open=account?.positions.find(p=>p.status==="open"||p.status==="closing")??null;
  const tradeLive=!!open&&isObservedTrade(open,accountNow);
  const planCurrent=!!plan&&fresh&&plan.expiresAt>now&&!["expired","stale","invalidated","consumed"].includes(plan.state);
  const zones=fresh?(data?.diagnostics?.watchLevels??[]):[];
  const checks=mode==="nitrous"&&data?.diagnostics?.fastChecks.length?data.diagnostics.fastChecks:data?.diagnostics?.baselineChecks??[];
  const pulse=useMemo(()=>pricePulse(data?.bars??[]),[data?.bars]);
  const reference=typeof data?.price==="number"&&Number.isFinite(data.price)?data.price:null;
  const waiting=!fresh?"Fresh data":planCurrent&&plan?(plan.state==="triggered"?"Broker checks":plan.state==="armed"?"Entry zone":plan.family==="break_retest"?"Retest":"Rejection"):"Valid structure";
  const trigger=!fresh?"Delayed":planCurrent&&plan?(plan.state==="triggered"?"Observed":plan.state==="armed"?"Armed":plan.state==="approaching"?"Approaching":"Watching"):"Scanning";
  const nearDistance=planCurrent&&plan&&reference!==null?Math.max(plan.entryBandLow-reference,reference-plan.entryBandHigh,0):null;
  const chart=useMemo(()=>{
    const levels:ChartLevel[]=[];
    const add=(kind:ChartLevel["kind"],value:number|null|undefined,label:string)=>{if(typeof value==="number"&&Number.isFinite(value)&&value>0)levels.push({kind,price:value,label});};
    if(open){add("entry",open.entry,"Trade entry");add("stop",open.stop,"SL");add("target",open.target,"TP");}
    else if(planCurrent&&plan){add("entry",plan.refEntry,plan.family==="break_retest"?"Retest":"Entry");add("stop",plan.stop,"SL");add("target",plan.target,"TP");}
    else for(const z of zones)add(z.role,z.role==="support"?z.high:z.low,z.role==="resistance"?"Supply":"Support");
    return {bars:data?.bars??[],timeKnown:true,tfMs:300000,tfLabel:"5m",price:reference,priceLive:false,dec:2,levels,
      zone:!open&&planCurrent&&plan?{low:plan.entryBandLow,high:plan.entryBandHigh}:null,
      structureZones:open?[]:zones.map(z=>({low:z.low,high:z.high,kind:z.role,label:z.role==="resistance"?"Supply":"Support"})),
      viewKey:`nitrous:desk:${open?.id??(planCurrent?plan?.setupId:"scan")??"scan"}`,label:open?"Gold candles and recorded trade levels":"Gold candles and engine-confirmed watch levels",fitLevels:!!open||planCurrent,labelStyle:"backed" as const,emaPeriod:9};
  },[data?.bars,reference,open,planCurrent,plan,zones]);
  const Direction=bias?.direction==="up"?TrendingUp:bias?.direction==="down"?TrendingDown:Waves;
  const summary=fresh?[bias&&bias.direction!=="unknown"?`1H ${biasWord(bias.direction).toLowerCase()}`:null,m15&&m15.direction!=="unknown"?`15M ${biasWord(m15.direction).toLowerCase()}`:null,m5&&m5.direction!=="unknown"?`5M ${biasWord(m5.direction).toLowerCase()}`:null,planCurrent&&plan?familyName(plan.family):checks[0]?checkName(checks[0].code):"Watching for structure"].filter(Boolean):["Waiting for a fresh scan"];
  return <section className="nitrous-market nitrous-panel nt-desk" aria-labelledby="nitrous-market-title">
    <div className="nitrous-section-head"><div><span className="nitrous-eyebrow">XAUUSD · GOLD</span><h2 id="nitrous-market-title">Market &amp; setups</h2></div><div className="nt-header-actions"><Pulse fresh={fresh} caption={fresh?"SCAN ACTIVE":data?.available?"DELAYED":"CONNECTING"}/><button type="button" className="nitrous-icon-button" onClick={onRefresh} disabled={loading} aria-label="Refresh gold setups"><RefreshCw size={17} className={loading?"nitrous-spin":""}/></button></div></div>
    <div className="nt-overview">
      <div className="nt-tile nt-price"><small>GOLD · USD/OZ</small><strong>{price(reference)}</strong><span>{fresh?"Reference price":"Last read"} · {elapsed(data?.asOf,now)}</span></div>
      <div className="nt-tile nt-pulse"><div><Activity size={15}/><span>Price pulse</span></div>{pulse?<><svg viewBox="0 0 120 38" preserveAspectRatio="none" role="img" aria-label="Actual recent five-minute closing prices"><polyline points={pulse.points} fill="none" vectorEffect="non-scaling-stroke" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg><small data-tone={pulse.change>=0?"positive":"negative"}>{pulse.change>=0?"+":""}{pulse.change.toFixed(2)}% · {Math.min(data?.bars.length??0,24)} closes</small></>:<small>No price history</small>}</div>
      <div className="nt-tile nt-status-lines"><div><Direction size={15}/><small>Bias</small><b data-tone={fresh?tone(bias?.direction):"neutral"}>{fresh?biasWord(bias?.direction):"Delayed"}</b></div><div><Layers3 size={15}/><small>Waiting</small><b>{waiting}</b></div><div><Zap size={15}/><small>Trigger</small><b data-tone={trigger==="Observed"?"positive":"neutral"}>{trigger}</b></div></div>
    </div>
    {error&&<p className="nitrous-error" role="alert">{error}</p>}
    <div className="nt-chart-head"><span><i/>{open?(tradeLive?"Trade overlay":"Recorded trade") : planCurrent&&plan?`${plan.side.toUpperCase()} · ${familyName(plan.family)}`:"Watching levels"}</span><small>5m · EMA 9</small></div>
    {data?.bars.length?<div className="nitrous-chart nt-chart"><OmChart {...chart}/></div>:<div className="nitrous-chart-empty"><Activity size={28}/><strong>{loading?"Loading gold candles…":"Waiting for market data"}</strong><span>{data?.reason??"The chart appears with the next market read."}</span></div>}
    <div className="nitrous-chart-caption"><span>Completed candles · reference feed</span><span>{elapsed(data?.asOf,now)}</span></div>
    {scenarios.length>1&&<div className="nitrous-setup-picker" role="group" aria-label="Available setups">{scenarios.map(p=><button key={p.setupId} type="button" aria-pressed={p.setupId===plan?.setupId} onClick={()=>setChosenId(p.setupId)}>{p.side.toUpperCase()} · {familyName(p.family)}{p.profile==="nitrous"?" · Fast":""}</button>)}</div>}
    <div className="nt-insights">
      <section className="nt-tile nt-story"><h3><Sparkles size={17}/>What Nitrous sees</h3><ul>{summary.map((v,i)=><li key={i}><i/>{v}</li>)}</ul></section>
      <section className="nt-tile nt-plan"><h3><Crosshair size={17}/>Setup</h3><dl>
        <div><dt>State</dt><dd>{open?(tradeLive?"Trade open":"Trade check"):planCurrent?trigger:"Scanning"}</dd></div>
        <div><dt>{planCurrent&&plan?"Entry zone":"Nearest supply"}</dt><dd>{planCurrent&&plan?`${price(plan.entryBandLow)}–${price(plan.entryBandHigh)}`:price(zones.find(z=>z.role==="resistance")?.low)}</dd></div>
        <div><dt>{planCurrent&&plan?"Invalidation":"Nearest support"}</dt><dd>{planCurrent&&plan?price(plan.invalidation):price(zones.find(z=>z.role==="support")?.high)}</dd></div>
        <div><dt>{planCurrent&&plan?"Target":"Trigger"}</dt><dd>{planCurrent&&plan?price(plan.target):fresh?"Not confirmed":"Delayed"}</dd></div>
      </dl>{nearDistance!==null&&<small className="nt-distance">{nearDistance===0?"Price in entry zone":`$${nearDistance.toFixed(2)} to entry zone`}</small>}</section>
    </div>
    {!simple&&<details className="nt-details"><summary>Scan details <ChevronDown size={15}/></summary>
      {flow.length>0&&<div className="nt-flow">{flow.map(v=><span key={v.timeframe}><small>{v.timeframe}</small><b data-tone={tone(v.direction)}>{biasWord(v.direction)}</b></span>)}</div>}
      {checks.length>0&&<div className="nt-funnel"><small>{mode==="nitrous"&&data?.diagnostics?.fastChecks.length?"Fast scanner":"Baseline scanner"} · recorded rejection checks</small>{checks.map(c=><div key={c.code}><span>{checkName(c.code)}</span><b>{c.count}</b></div>)}</div>}
      {plan&&<div className="nt-raw"><strong>{familyName(plan.family)} · {scenarioState(plan.state)}</strong>{[...plan.conditionsMet,...plan.conditionsPending].map((c,i)=><p key={i}>{c}</p>)}</div>}
      <p className="nt-detail-note">{data?.explanation??"Waiting for the engine."}</p>{data?.health.reasons.map((r,i)=><p className="nt-detail-note" key={i}>{r}</p>)}
    </details>}
  </section>;
}
export function NitrousLiveTrades({account,accountNow,referencePrice,referenceAt,now,simple,busy,onClose}:{
  account:NitrousAccount;accountNow:number;referencePrice:number|null;referenceAt:string|null;now:number;simple:boolean;busy:boolean;onClose:(p:NitrousPosition)=>void;
}) {
  return <section className="nitrous-positions nitrous-panel nt-trades" aria-labelledby="nitrous-positions-title">
    <div className="nitrous-section-head"><div><span className="nitrous-eyebrow">THIS ACCOUNT · {account.masked}</span><h2 id="nitrous-positions-title">Live trades</h2></div><span className="nitrous-count">{account.positions.length}</span></div>
    {!account.positions.length?<div className="nt-empty-trade"><Crosshair size={24}/><div><strong>No open Nitrous trades</strong><p>{account.automationEnabled?"Waiting for a qualifying entry.":"Auto trading is paused."}</p></div></div>:<div className="nt-trade-list">{account.positions.map(p=>{
      const live=isObservedTrade(p,accountNow);
      const pnl=live&&typeof p.unrealizedPnl==="number"&&Number.isFinite(p.unrealizedPnl)?p.unrealizedPnl:null;
      const progress=live?tradeProgress(p,referencePrice):null;
      const rejected=p.closeRequestState==="rejected";
      const pending=!rejected&&(!!p.closeRequestState||p.status==="closing"||!!p.closeRequestedAt);
      const closeLabel=p.closeRequestState==="uncertain"?"Close pending · reconciling with broker":pending?"Close requested · awaiting confirmation":rejected?"Retry position close":"Close position";
      return <article key={p.id} className="nt-trade" data-side-trade={p.side} data-observed={live}>
        <header><div><Crosshair size={18}/><strong><span data-side={p.side}>{p.side.toUpperCase()}</span> XAUUSD</strong></div><Pulse fresh={live} caption={live?(p.status==="closing"?"CLOSING":"BROKER OPEN"):"CHECKING"}/></header>
        <div className="nt-trade-values"><div><small>Entry</small><b>{price(p.entry)}</b></div><div><small>SL</small><b data-tone="negative">{price(p.stop)}</b></div><div><small>TP</small><b data-tone="positive">{price(p.target)}</b></div><div><small>Size</small><b>{p.quantity} lot</b></div><div><small>Risk preset</small><b>{p.riskPct==null?"—":`${p.riskPct}%`}</b></div><div className="nt-floating"><small>Floating P&amp;L</small><b data-tone={pnl==null?"neutral":pnl>=0?"positive":"negative"}>{pnl==null?"—":`${pnl>0?"+":""}${account.currency?money(pnl,account.currency):price(pnl)}`}</b><span>{pnl===null?"Awaiting broker value":account.currency?"Broker reported":"Broker value · currency unknown"}</span></div></div>
        {progress&&<div className="nt-progress"><div className="nt-progress-label"><small>Price progress · reference</small><strong>{price(referencePrice)}</strong></div><div className="nt-progress-track" role="img" aria-label={`Reference price ${price(referencePrice)} between initial stop ${price(p.initialStop??p.stop)} and target ${price(p.target)}`}>
          <i className="nt-progress-fill" data-tone={progress.towardTarget?"positive":"negative"} style={{left:`${Math.min(progress.entry,progress.current)}%`,width:`${Math.abs(progress.current-progress.entry)}%`}}/><i className="nt-entry-mark" style={{left:`${progress.entry}%`}}/>{progress.stop!==null&&<i className="nt-stop-mark" style={{left:`${progress.stop}%`}}/>}<i className="nt-now-mark" style={{left:`${progress.current}%`}}/></div><div className="nt-progress-ends"><span>Initial stop {price(p.initialStop??p.stop)}</span><span>TP {price(p.target)}</span></div><small className="nt-detail-note">Reference · {elapsed(referenceAt,now)} · not an executable quote</small></div>}
        <div className="nt-trade-footer"><p><ShieldCheck size={14}/>{p.protectionState==="protected"||p.protectionState==="verified"?"Broker stop verified":"Protection check pending"}{!simple&&` · Management ${p.managementEnabled?"on":"off"}`}{live&&` · ${elapsed(p.liveObservedAt,accountNow)}`}</p><button type="button" className="nitrous-position-close" disabled={busy||pending} onClick={()=>onClose(p)}>{closeLabel}</button></div>
        {rejected&&<p className="nt-detail-note" role="status">{p.closeRequestError||"Broker rejected the close. Position remains open."}</p>}
      </article>;
    })}</div>}
  </section>;
}
