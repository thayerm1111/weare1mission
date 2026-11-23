"use client";

import { useMemo, useState } from "react";
import { Maximize2, ZoomIn } from "lucide-react";
import { OmChart } from "@/components/om/chart/OmChart";
import { SignalFocusChart } from "@/components/om/chart/SignalFocusChart";
import type { ChartLevel } from "@/lib/floor/chart";
import { isOpen } from "@/lib/cashtrap/marketHours";
import type { Analysis, Bar, Scenario } from "@/lib/strata/engine";

const OPTIONS = [
  { key: "m5", title: "5M", ms: 300000 },
  { key: "m15", title: "15M", ms: 900000 },
  { key: "h1", title: "1H", ms: 3600000 },
  { key: "h4", title: "4H", ms: 14400000 },
] as const;
type Horizon = typeof OPTIONS[number]["key"];
type Series = { m5: Bar[]; m15: Bar[]; h1: Bar[]; h4: Bar[] };
const goldOpen = (t: number) => isOpen("metal", t);
const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** An annotated structure map. Five actual candles and the conditional path are
 *  intentionally separate scales, with the full OHLC history one tap away. */
export function StrataChart({ analysis, bars, price, live, selected, snapshot = false }: {
  analysis: Analysis; bars: Series; price: number; live: boolean; selected: Scenario | null; snapshot?: boolean;
}) {
  const [frame, setFrame] = useState<Horizon>("m15");
  const [full, setFull] = useState(false);
  const tf = OPTIONS.find((option) => option.key === frame)!;
  const series = useMemo(() => (bars[frame] ?? []).filter((bar) => Number.isFinite(bar.t)).slice(-150), [bars, frame]);
  const levels: ChartLevel[] = [];
  const add = (kind: ChartLevel["kind"], value: number | null, label: string) => {
    if (value !== null && Number.isFinite(value)) levels.push({ kind, price: value, label });
  };
  add("support", analysis.range.low, "Range low");
  add("resistance", analysis.range.high, "Range high");
  if (selected) {
    add("entry", selected.entry, "Entry");
    add("stop", selected.stop, "Stop");
    selected.targets.slice(0, 2).forEach((target, index) => add("target", target, "Target " + (index + 1)));
    if (selected.entry === null) {
      add(selected.side === "buy" ? "support" : "resistance", selected.level,
        selected.type === "break_retest" ? "Broken swing" : "Range edge");
    }
  }
  const chartLevels = levels.filter((l, i) => levels.findIndex((x) => x.price === l.price && x.kind === l.kind) === i);
  const validFocus = frame === "m15" && (bars.m15?.length ?? 0) >= 5;
  const direction = selected && selected.entry !== null && selected.stop !== null &&
    selected.targets.length ? selected.side : "neutral";
  return (
    <section className="strata-chart" aria-label="Gold price-action structure chart">
      <header className="strata-chart-head">
        <div><span className="strata-kicker">{snapshot ? "GENERATED SCENARIO · RECORDED SNAPSHOT" : "PRICE ACTION MAP"}</span>
          <h2>Gold market structure <small>XAU/USD</small></h2>
        </div>
        <div className="strata-timeframe" role="group" aria-label="Chart timeframe">
          {OPTIONS.map((o) => <button type="button" key={o.key} aria-pressed={frame === o.key}
            onClick={() => setFrame(o.key)}>{o.title}</button>)}
        </div>
      </header>
      <div className="strata-chart-facts">
        <span><i className="strata-fact-icon strata-fact-demand" />Demand {fmt(analysis.range.low)}</span>
        <span><i className="strata-fact-icon strata-fact-supply" />Supply {fmt(analysis.range.high)}</span>
        {selected && <span><i className="strata-fact-icon strata-fact-key" />{selected.type === "break_retest" ? "Retest" : "Reaction"} {fmt(selected.level)}</span>}
      </div>
      {!full && validFocus
        ? <SignalFocusChart bars={bars.m15} timeKnown tfMs={900000} tfLabel="15m"
            dec={2} price={price} priceLive={live} snapshot={snapshot} levels={chartLevels}
            zone={selected ? { low: selected.zone.low, high: selected.zone.high } : null}
            direction={direction} reference={selected?.stage !== "ready"}
            isOpenAt={goldOpen} viewKey={"strata:focus:" + (selected?.id ?? "none")}
            label="Five most recent confirmed gold candles and the conditional price-action scenario" />
        : <div className="strata-chart-canvas" data-no-i18n translate="no">
            {series.length >= 2 ?
              <OmChart bars={series} timeKnown tfMs={tf.ms} tfLabel={tf.title}
                dec={2} price={price} priceLive={live} snapshot={snapshot} levels={chartLevels}
                zone={selected ? { low: selected.zone.low, high: selected.zone.high } : null}
                isOpenAt={goldOpen} viewKey={"strata:full:" + frame} label={"Gold " + tf.title + " recorded candles with structure zones"} />
              : <p>Recorded candles are temporarily unavailable for {tf.title}.</p>}
          </div>}
      <footer className="strata-chart-foot">
        <span><ZoomIn size={14} aria-hidden="true" />
          {snapshot ? "Frozen setup snapshot · real recorded candles, not live execution" : full ? "Drag · pinch · scroll to inspect actual candles" : "Latest five enlarged candles · projected price scenario, not predicted time"}</span>
        <button type="button" onClick={() => setFull((value) => !value)}><Maximize2 size={14} aria-hidden="true" />
          {full ? "Focused view" : "Full chart"}</button>
      </footer>
    </section>
  );
}
