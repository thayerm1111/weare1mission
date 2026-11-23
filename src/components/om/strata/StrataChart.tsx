"use client";

import { useState } from "react";
import { VisionChart } from "@/components/om/vision/VisionChart";
import type { ChartLevel } from "@/lib/floor/chart";
import type { Analysis, Bar, Scenario } from "@/lib/strata/engine";

const OPTIONS = [
  { key: "m5" as const, title: "5M", ms: 300_000 },
  { key: "m15" as const, title: "15M", ms: 900_000 },
  { key: "h1" as const, title: "1H", ms: 3_600_000 },
  { key: "h4" as const, title: "4H", ms: 14_400_000 },
];
type Horizon = typeof OPTIONS[number]["key"];
type Series = { m5: Bar[]; m15: Bar[]; h1: Bar[]; h4: Bar[] };

/** STRATA visualization only — never overrides or invents the engine's levels. */
export function StrataChart({ analysis, bars, price, live, selected, snapshot = false }: {
  analysis: Analysis; bars: Series; price: number; live: boolean;
  selected: Scenario | null; snapshot?: boolean;
}) {
  const [frame,setFrame]=useState<Horizon>("m15");
  const tf=OPTIONS.find(x=>x.key===frame)!;
  const levels:ChartLevel[]=[];
  const add=(kind:ChartLevel["kind"],value:number|null|undefined,label:string)=>{
    if(typeof value==="number"&&Number.isFinite(value))levels.push({kind,price:value,label});
  };
  if(selected && selected.entry!==null){
    add("entry",selected.entry,"Entry"); add("stop",selected.stop,"Stop");
    selected.targets.slice(0,3).forEach((target,i)=>add("target",target,"Target "+(i+1)));
  }else{
    add("support",analysis.range.low,"Range low");
    add("resistance",analysis.range.high,"Range high");
    if(selected)add(selected.side==="buy"?"support":"resistance",selected.level,"Decision level");
  }
  const dir=selected&&selected.entry!==null&&selected.stop!==null&&selected.targets.length
    ? selected.side : analysis.regime==="uptrend"?"buy" : analysis.regime==="downtrend"?"sell" :
      analysis.regime==="range"?"range":"mixed";
  return (
    <div className="strata-chart strata-chart-vision">
      <div className="strata-vision-tf">
        <span>GOLD PRICE ACTION</span>
        <div className="strata-timeframe" role="group" aria-label="Price-action timeframe">
          {OPTIONS.map(x=><button type="button" key={x.key} aria-pressed={frame===x.key}
            onClick={()=>setFrame(x.key)}>{x.title}</button>)}
        </div>
      </div>
      <VisionChart bars={bars[frame]??[]} timeframe={tf.title} tfMs={tf.ms}
        timeKnown dec={2} symbol="XAU/USD" levels={levels}
        price={price} priceLive={live&&!snapshot} snapshot={snapshot}
        direction={dir} reference={!selected||selected.reference||selected.stage!=="ready"}
        zone={selected ? {low:selected.zone.low,high:selected.zone.high}:null}
        viewKey={"strata:vision:"+frame+":"+(selected?.id??"none")}
        title="STRATA real gold candles and conditional price-action decision levels"/>
    </div>
  );
}
