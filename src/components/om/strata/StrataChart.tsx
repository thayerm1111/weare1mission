"use client";

import { ArrowDownRight, ArrowUpRight, ChevronDown, ChevronUp, Crosshair } from "lucide-react";
import { VisionChart } from "@/components/om/vision/VisionChart";
import type { ChartLevel } from "@/lib/floor/chart";
import type { Analysis, Bar, Scenario } from "@/lib/strata/engine";
import type { ChartFrame, PriceStructure } from "./priceStructure";

const OPTIONS = [
  { key: "m5" as const, title: "5M", ms: 300_000 },
  { key: "m15" as const, title: "15M", ms: 900_000 },
  { key: "h1" as const, title: "1H", ms: 3_600_000 },
  { key: "h4" as const, title: "4H", ms: 14_400_000 },
];
type Series = { m5: Bar[]; m15: Bar[]; h1: Bar[]; h4: Bar[] };

/** STRATA visualization only — never overrides or invents the engine's levels. */
export function StrataChart({ analysis, bars, price, live, selected, frame, onFrame, structure, snapshot = false, simple = false, watchPrice }: {
  analysis: Analysis; bars: Series; price: number; live: boolean;
  selected: Scenario | null; snapshot?: boolean; simple?: boolean; watchPrice?: number | null;
  frame: ChartFrame; onFrame: (frame: ChartFrame) => void; structure: PriceStructure | null;
}) {
  const tf=OPTIONS.find(x=>x.key===frame)!;
  const levels:ChartLevel[]=[];
  const add=(kind:ChartLevel["kind"],value:number|null|undefined,label:string)=>{
    if(typeof value==="number"&&Number.isFinite(value))levels.push({kind,price:value,label});
  };
  if(selected && selected.entry!==null){
    add("entry",selected.entry,selected.reference || selected.stage !== "ready" ? "Watch entry" : "Entry"); add("stop",selected.stop,"Stop");
    selected.targets.slice(0,simple ? 1 : 3).forEach((target,i)=>add("target",target,"Target "+(i+1)));
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
      {!simple && <div className="strata-vision-tf">
        <span>GOLD PRICE ACTION</span>
        <div className="strata-timeframe" role="group" aria-label="Price-action timeframe">
          {OPTIONS.map(x=><button type="button" key={x.key} aria-pressed={frame===x.key}
            onClick={()=>onFrame(x.key)}>{x.title}</button>)}
        </div>
      </div>}
      <VisionChart bars={bars[frame]??[]} timeframe={tf.title} tfMs={tf.ms}
        simpleView={simple} watchPrice={watchPrice} swing={structure?.swing}
        priceLabel={snapshot ? "At capture" : live ? "Live quote" : "Reference"}
        headerControl={simple && <select className="om-simple-chart-frame" aria-label="Price-action timeframe" value={frame}
          onChange={e => onFrame(e.target.value as ChartFrame)}>{OPTIONS.map(option =>
            <option key={option.key} value={option.key}>{option.title.toLowerCase()}</option>)}</select>}
        marketStatus={simple ? snapshot ? "Saved chart" : live ? "Live quote" : "Last available candles" : undefined}
        timeKnown dec={2} symbol="XAU/USD" levels={levels}
        price={price} priceLive={live&&!snapshot} snapshot={snapshot}
        direction={dir} reference={!selected||selected.reference||selected.stage!=="ready"}
        zone={selected ? {low:selected.zone.low,high:selected.zone.high}:null}
        viewKey={"strata:vision:"+frame+":"+(selected?.id??"none")}
        title="STRATA real gold candles and conditional price-action decision levels"/>
      {simple && structure && <section className="strata-chart-structure" aria-label={tf.title + " price structure"}>
        <h3>Price structure</h3>
        <ul>
          <li>{structure.swing.label === "Swing low" ? <ChevronDown aria-hidden="true"/> : <ChevronUp aria-hidden="true"/>}
            <span><strong>{structure.swing.label}</strong><small>{structure.swing.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</small></span></li>
          {structure.reaction && <li>{structure.reaction === "Recovery" ? <ArrowUpRight aria-hidden="true"/> : <ArrowDownRight aria-hidden="true"/>}
            <span><strong>{structure.reaction}</strong><small>{structure.reaction === "Recovery" ? "Price rose" : "Price fell"}</small></span></li>}
          {watchPrice != null && <li><Crosshair aria-hidden="true"/><span><strong>{selected?.reference === false && selected.stage === "ready" ? "Trigger level" : "Watch level"}</strong>
            <small>{watchPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</small></span></li>}
        </ul>
      </section>}
    </div>
  );
}
