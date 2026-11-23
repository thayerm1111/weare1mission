"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { OmChart, type OmChartProps } from "@/components/om/chart/OmChart";
import { candleTimeText } from "@/lib/chart/candleTime";
import { priceText, type ChartLevel } from "@/lib/floor/chart";
import { signalFocusModel, type SignalDirection } from "@/lib/chart/signalFocus";
import "./signal-focus-chart.css";

export type SignalFocusChartProps = OmChartProps & { direction: SignalDirection; reference?: boolean };
const shortLabel = (level: ChartLevel) => {
  if (level.kind === "target") {
    const number = /target\s*(\d+)|tp\s*(\d+)/i.exec(level.label)?.slice(1).find(Boolean);
    return number ? `T${number}` : "Target";
  }
  return level.kind === "entry" ? "Entry" : level.kind === "stop" ? "Stop" : level.kind === "support" ? "Support" : "Resistance";
};

/** Five actual candles and the read's conditional plan. Opening history is a view change only. */
export function SignalFocusChart(p: SignalFocusChartProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const expanded = expandedKey === p.viewKey;
  const model = useMemo(() => signalFocusModel({ bars: p.bars, levels: p.levels, zone: p.zone, price: p.price,
    direction: p.direction, width }), [p.bars, p.levels, p.zone, p.price, p.direction, width]);
  const dec = Number.isInteger(p.dec) && p.dec >= 0 && p.dec <= 8 ? p.dec : 2;
  const hasQuote = typeof p.price === "number" && Number.isFinite(p.price);
  const format = (price: number) => priceText(price, dec);
  const direction = p.direction === "buy" ? "Buy" : p.direction === "sell" ? "Sell" : null;
  const historyId = `signal-history-${uid}`;
  const titleId = `signal-focus-${uid}`;
  const hasCandles = model.candles.length > 0;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => { const next = el.getBoundingClientRect().width; if (next > 0) setWidth(Math.round(next)); };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure); observer.observe(el);
    return () => observer.disconnect();
  }, [hasCandles]);

  if (!model.candles.length) return <p className="om-signal-focus-empty" role="status">Candle chart unavailable for this read.</p>;

  const { direction: _direction, reference: _reference, ...fullChart } = p;
  return (
    <section className="om-signal-focus" data-direction={p.direction} data-reference={p.reference || undefined} aria-labelledby={titleId}>
      <div className="om-signal-focus-heading">
        <h4 id={titleId}>{model.recent.length} latest {model.recent.length === 1 ? "candle" : "candles"}<span data-no-i18n translate="no">{p.tfLabel}</span></h4>
        <span className="om-signal-focus-state">{direction ? `${direction} ${p.reference ? "reference" : "setup"}` : "Market context"}</span>
      </div>
      <div ref={host} className="om-signal-focus-picture">
        <svg className="om-signal-focus-svg" width="100%" height={model.height} viewBox={`0 0 ${model.width} ${model.height}`}
          role="img" aria-label={`${p.label}. Latest ${model.recent.length} actual candles${model.scenario ? ` and a ${p.reference ? "reference " : ""}${direction?.toLowerCase()} projected scenario on a separate scale, without a time forecast` : " and recorded levels"}.`}>
          <defs><marker id={`signal-arrow-${uid}`} markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto" markerUnits="strokeWidth"><path d="M1 1L5.5 3.5L1 6" fill="none" className="om-signal-focus-arrow" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></marker></defs>
          {model.candleHigh !== null && <text className="om-signal-focus-extreme" x="12" y="17" data-no-i18n>{format(model.candleHigh)}</text>}
          {model.candleLow !== null && <text className="om-signal-focus-extreme" x="12" y={model.height - 8} data-no-i18n>{format(model.candleLow)}</text>}
          <line className="om-signal-focus-grid" x1="10" x2={model.divider - 12} y1={(model.top + model.bottom) / 2} y2={(model.top + model.bottom) / 2} />
          {model.candles.map((bar) => (
            <g key={bar.t} className="om-signal-focus-candle" data-up={bar.up} data-signal-candle={bar.t}>
              <title>{`${candleTimeText(bar.t, p.timeKnown, model.recent[model.recent.length - 1].t)}. Open ${format(bar.o)}, high ${format(bar.h)}, low ${format(bar.l)}, close ${format(bar.c)}.`}</title>
              <line x1={bar.x} x2={bar.x} y1={bar.highY} y2={bar.lowY} strokeWidth="1.6" />
              <rect x={bar.x - bar.bodyWidth / 2} y={bar.bodyY} width={bar.bodyWidth} height={bar.bodyHeight} rx="1.5" />
            </g>
          ))}
          {model.split && <>
            <line className="om-signal-focus-divider" x1={model.divider} x2={model.divider} y1="8" y2={model.height - 8} />
            <text className="om-signal-focus-lane" x={model.laneLeft} y="17">{model.scenario ? "Projected scenario" : "Recorded levels"}</text>
            {model.zone && <rect className="om-signal-focus-zone" x={model.laneLeft - 3} y={model.zone.y} width={model.laneRight - model.laneLeft + 6} height={model.zone.height} rx="2">
              <title>{`${p.reference ? "Reference entry zone" : "Entry zone"}: ${format(model.zone.low)} to ${format(model.zone.high)}.`}</title>
            </rect>}
            {model.marks.map((level, i) => (
              <g key={`${level.kind}:${level.price}:${i}`} className="om-signal-focus-level" data-kind={level.kind} data-level-price={level.price}>
                <line x1={model.laneLeft - 3} x2={model.laneRight + 2} y1={level.ly} y2={level.ly} />
                <path className="om-signal-focus-leader" d={`M${model.laneRight + 2} ${level.ly}L${model.laneRight + 6} ${level.labelY - 5}`} />
                <text className="om-signal-focus-level-name" x={model.laneRight + 9} y={level.labelY - 13}>{p.reference && ["entry", "stop", "target"].includes(level.kind) ? "Ref " : ""}{shortLabel(level)}</text>
                <text className="om-signal-focus-level-price" x={model.laneRight + 9} y={level.labelY} data-no-i18n>{format(level.price)}</text>
              </g>
            ))}
            {model.scenario && <g className="om-signal-focus-scenario" data-projected-scenario="true">
              <polyline points={model.scenario.map((point) => `${point.x},${point.y}`).join(" ")} markerEnd={`url(#signal-arrow-${uid})`} />
              {model.scenario.slice(0, -1).map((point, i) => <circle key={`${point.kind}:${i}`} cx={point.x} cy={point.y} r={point.kind === "entry" ? 3 : 2.2}>
                <title>{`${point.kind === "start" ? hasQuote ? "Price from this read" : "Latest candle close" : point.kind === "entry" ? p.reference ? "Reference entry" : "Entry" : "Target"}: ${format(point.price)}.`}</title>
              </circle>)}
            </g>}
          </>}
        </svg>
      </div>
      <p className="om-signal-focus-note">{model.scenario
        ? `${p.reference ? "Reference scenario · confirmation is still needed. " : "Projected scenario · "}Separate price scale; no timing is implied.`
        : "Actual candles and recorded levels from this read."}</p>
      <div className="om-signal-focus-controls">
        <span>{p.snapshot ? "Saved snapshot" : "Latest available candles"}</span>
        {model.history.length >= 2 && <button type="button" aria-expanded={expanded} aria-controls={historyId} onClick={() => setExpandedKey(expanded ? null : p.viewKey)}>
          {expanded ? "Close full chart" : "Full chart"}<svg aria-hidden="true" width="14" height="14" viewBox="0 0 20 20"><path d={expanded ? "M4 12l6-6 6 6" : "M4 8l6 6 6-6"} /></svg>
        </button>}
      </div>
      {expanded && <div id={historyId} className="om-signal-focus-history" role="region" aria-label="Full signal chart">
        <div className="om-signal-focus-full-canvas"><OmChart {...fullChart} bars={model.history} price={hasQuote ? p.price : null} /></div>
        <p>All {model.history.length} recorded candles · pan, zoom, or open full screen.</p>
      </div>}
    </section>
  );
}
