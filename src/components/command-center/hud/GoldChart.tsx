"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { H, fmt2 } from "./theme";

export type ChartBar = { t: number; o: number; h: number; l: number; c: number; v?: number };
export type ChartMarker = { at: number; price: number | null; label: string; tone: "up" | "down" | "gold" | "cold" };
export type ChartZone = { from: number; to: number; label: string; tone: "supply" | "demand" | "target" };
export type ChartLine = { price: number; label: string; color: string; dashed?: boolean; tag?: boolean };

/**
 * THE PRIMARY GOLD CHART — candles, activity, and Atlas's own overlays.
 *
 * Every overlay is something the engine produced: zones are its nearest levels above and below, markers
 * are its own perception events (structure breaks, reclaims, liquidity sweeps) placed at the bar they
 * fired on, lines are its watch / invalidation / trade levels, and the dashed path is the scenario
 * consistent with its current thesis — labelled as such, never as a forecast.
 *
 * NAVIGATION — the same gestures a broker terminal gives you:
 *   wheel / trackpad          zoom time in and out around the cursor
 *   drag on the chart         pan through time, and up and down through price
 *   wheel or drag on the axis stretch or squeeze the price scale
 *   pinch (touch)             zoom time
 *   double-click / Reset      back to the automatic fit that follows the last candle
 *
 * This is a VIEW control and nothing else. It reads the same bars the engine already sent, changes no
 * data, and reports nothing back — zooming the cockpit glass never touches the pilot.
 */
const MIN_BARS = 10;
const PHONE_BARS = 14;     // the default window on a phone-width chart       // never zoom past a handful of candles
const OVERSCROLL = 0.35;   // how far past the newest / oldest candle panning may run, as a fraction of the view
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

type Viewport = {
  /** Right-most visible bar index (float). Ignored while `follow` is on. */
  end: number;
  /** How many bars are visible. 0 means "auto: show everything the feed sent". */
  span: number;
  /** Stay pinned to the newest candle as bars arrive. */
  follow: boolean;
  /** Price-scale stretch. 1 = fit the visible candles. */
  pz: number;
  /** Vertical pan, in price units. */
  pOff: number;
};
const AUTO: Viewport = { end: 0, span: 0, follow: true, pz: 1, pOff: 0 };

export function GoldChart({ bars, price, markers, zones, lines, path, pathLabel, showOverlays, showLiquidity, tfLabel, activityLabel }: {
  bars: ChartBar[]; price: number | null; markers: ChartMarker[]; zones: ChartZone[]; lines: ChartLine[];
  path: number[] | null; pathLabel: string; showOverlays: boolean; showLiquidity: boolean; tfLabel: string; activityLabel: string;
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const [sz, setSz] = useState({ w: 900, h: 420 });
  const [hover, setHover] = useState<number | null>(null);
  const [hoverY, setHoverY] = useState<number | null>(null);
  const [vp, setVp] = useState<Viewport>(AUTO);

  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setSz({ w: Math.max(320, e.contentRect.width), h: Math.max(220, e.contentRect.height) }));
    ro.observe(el); return () => ro.disconnect();
  }, []);

  const compact = sz.w < 560;               // phones: fewer words, same information
  const AXIS = compact ? 50 : 58, TIME_H = 18, VOL_FR = compact ? 0.13 : 0.17, FUTURE = 0.16;
  const plotW = sz.w - AXIS;
  const priceH = (sz.h - TIME_H) * (1 - VOL_FR) - 6;
  const volTop = priceH + 8, volH = (sz.h - TIME_H) * VOL_FR - 6;

  const view = useMemo(() => {
    const n = bars.length;
    if (!n) return null;
    const futurePx = showOverlays && path && path.length > 1 ? plotW * FUTURE : plotW * 0.04;
    const usable = Math.max(40, plotW - futurePx);

    /* the time window */
    // PHONES START ZOOMED IN (owner 09-21: "default the chart to this zoomed in so it's showing the candles
    // more clearly … just change the starting point"): the automatic view on a small screen is the newest
    // PHONE_BARS candles, not the whole series. Same data; pinch / drag / Reset all work as before, and
    // Reset returns here.
    const autoSpan = compact ? Math.min(n, PHONE_BARS) : n;
    const span = clamp(vp.span > 0 ? vp.span : autoSpan, Math.min(MIN_BARS, n), n);
    const end = vp.follow ? n - 1 : clamp(vp.end, span - 1 - span * OVERSCROLL, n - 1 + span * OVERSCROLL);
    const iL = end - span + 1;
    const bw = usable / span;
    const x = (i: number) => (i - iL + 0.5) * bw;
    const i0 = Math.max(0, Math.floor(iL) - 1), i1 = Math.min(n - 1, Math.ceil(end) + 1);
    const seen = bars.slice(i0, i1 + 1);

    /* the price window — fitted to what is actually on screen, then stretched and shifted by the user */
    let lo = Infinity, hi = -Infinity;
    for (const b of seen) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = bars[n - 1].c - 1; hi = bars[n - 1].c + 1; }
    const ref = bars[n - 1].c, base = Math.max(hi - lo, 0.5);
    const extra = [...(showOverlays ? (path ?? []) : []), ...lines.map((l) => l.price), ...(showLiquidity ? zones.flatMap((z) => [z.from, z.to]) : [])]
      .filter((p) => Number.isFinite(p) && Math.abs(p - ref) < base * 0.9);
    for (const p of extra) { if (p < lo) lo = p; if (p > hi) hi = p; }
    const mid = (lo + hi) / 2, half = (Math.max(hi - lo, 0.5) / 2) * 1.07 / Math.max(0.05, vp.pz);
    const pLo = mid - half + vp.pOff, pHi = mid + half + vp.pOff;
    const y = (p: number) => ((pHi - p) / (pHi - pLo)) * priceH;

    const act = (b: ChartBar) => (b.v && b.v > 0 ? b.v : b.h - b.l);
    const vals = seen.map(act).sort((a, b) => a - b);
    const vmax = Math.max(1e-6, vals[Math.floor(vals.length * 0.9)] ?? 1);
    const step = niceStep((pHi - pLo) / 7);
    const ticks: number[] = []; for (let p = Math.ceil(pLo / step) * step; p <= pHi; p += step) ticks.push(+p.toFixed(2));
    const idxAt = (t: number) => { let best = -1, d = Infinity; bars.forEach((b, i) => { const dd = Math.abs(b.t - t); if (dd < d) { d = dd; best = i; } }); return best; };
    return { n, bw, iL, end, span, usable, futurePx, pLo, pHi, y, x, vmax, ticks, idxAt, i0, i1, seen, pricePerPx: (pHi - pLo) / Math.max(1, priceH) };
  }, [bars, plotW, priceH, path, lines, zones, showOverlays, showLiquidity, vp, compact]);

  /* Gesture maths reads this rather than a stale closure. */
  const st = useRef({ n: 0, bw: 1, iL: 0, end: 0, span: 0, usable: 1, plotW: 1, pricePerPx: 1 });
  if (view) st.current = { n: view.n, bw: view.bw, iL: view.iL, end: view.end, span: view.span, usable: view.usable, plotW, pricePerPx: view.pricePerPx };

  const reset = useCallback(() => setVp(AUTO), []);

  /* Wheel: over the plot it zooms time around the cursor, over the price axis it stretches price. */
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const s = st.current; if (!s.n) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (px > s.plotW) { setVp((v) => ({ ...v, pz: clamp(v.pz * Math.exp(-dy * 0.0018), 0.2, 30) })); return; }
      if (e.shiftKey) { setVp((v) => ({ ...v, pz: clamp(v.pz * Math.exp(-dy * 0.0018), 0.2, 30) })); return; }
      const anchor = s.iL + px / s.bw - 0.5;
      setVp((v) => {
        const cur = v.span > 0 ? v.span : s.span;
        const span = clamp(cur * Math.exp(dy * 0.0014), Math.min(MIN_BARS, s.n), s.n);
        const iL = anchor - (px / (s.usable / span) - 0.5);
        const end = iL + span - 1;
        return { ...v, span, end, follow: end >= s.n - 1.25 };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /* Drag to pan, two fingers to pinch, drag on the axis to stretch price. */
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; end: number; pOff: number; pz: number; axis: boolean; moved: boolean } | null>(null);
  const pinch = useRef<{ dist: number; span: number; anchor: number; px: number } | null>(null);

  const onDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = st.current; if (!s.n) return;
    const r = e.currentTarget.getBoundingClientRect();
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      const px = (a.x + b.x) / 2 - r.left;
      pinch.current = { dist: Math.max(1, Math.abs(a.x - b.x)), span: s.span, anchor: s.iL + px / s.bw - 0.5, px };
      drag.current = null;
      return;
    }
    const px = e.clientX - r.left;
    drag.current = { x: e.clientX, y: e.clientY, end: s.end, pOff: vp.pOff, pz: vp.pz, axis: px > s.plotW, moved: false };
  }, [vp.pOff, vp.pz]);

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = st.current; if (!s.n || !view) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch.current && pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      const dist = Math.max(1, Math.abs(a.x - b.x));
      const p = pinch.current;
      const span = clamp((p.span || s.n) * (p.dist / dist), Math.min(MIN_BARS, s.n), s.n);
      const iL = p.anchor - (p.px / (s.usable / span) - 0.5);
      const end = iL + span - 1;
      setVp((v) => ({ ...v, span, end, follow: end >= s.n - 1.25 }));
      return;
    }

    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 2) d.moved = true;
      if (d.axis) { setVp((v) => ({ ...v, pz: clamp(d.pz * Math.exp(-dy * 0.006), 0.2, 30) })); return; }
      const end = d.end - dx / s.bw;
      setVp((v) => ({ ...v, span: v.span > 0 ? v.span : s.span, end, follow: end >= s.n - 1.25, pOff: d.pOff + dy * s.pricePerPx }));
      return;
    }

    const px = e.clientX - r.left, py = e.clientY - r.top;
    const i = Math.round(view.iL + px / view.bw - 0.5);
    setHover(px <= plotW && i >= 0 && i < s.n ? i : null);
    setHoverY(py >= 0 && py <= priceH ? py : null);
  }, [view, plotW, priceH]);

  const onUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pts.current.delete(e.pointerId);
    if (pts.current.size < 2) pinch.current = null;
    if (pts.current.size === 0) drag.current = null;
  }, []);

  if (!view) {
    return <div ref={wrap} className="grid h-full w-full place-items-center text-[12px]" style={{ color: H.mut }}>Waiting for candles from the feed…</div>;
  }
  const { n, bw, y, x, vmax, ticks, idxAt, i0, i1, seen } = view;
  const last = bars[n - 1];
  const hb = hover != null && hover >= 0 && hover < n ? bars[hover] : last;
  const up = (b: ChartBar) => b.c >= b.o;
  const timeTicks = pickTimeTicks(bars, i0, i1, 6);
  const lastX = x(n - 1);
  const touched = vp.span > 0 || !vp.follow || vp.pz !== 1 || vp.pOff !== 0;
  const cw = Math.max(1, Math.min(bw * 0.62, 22));

  return (
    <div ref={wrap} className="relative h-full w-full select-none"
      style={{ touchAction: "none", cursor: drag.current?.moved ? "grabbing" : "crosshair" }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onPointerLeave={() => { setHover(null); setHoverY(null); }}
      onDoubleClick={reset}>
      {/* OHLC readout — one line, on a backing; on phones only the close and change until you touch a candle */}
      <div className="pointer-events-none absolute left-1.5 top-1 z-10 flex max-w-[calc(100%-70px)] items-center gap-2 overflow-hidden whitespace-nowrap rounded-[5px] px-1.5 py-[2px] tabular-nums"
        style={{ background: "rgba(3,7,11,0.72)", fontSize: compact ? 10 : 11 }}>
        <span className="font-semibold" style={{ color: H.text, fontSize: compact ? 10.5 : 13 }}>{tfLabel}</span>
        <span className="inline-block h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: H.green, boxShadow: `0 0 6px ${H.green}` }} />
        {(!compact || hover != null) && (["O", "H", "L"] as const).map((k) => (
          <span key={k} style={{ color: H.mut }}>{k} <b style={{ color: up(hb) ? H.green : H.red, fontWeight: 500 }}>{fmt2(k === "O" ? hb.o : k === "H" ? hb.h : hb.l)}</b></span>
        ))}
        <span style={{ color: H.mut }}>C <b style={{ color: up(hb) ? H.green : H.red, fontWeight: 500 }}>{fmt2(hb.c)}</b></span>
        <span style={{ color: up(hb) ? H.green : H.red }}>{hb.c - hb.o >= 0 ? "+" : ""}{(hb.c - hb.o).toFixed(2)}{compact ? "" : ` (${(((hb.c - hb.o) / hb.o) * 100).toFixed(2)}%)`}</span>
      </div>

      {/* view controls — only once the view has been moved off its automatic fit */}
      {touched && (
        <div className="absolute right-[54px] z-20 flex items-center gap-1 text-[10px]" style={{ top: compact ? 24 : 4 }}>
          <span className="rounded-[5px] px-1.5 py-[2px] tabular-nums" style={{ color: H.mut, border: `1px solid ${H.lineSoft}`, background: "rgba(3,7,11,0.72)" }}>
            {Math.round(view.span)} bars
          </span>
          <button onClick={reset} className="rounded-[5px] px-1.5 py-[2px] transition hover:opacity-80"
            style={{ color: H.gold3, border: "1px solid rgba(231,196,103,0.5)", background: "rgba(213,169,61,0.12)" }}>Reset</button>
        </div>
      )}

      <svg width={sz.w} height={sz.h} className="block">
        <defs>
          <linearGradient id="hudPath" x1="0" x2="1"><stop offset="0" stopColor="#A9D8FF" /><stop offset="1" stopColor={H.blue} /></linearGradient>
          <filter id="hudGlow"><feGaussianBlur stdDeviation="2.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <clipPath id="hudPlot"><rect x={0} y={0} width={plotW} height={priceH} /></clipPath>
          <clipPath id="hudVol"><rect x={0} y={volTop} width={plotW} height={Math.max(1, volH)} /></clipPath>
        </defs>

        {/* grid */}
        {ticks.map((p) => <line key={p} x1={0} x2={plotW} y1={y(p)} y2={y(p)} stroke="rgba(89,175,255,0.06)" />)}
        {timeTicks.map((tt) => <line key={tt.i} x1={x(tt.i)} x2={x(tt.i)} y1={0} y2={priceH} stroke="rgba(89,175,255,0.045)" />)}

        <g clipPath="url(#hudPlot)">
          {/* zones */}
          {showLiquidity && zones.map((z, k) => {
            const y1 = y(Math.max(z.from, z.to)), y2 = y(Math.min(z.from, z.to));
            const h = Math.max(6, y2 - y1);
            const col = z.tone === "supply" ? "255,83,100" : z.tone === "demand" ? "41,223,166" : "89,175,255";
            const x0 = Math.max(0, z.tone === "target" ? lastX - bw * 30 : lastX - bw * 70);
            return (
              <g key={k}>
                <rect x={x0} y={y1 - (h === 6 ? 3 : 0)} width={Math.max(8, plotW - x0 - 4)} height={h} fill={`rgba(${col},0.10)`} stroke={`rgba(${col},0.45)`} strokeWidth={0.8} />
                {!compact && <text x={x0 + 6} y={y1 + (h === 6 ? -5 : 12)} textAnchor="start" fontSize="10" fill={`rgba(${col},0.95)`}>{z.label}</text>}
              </g>
            );
          })}

          {/* candles */}
          {seen.map((b, k) => {
            const i = i0 + k;
            const col = up(b) ? H.green : H.red;
            const cx = x(i);
            const yo = y(b.o), yc = y(b.c);
            return (
              <g key={b.t}>
                <line x1={cx} x2={cx} y1={y(b.h)} y2={y(b.l)} stroke={col} strokeWidth={cw > 3 ? 1.1 : 1} opacity={0.9} />
                <rect x={cx - cw / 2} y={Math.min(yo, yc)} width={cw} height={Math.max(1, Math.abs(yc - yo))} fill={col} opacity={up(b) ? 0.95 : 0.9} />
              </g>
            );
          })}

          {/* markers — placed so their labels never sit on top of each other */}
          {showOverlays && (() => {
            const placed: { x: number; y: number; w: number }[] = [];
            return markers.slice(0, compact ? 3 : 6).map((m, k) => {
              const i = idxAt(m.at);
              if (i < i0 || i > i1) return null;
              const b = bars[i];
              const p = m.price ?? (m.tone === "down" ? b.h : b.l);
              const col = m.tone === "down" ? H.red : m.tone === "up" ? H.green : m.tone === "gold" ? H.gold2 : H.text;
              const above = m.tone !== "up";
              const w = m.label.length * 5.4;
              // Keep the label inside the plot and off the price axis, then walk it away from anything
              // already drawn until it has its own space. Labels are information, not decoration.
              const cx = Math.min(plotW - w / 2 - 6, Math.max(w / 2 + 4, x(i)));
              let yy = y(p) + (above ? -9 : 13);
              for (let guard = 0; guard < 8; guard++) {
                const clash = placed.some((q) => Math.abs(q.x - cx) < (q.w + w) / 2 + 4 && Math.abs(q.y - yy) < 11);
                if (!clash) break;
                yy += above ? -11 : 11;
              }
              yy = Math.max(12, Math.min(priceH - 4, yy));
              placed.push({ x: cx, y: yy, w });
              return (
                <g key={k} className="hud-in">
                  <line x1={x(i) - 18} x2={x(i) + 18} y1={y(p)} y2={y(p)} stroke={col} strokeDasharray="2 3" strokeOpacity={0.8} />
                  {Math.abs(yy - y(p)) > 16 && <line x1={cx} x2={x(i)} y1={yy + (above ? 3 : -7)} y2={y(p)} stroke={col} strokeOpacity={0.25} />}
                  <text x={cx} y={yy} textAnchor="middle" fontSize={compact ? 8.5 : 9.5} fontWeight={600} fill={col} stroke="rgba(3,7,11,0.85)" strokeWidth={3} paintOrder="stroke">{m.label}</text>
                </g>
              );
            });
          })()}

          {/* projected scenario path */}
          {showOverlays && path && path.length > 1 && (() => {
            const span = view.futurePx - 8;
            const pts2 = path.map((p, k) => [lastX + (k / (path.length - 1)) * span, y(p)] as const);
            const dd = pts2.map((q, k) => `${k ? "L" : "M"}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" ");
            const endp = pts2[pts2.length - 1];
            return (
              <g filter="url(#hudGlow)" className="hud-in">
                <path d={dd} fill="none" stroke="url(#hudPath)" strokeWidth={1.8} strokeDasharray="5 3" />
                <circle cx={endp[0]} cy={endp[1]} r={3} fill={H.blue} />
                <text x={Math.min(plotW - 4, endp[0])} y={endp[1] + (path[path.length - 1] < path[0] ? 16 : -8)} textAnchor="end" fontSize="9.5" fill="#A9D8FF">{pathLabel}</text>
              </g>
            );
          })()}
        </g>

        {/* horizontal lines — drawn over the candles, tagged on the axis. Tags and labels are pushed
            apart so two levels a dollar apart never print on top of each other. */}
        {(() => {
          const vis = lines.map((l, k) => ({ l, k, y: y(l.price) })).filter((o) => o.y >= -20 && o.y <= priceH + 20);
          const place = (ys: number[], gap: number) => {
            const order = ys.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
            const out = ys.slice();
            let last = -Infinity;
            for (const o of order) { const v = Math.max(o.v, last + gap); out[o.i] = v; last = v; }
            return out;
          };
          const pxY = price != null ? y(price) : null;
          // the live price tag owns its spot; line tags move around it
          const tagYs = place(vis.map((o) => (pxY != null && Math.abs(o.y - pxY) < 17 ? (o.y < pxY ? pxY - 17 : pxY + 17) : o.y)), 17);
          const labYs = place(vis.map((o) => (o.y < 26 ? o.y + 12 : o.y - 4)), 12);
          return vis.map((o, i) => {
            const { l } = o;
            return (
              <g key={o.k}>
                <line x1={0} x2={plotW} y1={o.y} y2={o.y} stroke={l.color} strokeDasharray={l.dashed === false ? undefined : "3 4"} strokeOpacity={0.75} />
                {l.tag !== false && (
                  <g>
                    <rect x={plotW + 2} y={tagYs[i] - 8} width={AXIS - 4} height={16} rx={2} fill={l.color} fillOpacity={0.9} />
                    <text x={plotW + AXIS / 2} y={tagYs[i] + 4} textAnchor="middle" fontSize={compact ? 9 : 10} fontWeight={600} fill="#04080C">{l.price.toFixed(2)}</text>
                  </g>
                )}
                <text x={6} y={labYs[i]} fontSize={compact ? 8.5 : 9.5} fill={l.color} fillOpacity={0.95} stroke="rgba(3,7,11,0.85)" strokeWidth={3} paintOrder="stroke">{l.label}</text>
              </g>
            );
          });
        })()}

        {/* last price */}
        {price != null && y(price) >= -10 && y(price) <= priceH + 10 && (
          <g>
            <line x1={0} x2={plotW} y1={y(price)} y2={y(price)} stroke={H.green} strokeOpacity={0.5} strokeDasharray="1 3" />
            <rect x={plotW + 2} y={y(price) - 9} width={AXIS - 4} height={18} rx={2} fill={H.green} />
            <text x={plotW + AXIS / 2} y={y(price) + 4} textAnchor="middle" fontSize={compact ? 9.5 : 10.5} fontWeight={700} fill="#04080C">{price.toFixed(2)}</text>
          </g>
        )}

        {/* price axis */}
        {ticks.filter((p) => {
          const ty = y(p);
          if (price != null && Math.abs(ty - y(price)) < 12) return false;
          return !lines.some((l) => l.tag !== false && Math.abs(ty - y(l.price)) < 11);
        }).map((p) => <text key={p} x={plotW + AXIS - 6} y={y(p) + 3} textAnchor="end" fontSize={compact ? 9 : 10} fill={H.mut}>{compact ? p.toFixed(0) : p.toFixed(2)}</text>)}

        {/* activity */}
        <text x={6} y={volTop + 10} fontSize={compact ? 8.5 : 10} fill={H.mut}>{compact ? "Activity" : activityLabel}</text>
        <g clipPath="url(#hudVol)">
          {seen.map((b, k) => {
            const i = i0 + k;
            const v = b.v && b.v > 0 ? b.v : b.h - b.l, hh = Math.max(2, Math.min(1, Math.sqrt(v / vmax)) * volH);
            return <rect key={`v${b.t}`} x={x(i) - cw / 2} y={volTop + volH - hh} width={cw} height={hh} fill={up(b) ? H.green : H.red} opacity={0.5} />;
          })}
        </g>

        {/* time axis */}
        {timeTicks.map((tt) => <text key={`t${tt.i}`} x={x(tt.i)} y={sz.h - 4} textAnchor="middle" fontSize="10" fill={H.mut}>{tt.label}</text>)}

        {/* crosshair — time, price, and the price the cursor sits on */}
        {hover != null && hover >= i0 && hover <= i1 && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={sz.h - TIME_H} stroke="rgba(240,244,247,0.25)" strokeDasharray="2 3" />
            <rect x={Math.max(0, Math.min(plotW - 58, x(hover) - 29))} y={sz.h - TIME_H} width={58} height={TIME_H - 2} rx={2} fill="rgba(12,22,33,0.95)" stroke={H.lineSoft} />
            <text x={Math.max(29, Math.min(plotW - 29, x(hover)))} y={sz.h - 5} textAnchor="middle" fontSize="9.5" fill={H.text}>
              {new Date(bars[hover].t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </text>
          </g>
        )}
        {hoverY != null && (
          <g pointerEvents="none">
            <line x1={0} x2={plotW} y1={hoverY} y2={hoverY} stroke="rgba(240,244,247,0.18)" strokeDasharray="2 3" />
            <rect x={plotW + 2} y={hoverY - 8} width={AXIS - 4} height={16} rx={2} fill="rgba(12,22,33,0.96)" stroke={H.lineSoft} />
            <text x={plotW + AXIS / 2} y={hoverY + 4} textAnchor="middle" fontSize="10" fill={H.text}>
              {(view.pHi - (hoverY / Math.max(1, priceH)) * (view.pHi - view.pLo)).toFixed(2)}
            </text>
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

/** Ticks across the visible window only, labelled by date when the window spans days. */
function pickTimeTicks(bars: ChartBar[], i0: number, i1: number, want: number): { i: number; label: string }[] {
  if (i1 - i0 < 2) return [];
  const span = bars[i1].t - bars[i0].t;
  const every = Math.max(1, Math.round((i1 - i0) / want));
  const out: { i: number; label: string }[] = [];
  for (let i = i0 + every; i < i1 - 1; i += every) {
    const d = new Date(bars[i].t);
    const label = span > 3 * 86_400_000
      ? d.toLocaleDateString([], { day: "2-digit", month: "short" })
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    out.push({ i, label });
  }
  return out;
}
