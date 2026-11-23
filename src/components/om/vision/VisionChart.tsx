"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, CandlestickChart, Activity } from "lucide-react";
import { OmChart } from "@/components/om/chart/OmChart";
import type { TimedBar } from "@/lib/chart/candleTime";
import type { ChartLevel } from "@/lib/floor/chart";
import type { VisionBias } from "./VisionDirection";
import "./vision.css";

export type VisionChartProps = {
  bars: TimedBar[]; levels: ChartLevel[]; symbol: string; dec: number;
  timeframe: string; tfMs: number; price: number | null;
  direction: VisionBias; reference: boolean; snapshot?: boolean; priceLive?: boolean;
  viewKey: string; zone?: {low:number;high:number}|null; title?:string; timeKnown?:boolean;
};
type VisualLevel = ChartLevel & { y:number; labelY:number; short:string; priority:number };
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
const format=(n:number,dec:number)=>n.toLocaleString("en-US",{minimumFractionDigits:dec,maximumFractionDigits:dec});
const isTrade=(k:string)=>k==="entry"||k==="stop"||k==="target";
const compact=(l:ChartLevel,idx:number):string=>{
  if(l.kind==="target") {
    const number=l.label.match(/(?:target|tp)\s*(\d+)/i);
    return "TP"+(number?.[1]??String(idx+1));
  }
  return l.kind==="entry"?"ENTRY":l.kind==="stop"?"SL":l.kind==="resistance"?"RESIST":"SUPPORT";
};

/**
 * A genuine price-scale candle chart with visually projected conditional
 * scenarios. No image candles, fabricated ticks or model-derived prices.
 * If a plan is unconfirmed the exact same plotted levels are clearly marked
 * "watch only"; no chart control triggers or authorizes an order.
 *
 * The five visible candles are enlarged; Full chart uses the proven interactive
 * OmChart with zoom/pan/fullscreen and the complete original candle history.
 */
export function VisionChart({ bars, levels, symbol, dec, timeframe, tfMs, price, direction,
  reference, snapshot=false, priceLive=false, viewKey, zone, title, timeKnown=true }:VisionChartProps) {
  const [expanded,setExpanded]=useState(false);
  const host=useRef<HTMLDivElement>(null);
  const [width,setWidth]=useState(640);
  const id=useId().replace(/[^a-zA-Z0-9]/g,"");
  useEffect(()=>{
    const el=host.current;
    if(!el)return;
    const measure=()=>{const w=el.getBoundingClientRect().width;if(w>0)setWidth(Math.round(w));};
    measure();
    if(typeof ResizeObserver!=="function")return;
    const obs=new ResizeObserver(measure);
    obs.observe(el);
    return ()=>obs.disconnect();
  },[]);
  useEffect(()=>setExpanded(false),[viewKey]);
  const recent=useMemo(()=>{
    const map=new Map<number,TimedBar>();
    for(const b of bars??[]) {
      if(!b||![b.t,b.o,b.h,b.l,b.c].every(finite)||
        b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c,b.h))continue;
      map.set(b.t,b);
    }
    return [...map.values()].sort((a,b)=>a.t-b.t).slice(-5);
  },[bars]);
  const model=useMemo(()=>{
    const w=Math.max(320,width);
    const h=w<510?350:380;
    const chartRight=w-117;
    const isBuy=direction==="buy", isSell=direction==="sell";
    const trade=levels.filter(l=>isTrade(l.kind)&&finite(l.price));
    const support=levels.filter(l=>!isTrade(l.kind)&&finite(l.price));
    // The actual price scale must be coherent: do not superimpose targets on a
    // second secret axis. When trade levels exist, peripheral support/resistance
    // stay in Full chart so distant levels don't flatten actual price action.
    const display=trade.length?trade:support.slice(0,2);
    const entry=trade.find(l=>l.kind==="entry");
    const stop=trade.find(l=>l.kind==="stop");
    const targets=trade.filter(l=>l.kind==="target").slice(0,3);
    const directionValid=!!entry&&!!stop&&targets.length>0 &&
      ((isBuy&&stop.price<entry.price&&targets.every(t=>t.price>entry.price))||
       (isSell&&stop.price>entry.price&&targets.every(t=>t.price<entry.price)));
    const values=[
      ...recent.flatMap(b=>[b.h,b.l]),
      ...display.map(l=>l.price),
      ...(finite(price)?[price]:[]),
      ...(zone&&finite(zone.low)&&finite(zone.high)&&trade.length?[zone.low,zone.high]:[]),
    ];
    const rawMin=values.length?Math.min(...values):0,rawMax=values.length?Math.max(...values):1;
    const span=Math.max(rawMax-rawMin,Math.abs(rawMax)*.00002,.01);
    const min=rawMin-span*.13,max=rawMax+span*.13;
    const top=37,bottom=h-36;
    const y=(p:number)=>bottom-(p-min)/(max-min)*(bottom-top);
    const candleRight=directionValid?Math.max(130,chartRight*.59):chartRight-22;
    const candleLeft=30;
    const slot=(candleRight-candleLeft)/Math.max(1,recent.length);
    const cW=Math.min(34,Math.max(6,slot*.55));
    const candles=recent.map((bar,i)=>({
      ...bar,x:candleLeft+(i+.5)*slot,w:cW,
      hi:y(bar.h),lo:y(bar.l),bodyY:Math.min(y(bar.o),y(bar.c)),
      bodyHeight:Math.max(1.7,Math.abs(y(bar.o)-y(bar.c))),up:bar.c>=bar.o,
    }));
    const mapped=display.map((l,i)=>{
      const short=compact(l,targets.findIndex(t=>t===l));
      return {...l,short,y:y(l.price),labelY:y(l.price),priority:l.kind==="entry"?1:l.kind==="stop"?2:3};
    });
    // Price labels have a minimum vertical gap, with leaders to exact levels.
    const sorted=[...mapped].sort((a,b)=>a.labelY-b.labelY);
    const gap=25;
    for(let i=1;i<sorted.length;i++) sorted[i].labelY=Math.max(sorted[i].labelY,sorted[i-1].labelY+gap);
    if(sorted.length&&sorted[sorted.length-1].labelY>bottom){
      const d=sorted[sorted.length-1].labelY-bottom;
      for(const label of sorted)label.labelY-=d;
    }
    if(sorted.length&&sorted[0].labelY<top) {
      const d=top-sorted[0].labelY;
      for(const label of sorted)label.labelY+=d;
    }
    const targetLast=targets.at(-1)??null;
    const startX=candleRight+8;
    const finishX=chartRight-13;
    const scenario=directionValid&&entry&&targetLast?{
      startX, startY:y(entry.price),
      endX:finishX, endY:y(targetLast.price),
      path:"M"+startX+" "+y(entry.price)+
        " C"+(startX+38)+" "+y(entry.price)+
        " "+(finishX-70)+" "+y(targets[0].price)+
        " "+(finishX-49)+" "+y(targets[0].price)+
        " S"+(finishX-24)+" "+y(targetLast.price)+" "+finishX+" "+y(targetLast.price),
      entryY:y(entry.price),stopY:y(stop!.price),targetY:y(targetLast.price),
    }:null;
    return {w,h,top,bottom,chartRight,display:sorted,candles,scenario,y,min,max,zone:directionValid&&zone?zone:null};
  },[recent,levels,price,zone,direction,width]);

  const tone=direction==="sell"?"sell":direction==="buy"?"buy":"neutral";
  const hasBars=recent.length>0;
  return <section className="om-vision-chart" data-direction={tone} data-reference={reference} aria-label={title??symbol+" price action chart"}>
    <header className="om-vision-chart-head">
      <div><span className="om-vision-overline">PRICE ACTION MAP</span>
        <h3>{symbol}<small>{timeframe} · {snapshot?"Saved market read":"Recorded candles"}</small></h3></div>
      <div className="om-vision-chart-tools">
        <span className="om-vision-chart-mode" title="Candlesticks"><CandlestickChart size={16}/></span>
        <button type="button" onClick={()=>setExpanded(v=>!v)} aria-expanded={expanded}
          aria-label={expanded?"Close full chart":"Open full interactive chart"}>
          {expanded?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button>
      </div>
    </header>
    {hasBars?<div ref={host} className="om-vision-chart-body" data-no-i18n translate="no">
      {expanded?<div className="om-vision-expanded">
        <OmChart bars={bars} timeKnown={timeKnown} tfMs={tfMs} tfLabel={timeframe}
          price={price} priceLive={!snapshot&&priceLive} snapshot={snapshot}
          dec={dec} levels={levels} zone={zone??null}
          viewKey={viewKey+":expanded"} label={title??symbol+" actual recorded candles"}/>
      </div>:<svg role="img" aria-label={symbol+" five actual candles with exact recorded prices and conditional levels"}
        viewBox={"0 0 "+model.w+" "+model.h} width="100%" height={model.h} className="om-vision-chart-svg">
        <defs>
          <linearGradient id={"vision-profit-"+id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--om-vision-bull)" stopOpacity=".26"/>
            <stop offset="100%" stopColor="var(--om-vision-bull)" stopOpacity=".018"/>
          </linearGradient>
          <linearGradient id={"vision-loss-"+id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--om-vision-bear)" stopOpacity=".02"/>
            <stop offset="100%" stopColor="var(--om-vision-bear)" stopOpacity=".13"/>
          </linearGradient>
          <marker id={"vision-arrow-"+id} markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
            <path d="M1 1L7.5 4.5L1 8" fill="none" stroke="var(--om-vision-bull)" strokeWidth="1.8" strokeLinecap="round"/>
          </marker>
          <clipPath id={"vision-clip-"+id}><rect x="14" y={model.top} width={model.chartRight-14} height={model.bottom-model.top}/></clipPath>
        </defs>
        {[0,1,2,3,4].map((n)=>{
          const value=model.min+(model.max-model.min)*(n/4);
          const y=model.y(value);
          return <g key={n}><line className="om-vision-grid" x1="15" y1={y} x2={model.chartRight} y2={y}/>
            <text className="om-vision-tick" x={model.w-8} y={y+4} textAnchor="end">{format(value,dec)}</text></g>;
        })}
        {model.scenario&&<g clipPath={"url(#vision-clip-"+id+")"}>
          <rect x={model.scenario.startX} y={Math.min(model.scenario.targetY,model.scenario.entryY)}
            width={Math.max(0,model.scenario.endX-model.scenario.startX)} height={Math.abs(model.scenario.targetY-model.scenario.entryY)}
            fill={"url(#vision-profit-"+id+")"}/>
          <rect x={model.scenario.startX} y={Math.min(model.scenario.entryY,model.scenario.stopY)}
            width={Math.max(0,model.scenario.endX-model.scenario.startX)}
            height={Math.abs(model.scenario.entryY-model.scenario.stopY)} fill={"url(#vision-loss-"+id+")"}/>
        </g>}
        {model.display.map((level,i)=><g key={level.kind+level.price+i} className="om-vision-chart-level" data-kind={level.kind}>
          <line x1={Math.max(15,level.kind==="target"?model.scenario?.startX??15:15)}
            x2={model.chartRight-5} y1={level.y} y2={level.y} className="om-vision-level-line"/>
          <path d={"M"+(model.chartRight-4)+" "+level.y+"L"+(model.chartRight+5)+" "+level.labelY}
            className="om-vision-level-leader"/>
          <rect className="om-vision-level-pill" x={model.chartRight+5} y={level.labelY-13}
            width={model.w-model.chartRight-8} height="26" rx="7"/>
          <text className="om-vision-level-name" x={model.chartRight+12} y={level.labelY+3}>{level.short}</text>
          <text className="om-vision-level-value" x={model.w-10} y={level.labelY+3} textAnchor="end">{format(level.price,dec)}</text>
        </g>)}
        {model.candles.map((bar,i)=><g key={bar.t} className="om-vision-candle" data-up={bar.up}>
          <title>{new Date(bar.t).toISOString()+": Open "+format(bar.o,dec)+", high "+format(bar.h,dec)+", low "+format(bar.l,dec)+", close "+format(bar.c,dec)}</title>
          <line x1={bar.x} x2={bar.x} y1={bar.hi} y2={bar.lo} strokeWidth="2"/>
          <rect x={bar.x-bar.w/2} y={bar.bodyY} width={bar.w} height={bar.bodyHeight} rx="1.6"/>
        </g>)}
        {model.scenario&&<g className="om-vision-projection">
          <path d={model.scenario.path} fill="none" strokeDasharray="8 7" strokeWidth="2.6"
            markerEnd={"url(#vision-arrow-"+id+")"}/>
          <circle cx={model.scenario.startX} cy={model.scenario.startY} r="5"/>
          <circle cx={model.scenario.startX} cy={model.scenario.startY} r="11" className="om-vision-projection-halo"/>
        </g>}
        {priceLive&&!snapshot&&finite(price)&&<g className="om-vision-live-price">
          <line x1="15" x2={model.chartRight} y1={model.y(price)} y2={model.y(price)}/>
          <circle cx={model.chartRight} cy={model.y(price)} r="3"/>
        </g>}
        <text className="om-vision-axis-note" x="18" y={model.h-13}>LAST 5 REAL CANDLES · {timeframe}</text>
        {model.scenario&&<text className="om-vision-projection-note" x={model.chartRight-6}
          y="19" textAnchor="end">{reference?"CONDITIONAL PATH":"SETUP PATH"}</text>}
      </svg>}
    </div>:<div ref={host} className="om-vision-chart-empty">Verified candle history unavailable.</div>}
    <div className="om-vision-chart-foot"><span><Activity size={13}/>
      {snapshot?"Saved snapshot · not a live price feed":
       priceLive?"Actual price ticks · analysis updates separately":"Recorded candles · check quote freshness"}
    </span><button type="button" onClick={()=>setExpanded(v=>!v)}>{expanded?"Five-candle view":"Full chart"} →</button></div>
    <p className="om-vision-chart-disclaimer">
      {model.scenario?reference?"Illustrated scenario only. Entry confirmation is still required.":"Projected path is conditional, never guaranteed.":
      "No entry has been confirmed. Only recorded candle structure is shown."}
    </p>
  </section>;
}
