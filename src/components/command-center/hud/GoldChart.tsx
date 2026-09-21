"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { H, fmt2 } from "./theme";

export type ChartBar = { t: number; o: number; h: number; l: number; c: number; v?: number };
export type ChartMarker = { at: number; price: number | null; label: string; tone: "up" | "down" | "gold" | "cold" };
export type ChartZone = { from: number; to: number; label: string; tone: "supply" | "demand" | "target" };
export type ChartLine = { price: number; label: string; color: string; dashed?: boolean; tag?: boolean };

/**
 * THE PRIMARY GOLD CHART — candles, activity, and the Brain's own overlays.
 *
 * Every overlay is something the engine produced: zones are its nearest levels above and below, markers
 * are its own perception events (structure breaks, reclaims, liquidity sweeps) placed at the bar they
 * fired on, lines are its watch / invalidation / trade levels, and the dashed path is the scenario
 * consistent with its current thesis — labelled as such, never as a forecast.
 */
export function GoldChart({ bars, price, markers, zones, lines, path, pathLabel, showOverlays, showLiquidity, tfLabel, activityLabel }: {
  bars: ChartBar[]; price: number | null; markers: ChartMarker[]; zones: ChartZone[]; lines: ChartLine[];
  path: number[] | null; pathLabel: string; showOverlays: boolean; showLiquidity: boolean; tfLabel: string; activityLabel: string;
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const [sz, setSz] = useState({ w: 900, h: 420 });
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setSz({ w: Math.max(320, e.contentRect.width), h: Math.max(220, e.contentRect.height) }));
    ro.observe(el); return () => ro.disconnect();
  }, []);

  const AXIS = 58, TIME_H = 18, VOL_FR = 0.17, FUTURE = 0.16;
  const plotW = sz.w - AXIS;
  const priceH = (sz.h - TIME_H) * (1 - VOL_FR) - 6;
  const volTop = priceH + 8, volH = (sz.h - TIME_H) * VOL_FR - 6;

  const view = useMemo(() => {
    const n = bars.length;
    if (!n) return null;
    const futurePx = showOverlays && path && path.length > 1 ? plotW * FUTURE : plotW * 0.04;
    const bw = (plotW - futurePx) / n;
    let lo = Infinity, hi = -Infinity;
    for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    const extra = [...(showOverlays ? (path ?? []) : []), ...lines.map((l) => l.price), ...(showLiquidity ? zones.flatMap((z) => [z.from, z.to]) : [])]
      .filter((p) => Number.isFinite(p) && Math.abs(p - (bars[n - 1].c)) < (hi - lo) * 0.9);
    for (const p of extra) { if (p < lo) lo = p; if (p > hi) hi = p; }
    const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const y = (p: number) => ((hi - p) / (hi - lo)) * priceH;
    const x = (i: number) => i * bw + bw / 2;
    const act = (b: ChartBar) => (b.v && b.v > 0 ? b.v : b.h - b.l);
    const vals = bars.map(act).sort((a, b) => a - b);
    const vmax = Math.max(1e-6, vals[Math.floor(vals.length * 0.9)] ?? 1);
    const step = niceStep((hi - lo) / 7);
    const ticks: number[] = []; for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) ticks.push(+p.toFixed(2));
    const idxAt = (t: number) => { let best = -1, d = Infinity; bars.forEach((b, i) => { const dd = Math.abs(b.t - t); if (dd < d) { d = dd; best = i; } }); return best; };
    return { n, bw, lo, hi, y, x, vmax, ticks, idxAt, futurePx };
  }, [bars, plotW, priceH, path, lines, zones, showOverlays, showLiquidity]);

  if (!view) {
    return <div ref={wrap} className="grid h-full w-full place-items-center text-[12px]" style={{ color: H.mut }}>Waiting for candles from the feed…</div>;
  }
  const { n, bw, y, x, vmax, ticks, idxAt } = view;
  const last = bars[n - 1];
  const hb = hover != null ? bars[hover] : last;
  const up = (b: ChartBar) => b.c >= b.o;
  const timeTicks = pickTimeTicks(bars, 6);
  const lastX = x(n - 1);

  return (
    <div ref={wrap} className="relative h-full w-full select-none"
      onMouseMove={(e) => {
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const i = Math.floor((e.clientX - r.left) / bw);
        setHover(i >= 0 && i < n ? i : null);
      }}
      onMouseLeave={() => setHover(null)}>
      {/* OHLC readout */}
      <div className="pointer-events-none absolute left-2 top-1 z-10 flex items-center gap-3 text-[11px] tabular-nums">
        <span className="text-[13px] font-semibold" style={{ color: H.text }}>{tfLabel}</span>
        <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: H.green, boxShadow: `0 0 6px ${H.green}` }} />
        <span style={{ color: H.mut }}>O <b style={{ color: up(hb) ? H.green : H.red, fontWeight: 500 }}>{fmt2(hb.o)}</b></span>
        <span style={{ color: H.mut }}>H <b style={{ color: up(hb) ? H.green : H.red, fontWeight: 500 }}>{fmt2(hb.h)}</b></span>
        <span style={{ color: H.mut }}>L <b style={{ color: up(hb) ? H.green : H.red, fontWeight: 500 }}>{fmt2(hb.l)}</b></span>
        <span style={{ color: H.mut }}>C <b style={{ color: up(hb) ? H.green : H.red, fontWeight: 500 }}>{fmt2(hb.c)}</b></span>
        <span style={{ color: up(hb) ? H.green : H.red }}>{hb.c - hb.o >= 0 ? "+" : ""}{(hb.c - hb.o).toFixed(2)} ({(((hb.c - hb.o) / hb.o) * 100).toFixed(2)}%)</span>
      </div>

      <svg width={sz.w} height={sz.h} className="block">
        <defs>
          <linearGradient id="hudPath" x1="0" x2="1"><stop offset="0" stopColor="#A9D8FF" /><stop offset="1" stopColor={H.blue} /></linearGradient>
          <filter id="hudGlow"><feGaussianBlur stdDeviation="2.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>

        {/* grid */}
        {ticks.map((p) => <line key={p} x1={0} x2={plotW} y1={y(p)} y2={y(p)} stroke="rgba(89,175,255,0.06)" />)}
        {timeTicks.map((tt) => <line key={tt.i} x1={x(tt.i)} x2={x(tt.i)} y1={0} y2={priceH} stroke="rgba(89,175,255,0.045)" />)}

        {/* zones */}
        {showLiquidity && zones.map((z, k) => {
          const y1 = y(Math.max(z.from, z.to)), y2 = y(Math.min(z.from, z.to));
          const h = Math.max(6, y2 - y1);
          const col = z.tone === "supply" ? "255,83,100" : z.tone === "demand" ? "41,223,166" : "89,175,255";
          const x0 = z.tone === "target" ? lastX - bw * 30 : Math.max(0, lastX - bw * 70);
          return (
            <g key={k}>
              <rect x={x0} y={y1 - (h === 6 ? 3 : 0)} width={plotW - x0 - 4} height={h} fill={`rgba(${col},0.10)`} stroke={`rgba(${col},0.45)`} strokeWidth={0.8} />
              <text x={x0 + 6} y={y1 + (h === 6 ? -5 : 11)} textAnchor="start" fontSize="10" fill={`rgba(${col},0.95)`}>{z.label}</text>
            </g>
          );
        })}

        {/* horizontal lines */}
        {lines.map((l, k) => (
          <g key={k}>
            <line x1={0} x2={plotW} y1={y(l.price)} y2={y(l.price)} stroke={l.color} strokeDasharray={l.dashed === false ? undefined : "3 4"} strokeOpacity={0.75} />
            {l.tag !== false && (
              <g>
                <rect x={plotW + 2} y={y(l.price) - 8} width={AXIS - 4} height={16} rx={2} fill={l.color} fillOpacity={0.9} />
                <text x={plotW + AXIS / 2} y={y(l.price) + 4} textAnchor="middle" fontSize="10" fontWeight={600} fill="#04080C">{l.price.toFixed(2)}</text>
              </g>
            )}
            <text x={6} y={y(l.price) < 26 ? y(l.price) + 12 : y(l.price) - 4} fontSize="9.5" fill={l.color} fillOpacity={0.9}>{l.label}</text>
          </g>
        ))}

        {/* candles */}
        {bars.map((b, i) => {
          const col = up(b) ? H.green : H.red;
          const cx = x(i), w = Math.max(1, bw * 0.62);
          const yo = y(b.o), yc = y(b.c);
          return (
            <g key={b.t}>
              <line x1={cx} x2={cx} y1={y(b.h)} y2={y(b.l)} stroke={col} strokeWidth={1} opacity={0.9} />
              <rect x={cx - w / 2} y={Math.min(yo, yc)} width={w} height={Math.max(1, Math.abs(yc - yo))} fill={col} opacity={up(b) ? 0.95 : 0.9} />
            </g>
          );
        })}

        {/* markers */}
        {showOverlays && markers.slice(0, 6).map((m, k) => {
          const i = idxAt(m.at); if (i < 0) return null;
          const b = bars[i];
          const p = m.price ?? (m.tone === "down" ? b.h : b.l);
          const col = m.tone === "down" ? H.red : m.tone === "up" ? H.green : m.tone === "gold" ? H.gold2 : H.text;
          const above = m.tone !== "up";
          const yy = y(p) + (above ? -10 - (k % 3) * 11 : 14 + (k % 3) * 11);
          return (
            <g key={k} className="hud-in">
              <line x1={x(i) - 22} x2={x(i) + 22} y1={y(p)} y2={y(p)} stroke={col} strokeDasharray="2 3" strokeOpacity={0.8} />
              <text x={x(i)} y={yy} textAnchor="middle" fontSize="10" fontWeight={600} fill={col}>{m.label}</text>
            </g>
          );
        })}

        {/* projected scenario path */}
        {showOverlays && path && path.length > 1 && (() => {
          const span = view.futurePx - 8;
          const pts = path.map((p, k) => [lastX + (k / (path.length - 1)) * span, y(p)] as const);
          const d = pts.map((q, k) => `${k ? "L" : "M"}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" ");
          const endp = pts[pts.length - 1];
          return (
            <g filter="url(#hudGlow)" className="hud-in">
              <path d={d} fill="none" stroke="url(#hudPath)" strokeWidth={1.8} strokeDasharray="5 3" />
              <circle cx={endp[0]} cy={endp[1]} r={3} fill={H.blue} />
              <text x={Math.min(plotW - 4, endp[0])} y={endp[1] + (path[path.length - 1] < path[0] ? 16 : -8)} textAnchor="end" fontSize="9.5" fill="#A9D8FF">{pathLabel}</text>
            </g>
          );
        })()}

        {/* last price */}
        {price != null && (
          <g>
            <line x1={0} x2={plotW} y1={y(price)} y2={y(price)} stroke={H.green} strokeOpacity={0.5} strokeDasharray="1 3" />
            <rect x={plotW + 2} y={y(price) - 9} width={AXIS - 4} height={18} rx={2} fill={H.green} />
            <text x={plotW + AXIS / 2} y={y(price) + 4} textAnchor="middle" fontSize="10.5" fontWeight={700} fill="#04080C">{price.toFixed(2)}</text>
          </g>
        )}

        {/* price axis */}
        {ticks.map((p) => <text key={p} x={plotW + AXIS - 6} y={y(p) + 3} textAnchor="end" fontSize="10" fill={H.mut}>{p.toFixed(2)}</text>)}

        {/* activity */}
        <text x={6} y={volTop + 10} fontSize="10" fill={H.mut}>{activityLabel}</text>
        {bars.map((b, i) => {
          const v = b.v && b.v > 0 ? b.v : b.h - b.l, hh = Math.max(2, Math.min(1, Math.sqrt(v / vmax)) * volH);
          return <rect key={`v${b.t}`} x={x(i) - Math.max(1, bw * 0.62) / 2} y={volTop + volH - hh} width={Math.max(1, bw * 0.62)} height={hh} fill={up(b) ? H.green : H.red} opacity={0.5} />;
        })}

        {/* time axis */}
        {timeTicks.map((tt) => <text key={`t${tt.i}`} x={x(tt.i)} y={sz.h - 4} textAnchor="middle" fontSize="10" fill={H.mut}>{tt.label}</text>)}

        {/* hover crosshair */}
        {hover != null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={sz.h - TIME_H} stroke="rgba(240,244,247,0.25)" strokeDasharray="2 3" />
          </g>
        )}
      </svg>
    </div>
  );
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

function pickTimeTicks(bars: ChartBar[], want: number): { i: number; label: string }[] {
  if (bars.length < 2) return [];
  const span = bars[bars.length - 1].t - bars[0].t;
  const every = Math.max(1, Math.floor(bars.length / want));
  const out: { i: number; label: string }[] = [];
  for (let i = every; i < bars.length - 2; i += every) {
    const d = new Date(bars[i].t);
    const label = span > 3 * 86_400_000
      ? d.toLocaleDateString([], { day: "2-digit", month: "short" })
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    out.push({ i, label });
  }
  return out;
}
