"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartPoint } from "@/lib/cashtrap/chart";
import type { Zone } from "@/lib/cashtrap/zones";
import type { SignalRecord } from "@/lib/cashtrap/signals";
import type { DmiStatus } from "@/lib/cashtrap/dmi";
import { C, fmt1, fmtPx, localTime } from "./theme";

/**
 * The selected market: candles with Bollinger Bands and support/resistance zones, then RSI(4) with its
 * SMA(4) line, Stochastic %K, and the DMI-Stochastic with its B/S events — every value exactly as the
 * engine computed it for that candle. Markers: armed setups (hollow) and published signals (solid).
 */
type SetupRow = { id: string; direction: "BUY" | "SELL"; exhaustion_t: string; status: string; confirm_t: string | null };
const M5 = 300_000;
const LEFT = 6;
// Drawn at the container's own pixel width (1 unit = 1 px), so text stays legible on a phone.
const WIDE = { right: 74, h: 690, p: { price: { top: 10, h: 300 }, rsi: { top: 336, h: 92 }, stoch: { top: 454, h: 92 }, dmi: { top: 572, h: 92 } } };
const COMPACT = { right: 52, h: 520, p: { price: { top: 10, h: 224 }, rsi: { top: 256, h: 66 }, stoch: { top: 346, h: 66 }, dmi: { top: 436, h: 66 } } };

export function MarketChart({ points, zones, setups, signals, precision, dmi, now, highlightZoneIds }: { points: ChartPoint[]; zones: Zone[]; setups: SetupRow[]; signals: SignalRecord[]; precision: number; dmi: DmiStatus; now: number; highlightZoneIds?: string[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(1000);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setCw(Math.round(el.getBoundingClientRect().width) || 1000);
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const W = Math.max(320, cw);
  const L = W < 640 ? COMPACT : WIDE;
  const RIGHT = L.right, P = L.p, H = L.h;
  const n = points.length;
  const step = (W - LEFT - RIGHT) / Math.max(1, n);
  const x = (i: number) => LEFT + (i + 0.5) * step;
  const idxOf = useMemo(() => new Map(points.map((p, i) => [p.t, i])), [points]);
  const xOfTime = (t: number): number => {
    if (!n) return LEFT;
    const i = points.findIndex((p) => t >= p.t && t < p.t + M5);
    if (i >= 0) return x(i) - step / 2 + ((t - points[i].t) / M5) * step;
    return t < points[0].t ? LEFT : x(n - 1) + step / 2 + ((t - (points[n - 1].t + M5)) / M5) * step;
  };
  const { lo, hi } = useMemo(() => {
    const vals: number[] = [];
    for (const p of points) { vals.push(p.h, p.l); if (p.bbUpper != null) vals.push(p.bbUpper); if (p.bbLower != null) vals.push(p.bbLower); }
    if (!vals.length) return { lo: 0, hi: 1 };
    let a = Math.min(...vals), b = Math.max(...vals);
    for (const z of zones) if (z.upper >= a - (b - a) * 0.15 && z.lower <= b + (b - a) * 0.15) { a = Math.min(a, z.lower); b = Math.max(b, z.upper); }
    const pad = (b - a) * 0.06 || 1e-4;
    return { lo: a - pad, hi: b + pad };
  }, [points, zones]);
  const y = (px: number) => P.price.top + ((hi - px) / (hi - lo)) * P.price.h;
  const yIn = (panel: { top: number; h: number }) => (v: number) => panel.top + ((100 - v) / 100) * panel.h;
  const path = (vals: Array<number | null>, fy: (v: number) => number) => {
    let d = "", pen = false;
    vals.forEach((v, i) => { if (v == null || !Number.isFinite(v)) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${fy(v).toFixed(1)}`; pen = true; });
    return d;
  };
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !n) return;
    const vx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.floor((vx - LEFT) / step);
    setHover(i >= 0 && i < n ? i : null);
  };
  const hp = hover != null ? points[hover] : null;
  const last = n ? points[n - 1] : null;
  const maxTicks = Math.max(3, Math.min(8, Math.floor((W - LEFT - RIGHT) / 95)));
  const ticks = n ? points.map((p, i) => ({ p, i })).filter(({ i }) => i % Math.max(1, Math.ceil(n / maxTicks)) === 0 && x(i) > 30 && x(i) < W - RIGHT - 24) : [];
  const active = signals.filter((s) => s.status === "active" || (s.expiryAt != null && now - s.expiryAt < 10 * 60_000));
  // Labels only for the valid zones nearest the price (two each side, plus any manual or highlighted zone), never overlapping.
  const highlight = new Set(highlightZoneIds ?? []);
  const zoneLabels = useMemo(() => {
    if (!last) return [] as Array<{ id: string; y: number; text: string; color: string }>;
    const valid = zones.filter((z) => z.invalidatedAt == null);
    const perSide = W < 640 ? 1 : 2;
    const below = valid.filter((z) => z.center <= last.c).sort((a, b) => b.center - a.center).slice(0, perSide);
    const above = valid.filter((z) => z.center > last.c).sort((a, b) => a.center - b.center).slice(0, perSide);
    const chosen = new Map([...below, ...above, ...valid.filter((z) => z.origin === "manual" || highlight.has(z.id))].map((z) => [z.id, z]));
    const out: Array<{ id: string; y: number; text: string; color: string }> = [];
    for (const z of [...chosen.values()].sort((a, b) => b.upper - a.upper)) {
      const yy = y(z.upper) - 2;
      if (yy < P.price.top + 8 || out.some((o) => Math.abs(o.y - yy) < 10)) continue;
      out.push({ id: z.id, y: yy, text: `${z.origin === "manual" ? "manual " : ""}${z.kind} ${fmtPx(z.lower, precision)}–${fmtPx(z.upper, precision)}`, color: z.kind === "support" ? C.green : C.red });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones, last, lo, hi, highlightZoneIds, W]);
  const ry = yIn(P.rsi), sy = yIn(P.stoch), dy = yIn(P.dmi);

  return (
    <div ref={wrap} className="relative">
      {hp && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 rounded-lg border bg-white/95 px-2.5 py-1.5 text-[11px] shadow-sm" style={{ borderColor: C.line, color: C.ink }}>
          <p className="font-semibold">{localTime(hp.t)} candle</p>
          <p className="font-mono">O {fmtPx(hp.o, precision)} H {fmtPx(hp.h, precision)} L {fmtPx(hp.l, precision)} C {fmtPx(hp.c, precision)}</p>
          <p className="font-mono" style={{ color: C.muted }}>BB {fmtPx(hp.bbLower, precision)} / {fmtPx(hp.bbBasis, precision)} / {fmtPx(hp.bbUpper, precision)}</p>
          <p className="font-mono" style={{ color: C.muted }}>RSI {fmt1(hp.rsi)} · RSI-SMA {fmt1(hp.rsiMa)} · %K {fmt1(hp.stochK)} · DMI {fmt1(hp.dmiStoch)}{hp.dmiEvent ? ` (${hp.dmiEvent})` : ""}</p>
        </div>
      )}
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full select-none" role="img" aria-label="Price chart with Bollinger Bands, zones, RSI, Stochastic and DMI-Stochastic" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <rect x={0} y={0} width={W} height={H} fill="#FFFFFF" />
        {/* zones: broken ones faint and unlabelled (drawn only while they stood); valid ones banded */}
        {zones.map((z) => {
          const x0 = Math.max(LEFT, xOfTime(z.createdAt));
          const x1 = z.invalidatedAt != null ? Math.min(W - RIGHT, xOfTime(z.invalidatedAt)) : W - RIGHT;
          if (x1 <= x0) return null;
          const col = z.kind === "support" ? C.green : C.red;
          const broken = z.invalidatedAt != null;
          return <rect key={z.id} x={x0} y={y(z.upper)} width={x1 - x0} height={Math.max(1.5, y(z.lower) - y(z.upper))} fill={col} fillOpacity={broken ? 0.035 : highlight.has(z.id) ? 0.16 : 0.08} stroke={broken ? "none" : col} strokeOpacity={highlight.has(z.id) ? 0.6 : 0.3} strokeDasharray={z.origin === "manual" ? "0" : "3 3"} strokeWidth={0.8}><title>{`${z.origin} ${z.kind} ${fmtPx(z.lower, precision)}–${fmtPx(z.upper, precision)}${broken ? " (broken)" : ""}`}</title></rect>;
        })}
        {zoneLabels.map((l) => <text key={`zl-${l.id}`} x={W - RIGHT - 3} y={l.y} fontSize={9} textAnchor="end" fill={l.color} stroke="#FFFFFF" strokeWidth={3} strokeOpacity={0.85} paintOrder="stroke">{l.text}</text>)}
        {/* Bollinger Bands */}
        <path d={path(points.map((p) => p.bbUpper), y)} fill="none" stroke={C.blueLine} strokeWidth={1.2} />
        <path d={path(points.map((p) => p.bbLower), y)} fill="none" stroke={C.blueLine} strokeWidth={1.2} />
        <path d={path(points.map((p) => p.bbBasis), y)} fill="none" stroke={C.purple} strokeOpacity={0.45} strokeDasharray="4 3" strokeWidth={1} />
        {/* candles */}
        {points.map((p, i) => {
          const up = p.c >= p.o;
          const col = up ? C.green : C.red;
          const top = y(Math.max(p.o, p.c)), bot = y(Math.min(p.o, p.c));
          return (
            <g key={p.t}>
              <line x1={x(i)} x2={x(i)} y1={y(p.h)} y2={y(p.l)} stroke={col} strokeOpacity={0.75} strokeWidth={1} />
              <rect x={x(i) - step * 0.32} y={top} width={step * 0.64} height={Math.max(1, bot - top)} fill={up ? "#FFFFFF" : col} fillOpacity={up ? 1 : 0.85} stroke={col} strokeWidth={0.9} />
            </g>
          );
        })}
        {/* armed setups (hollow) and signals (solid) */}
        {setups.map((s) => {
          const i = idxOf.get(Date.parse(s.exhaustion_t));
          if (i == null) return null;
          const p = points[i], buy = s.direction === "BUY";
          const yy = buy ? y(p.l) + 10 : y(p.h) - 10;
          return <path key={s.id} d={buy ? `M${x(i)},${yy - 5} l5,8 h-10 z` : `M${x(i)},${yy + 5} l5,-8 h-10 z`} fill="none" stroke={C.purple} strokeWidth={1.2}><title>{`${s.direction} setup armed (${s.status}) — not a signal`}</title></path>;
        })}
        {signals.map((s) => {
          const i = idxOf.get(s.confirmationT);
          if (i == null) return null;
          const p = points[i], call = s.direction === "CALL";
          const yy = call ? y(p.l) + 22 : y(p.h) - 22;
          return (
            <g key={s.dedupeKey}>
              <path d={call ? `M${x(i)},${yy - 6} l6,10 h-12 z` : `M${x(i)},${yy + 6} l6,-10 h-12 z`} fill={call ? C.green : C.red} />
              <text x={x(i)} y={call ? yy + 15 : yy - 9} fontSize={9} textAnchor="middle" fill={call ? C.green : C.red} fontWeight={700}>{s.direction}</text>
            </g>
          );
        })}
        {active.map((s) => (
          <g key={`lines-${s.dedupeKey}`}>
            {s.referenceAt != null && <line x1={xOfTime(s.referenceAt)} x2={xOfTime(s.referenceAt)} y1={P.price.top} y2={P.price.top + P.price.h} stroke={C.blue} strokeDasharray="2 3" strokeWidth={1} />}
            {s.expiryAt != null && <line x1={xOfTime(s.expiryAt)} x2={xOfTime(s.expiryAt)} y1={P.price.top} y2={P.price.top + P.price.h} stroke={C.purple} strokeDasharray="5 3" strokeWidth={1} />}
            {s.referencePrice != null && <line x1={xOfTime(s.referenceAt ?? s.publishedAt)} x2={Math.min(W - RIGHT, xOfTime(s.expiryAt ?? s.publishedAt))} y1={y(s.referencePrice)} y2={y(s.referencePrice)} stroke={C.blue} strokeWidth={1} />}
          </g>
        ))}
        {/* price axis */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => { const v = hi - (hi - lo) * f; return <text key={f} x={W - RIGHT + 6} y={P.price.top + P.price.h * f + 3} fontSize={10} fill={C.faint}>{v.toFixed(precision)}</text>; })}
        {last && (
          <g>
            <line x1={LEFT} x2={W - RIGHT} y1={y(last.c)} y2={y(last.c)} stroke={C.ink} strokeOpacity={0.25} strokeDasharray="2 3" />
            <rect x={W - RIGHT + 2} y={y(last.c) - 8} width={RIGHT - 4} height={16} rx={4} fill={C.ink} />
            <text x={W - RIGHT + 6} y={y(last.c) + 4} fontSize={10} fill="#FFFFFF">{last.c.toFixed(precision)}</text>
          </g>
        )}
        {/* RSI */}
        <Panel label="RSI(4) · SMA(4)" top={P.rsi.top} h={P.rsi.h} levels={[80, 20]} W={W} RIGHT={RIGHT} />
        <path d={path(points.map((p) => p.rsiMa), ry)} fill="none" stroke={C.blueLine} strokeDasharray="3 2" strokeWidth={1.1} />
        <path d={path(points.map((p) => p.rsi), ry)} fill="none" stroke={C.purple} strokeWidth={1.4} />
        {/* Stochastic */}
        <Panel label="Stochastic 5/1/1 (%K = %D)" top={P.stoch.top} h={P.stoch.h} levels={[80, 50, 20]} W={W} RIGHT={RIGHT} />
        <path d={path(points.map((p) => p.stochK), sy)} fill="none" stroke={C.blue} strokeWidth={1.4} />
        {/* DMI-Stochastic */}
        <Panel label="DMI-Stochastic 10/3 · B ↑10 · S ↓90" top={P.dmi.top} h={P.dmi.h} levels={[90, 10]} W={W} RIGHT={RIGHT} />
        {dmi.available || points.some((p) => p.dmiStoch != null) ? (
          <>
            <path d={path(points.map((p) => p.dmiStoch), dy)} fill="none" stroke={C.ink} strokeOpacity={0.8} strokeWidth={1.3} />
            {points.map((p, i) => p.dmiEvent && (
              <text key={`d${p.t}`} x={x(i)} y={p.dmiEvent === "B" ? P.dmi.top + P.dmi.h - 3 : P.dmi.top + 10} fontSize={10} fontWeight={700} textAnchor="middle" fill={p.dmiEvent === "B" ? C.green : C.red}>{p.dmiEvent}</text>
            ))}
          </>
        ) : (
          <text x={(W - RIGHT) / 2} y={P.dmi.top + P.dmi.h / 2 + 4} fontSize={13} textAnchor="middle" fill={C.red}>DMI source required — confirmations unavailable</text>
        )}
        {/* time axis */}
        {ticks.map(({ p, i }) => <text key={`t${p.t}`} x={x(i)} y={H - 6} fontSize={10} textAnchor="middle" fill={C.faint}>{localTime(p.t)}</text>)}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={P.price.top} y2={P.dmi.top + P.dmi.h} stroke={C.ink} strokeOpacity={0.2} />}
      </svg>
    </div>
  );
}

function Panel({ label, top, h, levels, W, RIGHT }: { label: string; top: number; h: number; levels: number[]; W: number; RIGHT: number }) {
  return (
    <g>
      <rect x={LEFT} y={top} width={W - LEFT - RIGHT} height={h} fill="#FBFBFD" stroke={C.line} strokeWidth={0.8} />
      <text x={LEFT + 4} y={top - 5} fontSize={10} fill={C.muted}>{label}</text>
      {levels.map((v) => (
        <g key={v}>
          <line x1={LEFT} x2={W - RIGHT} y1={top + ((100 - v) / 100) * h} y2={top + ((100 - v) / 100) * h} stroke={C.faint} strokeOpacity={0.6} strokeDasharray="3 3" strokeWidth={0.8} />
          <text x={W - RIGHT + 6} y={top + ((100 - v) / 100) * h + 3} fontSize={10} fill={C.faint}>{v}</text>
        </g>
      ))}
    </g>
  );
}
