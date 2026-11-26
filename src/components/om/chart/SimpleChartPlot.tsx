import { candleTimeText, type TimedBar } from "@/lib/chart/candleTime";

/** A missing period or a scheduled break ends the stroke instead of implying a price move. */
export function priceRuns(bars: TimedBar[], first: number, last: number, interval: number, timeKnown: boolean, closed: ReadonlySet<number>) {
  const runs: number[][] = [];
  let run: number[] = [];
  for (let i = first; i <= last; i++) {
    if (closed.has(bars[i].t)) { run = []; continue; }
    if (!run.length || (timeKnown && bars[i].t - bars[i - 1].t > interval * 1.5)) {
      run = [];
      runs.push(run);
    }
    run.push(i);
  }
  return runs;
}

export function SimpleChartPlot({ bars, first, last, x, y, width, height, header, uid, tfMs, timeKnown, closed,
  selected, watch, markStart, decimals, left, right }: {
  bars: TimedBar[]; first: number; last: number; x: (index: number) => number; y: (price: number) => number;
  width: number; height: number; header: number; uid: string; tfMs: number; timeKnown: boolean; closed: ReadonlySet<number>;
  selected: number; watch: number | null; markStart: number; decimals: number; left: number; right: number;
}) {
  const runs = priceRuns(bars, first, last, tfMs, timeKnown, closed);
  const watchY = watch == null ? null : y(watch);
  const watchFits = watchY != null && watchY >= header + 10 && watchY <= height - 10;
  const watchLabel = watchFits ? "Watch" : watchY != null && watchY < header + 10 ? "Watch higher" : "Watch lower";
  const labelY = watchY == null ? header + 10 : Math.min(height - 10, Math.max(header + 10, watchY));
  const labelX = Math.max(3, markStart + 3);
  const labelWidth = watchFits ? 45 : 78;
  const inspected = selected >= left && selected <= right && !closed.has(bars[selected].t);
  const point = inspected ? selected : right === bars.length - 1 && !closed.has(bars[right].t) ? right : null;
  const fillId = "omch-fill-" + uid;
  const caption = (i: number) => candleTimeText(bars[i].t, true, bars[bars.length - 1].t);
  return <g className="om-ch-simple-plot">
    <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="var(--om-ai)" stopOpacity=".26"/>
      <stop offset="100%" stopColor="var(--om-ai)" stopOpacity=".015"/>
    </linearGradient></defs>
    <g clipPath={'url(#omch-plot-' + uid + ')'}>
      {[.3,.58,.86].map(fraction => <line key={fraction} className="om-ch-line-grid" x1="0" x2={width} y1={header + (height-header)*fraction} y2={header + (height-header)*fraction}/>)}
      {runs.map(indices => {
        const a = indices[0], b = indices[indices.length - 1];
        if (a === b) return <circle key={a} className="om-ch-line-dot" cx={x(a)} cy={y(bars[a].c)} r="2"/>;
        const run = indices.map((i, j) => (j ? "L" : "M") + x(i).toFixed(2) + " " + y(bars[i].c).toFixed(2)).join(" ");
        return <g key={a}>
          <path d={run + " L" + x(b) + " " + height + " L" + x(a) + " " + height + " Z"} fill={'url(#' + fillId + ')'}/>
          <path className="om-ch-simple-path" d={run} fill="none" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>
        </g>;
      })}
      {watch != null && labelX + labelWidth <= width && <g className="om-ch-line-watch">
        <title>Watch level {watch.toFixed(decimals)}</title>
        {watchFits && <line x1={markStart} x2={width} y1={labelY} y2={labelY} strokeDasharray="4 5"/>}
        <rect x={labelX} y={labelY - 9} width={labelWidth} height={18} rx={6}/>
        <text x={labelX + labelWidth / 2} y={labelY + 4} textAnchor="middle">{watchLabel}</text>
      </g>}
      {inspected && <line className="om-ch-line-cursor" x1={x(selected)} x2={x(selected)} y1={header} y2={height}/>}
      {point != null && <g className="om-ch-line-point"><circle cx={x(point)} cy={y(bars[point].c)} r="8" opacity=".16"/><circle cx={x(point)} cy={y(bars[point].c)} r="4"/></g>}
    </g>
    {timeKnown && <g className="om-ch-line-time"><text x="6" y={height + 16}>{caption(left)}</text>
      {right > left && <text textAnchor="end" x={width - 2} y={height + 16}>{caption(right)}</text>}</g>}
  </g>;
}
