"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CandlestickChart } from "lucide-react";
import { OmChart } from "@/components/om/chart/OmChart";
import { candleTimeText, type TimedBar } from "@/lib/chart/candleTime";
import type { ChartLevel } from "@/lib/floor/chart";
import type { VisionBias } from "./VisionDirection";
import "./vision.css";

export type VisionChartProps = {
  bars: TimedBar[]; levels: ChartLevel[]; symbol: string; dec: number;
  timeframe: string; tfMs: number; price: number | null;
  direction: VisionBias; reference: boolean; snapshot?: boolean; priceLive?: boolean;
  simpleView?: boolean; watchPrice?: number | null; headerControl?: ReactNode;
  swing?: { t: number; price: number; label: string }; priceLabel?: string;
  marketStatus?: string; isOpenAt?: (at: number) => boolean;
  viewKey: string; zone?: {low:number;high:number}|null; title?:string; timeKnown?:boolean;
};
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
 * The market opens on the shared interactive chart. A separate setup map is
 * available when the read contains a coherent entry, stop and target.
 */
export function VisionChart({ bars: sourceBars, levels, symbol, dec, timeframe, tfMs, price, direction,
  reference, snapshot=false, priceLive=false, marketStatus, isOpenAt, viewKey, zone, title, timeKnown=true, simpleView=false, watchPrice, headerControl, swing, priceLabel }:VisionChartProps) {
  const [mapKey, setMapKey] = useState<string | null>(null);
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
  const bars=useMemo(()=>{
    const map=new Map<number,TimedBar>();
    for(const b of sourceBars??[]) {
      if(!b||![b.t,b.o,b.h,b.l,b.c].every(finite)||
        b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c,b.h))continue;
      map.set(b.t,b);
    }
    return [...map.values()].sort((a,b)=>a.t-b.t);
  },[sourceBars]);
  const recent = useMemo(() => bars.slice(-5), [bars]);
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
      startX,
      endX:finishX,
      entryY:y(entry.price),stopY:y(stop!.price),targetY:y(targetLast.price),
    }:null;
    const focusLevels = directionValid && entry && stop ? [
      {...entry, label: reference ? (isBuy ? "Buy watch" : "Sell watch") : "Entry"},
      {...stop, label: "Stop"}, {...targets[0], label: "First target"},
    ] : undefined;
    return {w,h,top,bottom,chartRight,focusLevels,display:sorted,candles,scenario,y,min,max,zone:directionValid&&zone?zone:null};
  },[recent,levels,price,zone,direction,width,reference]);

  const tone=direction==="sell"?"sell":direction==="buy"?"buy":"neutral";
  const hasHistory = bars.length >= 2;
  const showMap = Boolean(!simpleView && model.scenario && mapKey === viewKey);
  const sourceLabel = marketStatus || (snapshot ? "Saved snapshot" : priceLive ? "Live quote" : "Market read");
  const chartId = `vision-plot-${id}`;
  return <section className="om-vision-chart" data-direction={tone} data-reference={reference} aria-label={title ?? symbol + " price action chart"}>
    <header className="om-vision-chart-head">
      <div className="om-vision-instrument">
        <CandlestickChart size={19} aria-hidden="true" />
        <div><h3>{symbol}</h3><span>{!headerControl && timeframe + " · "}{sourceLabel}{!simpleView && reference && model.scenario && " · Watch levels only"}</span></div>
      </div>
      {headerControl}
      {!simpleView && hasHistory && model.scenario && <div className="om-vision-view" role="group" aria-label="Chart view">
        <button type="button" aria-controls={chartId} aria-pressed={!showMap} onClick={() => setMapKey(null)}>Candles</button>
        <button type="button" aria-controls={chartId} aria-pressed={showMap} onClick={() => setMapKey(viewKey)}>Setup map</button>
      </div>}
    </header>
    <div ref={host} id={chartId} className="om-vision-chart-body">
      {hasHistory && !showMap ? <div className="om-vision-expanded">
        <OmChart bars={bars} timeKnown={timeKnown} tfMs={tfMs} tfLabel={timeframe}
          framing={simpleView ? "setup" : "context"} focusLevels={model.focusLevels} swing={swing} priceLabel={priceLabel}
          simpleView={simpleView} watchPrice={watchPrice} price={price} priceLive={!snapshot && priceLive} snapshot={snapshot}
          dec={dec} levels={levels} isOpenAt={isOpenAt} labelStyle="backed" zone={zone ?? null}
          viewKey={viewKey} label={title ?? symbol + " recorded candlesticks"}/>
      </div> : recent.length ? <svg role="img" aria-label={symbol + " recorded candles and conditional levels"}
        data-no-i18n viewBox={"0 0 "+model.w+" "+model.h} width="100%" height={model.h} className="om-vision-chart-svg">
        <defs>
          <linearGradient id={"vision-profit-"+id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--om-vision-bull)" stopOpacity=".26"/>
            <stop offset="100%" stopColor="var(--om-vision-bull)" stopOpacity=".018"/>
          </linearGradient>
          <linearGradient id={"vision-loss-"+id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--om-vision-bear)" stopOpacity=".02"/>
            <stop offset="100%" stopColor="var(--om-vision-bear)" stopOpacity=".13"/>
          </linearGradient>
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
          <title>{candleTimeText(bar.t,timeKnown,recent[recent.length-1].t)+". Open "+format(bar.o,dec)+", high "+format(bar.h,dec)+", low "+format(bar.l,dec)+", close "+format(bar.c,dec)}</title>
          <line x1={bar.x} x2={bar.x} y1={bar.hi} y2={bar.lo} strokeWidth="2"/>
          <rect x={bar.x-bar.w/2} y={bar.bodyY} width={bar.w} height={bar.bodyHeight} rx="1.6"/>
        </g>)}
        {priceLive&&!snapshot&&finite(price)&&<g className="om-vision-live-price">
          <line x1="15" x2={model.chartRight} y1={model.y(price)} y2={model.y(price)}/>
          <circle cx={model.chartRight} cy={model.y(price)} r="3"/>
        </g>}
        <text className="om-vision-axis-note" x="18" y={model.h-13}>{recent.length} {recent.length === 1 ? "CANDLE" : "CANDLES"} · {timeframe}</text>
        {model.scenario&&<text className="om-vision-projection-note" x={model.chartRight-6}
          y="19" textAnchor="end">{reference?"WATCH LEVELS":"SETUP LEVELS"}</text>}
      </svg> : <div className="om-vision-chart-empty" role="status">Candle history is unavailable for this read.</div>}
    </div>
    {model.scenario && (showMap || bars.length === 1) && <p className="om-vision-chart-disclaimer">
      {reference?"Illustrated scenario only. Entry confirmation is still required.":"Recorded distances from entry to the stop and targets."}
    </p>}
  </section>;
}
