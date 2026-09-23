"use client";
import { useMemo } from "react";

type Bar = { t: number; o: number; h: number; l: number; c: number };
type Pivot = { kind: "high" | "low"; price: number; t: number; confirmedAt: number };
export type MapOverlays = {
  range?: { support: number; resistance: number; invalidated: boolean; createdAt: number } | null;
  compression?: { hi: number; lo: number; createdAt: number; invalidated: boolean; breakout?: { side: string; barT: number } | null } | null;
  pivotsHigh?: Pivot[]; pivotsLow?: Pivot[];
  candidate?: { side: string; frozen: Record<string, number>; plannedStop: number; plannedTarget: number; invalidation: number; family: string } | null;
  position?: { side: string; entry: number; stop: number; target: number } | null;
  quote?: { bid: number; ask: number } | null;
};

const W = 920, H = 380, PAD = { l: 8, r: 64, t: 10, b: 22 };

/**
 * LIVE ENTRY MAP — broker-linked M1 candles (last N closed bars) with frozen boundaries, confirmed pivots
 * and the candidate/position levels. Pure SVG; no volume bars (tick activity is not centralized volume).
 */
export default function EntryMap({ bars, ov, title }: { bars: Bar[]; ov: MapOverlays; title: string }) {
  const view = useMemo(() => {
    const b = bars.slice(-160);
    if (!b.length) return null;
    const levels = [ov.range?.support, ov.range?.resistance, ov.compression?.hi, ov.compression?.lo, ov.candidate?.plannedStop, ov.candidate?.plannedTarget, ov.position?.stop, ov.position?.target, ov.quote?.bid, ov.quote?.ask].filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    let lo = Math.min(...b.map((x) => x.l), ...levels), hi = Math.max(...b.map((x) => x.h), ...levels);
    const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const x = (i: number) => PAD.l + (i + 0.5) * ((W - PAD.l - PAD.r) / b.length);
    const y = (p: number) => PAD.t + (hi - p) / (hi - lo) * (H - PAD.t - PAD.b);
    const cw = Math.max(1.5, (W - PAD.l - PAD.r) / b.length * 0.62);
    const xt = (t: number) => { const i = b.findIndex((x) => x.t >= t); return i < 0 ? W - PAD.r : x(i); };
    return { b, lo, hi, x, y, cw, xt };
  }, [bars, ov]);
  if (!view) return <div className="h-[380px] grid place-items-center text-sm text-charcoal/60">Waiting for broker candles…</div>;
  const { b, lo, hi, x, y, cw, xt } = view;
  const ticks = 5; const grid = Array.from({ length: ticks + 1 }, (_, i) => lo + (hi - lo) * (i / ticks));
  const Level = ({ p, label, color, dash, from }: { p: number; label: string; color: string; dash?: string; from?: number }) => (
    <g>
      <line x1={from != null ? xt(from) : PAD.l} x2={W - PAD.r} y1={y(p)} y2={y(p)} stroke={color} strokeWidth={1.2} strokeDasharray={dash} />
      <rect x={W - PAD.r + 2} y={y(p) - 8} width={PAD.r - 4} height={16} rx={3} fill={color} />
      <text x={W - PAD.r + 6} y={y(p) + 4} fontSize={10} fill="#fff" fontFamily="ui-monospace, monospace">{label} {p.toFixed(2)}</text>
    </g>
  );
  const gold = "#B8860B", blue = "#3B6EA8", red = "#B4443C", green = "#2E7D5B", ink = "#0F1A2B";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img" aria-label={title}>
      {grid.map((g, i) => <g key={i}><line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="#E6E1D6" strokeWidth={1} /><text x={W - PAD.r + 6} y={y(g) + 3} fontSize={9} fill="#7A7468" fontFamily="ui-monospace, monospace">{g.toFixed(1)}</text></g>)}
      {ov.range && !ov.range.invalidated && <rect x={xt(ov.range.createdAt)} y={y(ov.range.resistance)} width={W - PAD.r - xt(ov.range.createdAt)} height={Math.max(1, y(ov.range.support) - y(ov.range.resistance))} fill={blue} opacity={0.07} />}
      {ov.compression && !ov.compression.invalidated && <rect x={xt(ov.compression.createdAt) - 6 * cw} y={y(ov.compression.hi)} width={W - PAD.r - xt(ov.compression.createdAt) + 6 * cw} height={Math.max(1, y(ov.compression.lo) - y(ov.compression.hi))} fill={gold} opacity={0.12} stroke={gold} strokeDasharray="3 3" />}
      {b.map((k, i) => { const up = k.c >= k.o; const col = up ? green : red; return (
        <g key={k.t}>
          <line x1={x(i)} x2={x(i)} y1={y(k.h)} y2={y(k.l)} stroke={col} strokeWidth={1} />
          <rect x={x(i) - cw / 2} y={y(Math.max(k.o, k.c))} width={cw} height={Math.max(1, Math.abs(y(k.o) - y(k.c)))} fill={up ? "#fff" : col} stroke={col} strokeWidth={1} />
        </g>); })}
      {(ov.pivotsHigh ?? []).map((p, i) => <g key={`ph${i}`}><circle cx={xt(p.t)} cy={y(p.price) - 6} r={3} fill={ink} /><line x1={xt(p.t)} x2={xt(p.confirmedAt)} y1={y(p.price) - 6} y2={y(p.price) - 6} stroke={ink} strokeWidth={0.8} strokeDasharray="1 2" /></g>)}
      {(ov.pivotsLow ?? []).map((p, i) => <g key={`pl${i}`}><circle cx={xt(p.t)} cy={y(p.price) + 6} r={3} fill={ink} /><line x1={xt(p.t)} x2={xt(p.confirmedAt)} y1={y(p.price) + 6} y2={y(p.price) + 6} stroke={ink} strokeWidth={0.8} strokeDasharray="1 2" /></g>)}
      {ov.range && !ov.range.invalidated && <><Level p={ov.range.resistance} label="R" color={blue} from={ov.range.createdAt} /><Level p={ov.range.support} label="S" color={blue} from={ov.range.createdAt} /></>}
      {ov.candidate && <>
        <Level p={ov.candidate.frozen.entryRef ?? ov.candidate.frozen.level} label="ENTRY" color={gold} />
        <Level p={ov.candidate.plannedStop} label="STOP" color={red} dash="4 3" />
        <Level p={ov.candidate.plannedTarget} label="TARGET" color={green} dash="4 3" />
        <Level p={ov.candidate.invalidation} label="INVAL" color="#7A7468" dash="2 2" />
      </>}
      {ov.position && <>
        <Level p={ov.position.entry} label={ov.position.side === "buy" ? "LONG" : "SHORT"} color={gold} />
        <Level p={ov.position.stop} label="STOP" color={red} />
        <Level p={ov.position.target} label="TARGET" color={green} />
      </>}
      {ov.quote && <g><line x1={PAD.l} x2={W - PAD.r} y1={y(ov.quote.bid)} y2={y(ov.quote.bid)} stroke={ink} strokeWidth={0.6} opacity={0.5} /><text x={W - PAD.r - 4} y={y(ov.quote.bid) - 3} fontSize={9} textAnchor="end" fill={ink} fontFamily="ui-monospace, monospace">bid {ov.quote.bid.toFixed(2)} / ask {ov.quote.ask.toFixed(2)}</text></g>}
      {b.filter((_, i) => i % 30 === 0).map((k, i) => <text key={`t${i}`} x={x(b.indexOf(k))} y={H - 6} fontSize={9} textAnchor="middle" fill="#7A7468" fontFamily="ui-monospace, monospace">{new Date(k.t).toISOString().slice(11, 16)}</text>)}
    </svg>
  );
}
