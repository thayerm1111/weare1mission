"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { H } from "./theme";
import type { Annotation, ExplainState, ShownAnnotation } from "../../../../command-center/core/explain";
import { movedSince } from "../../../../command-center/core/explain";
import type { ChartTf } from "../../../../command-center/core/atlasContract";
import type { UserLine } from "./explainBus";

/**
 * WHAT ATLAS IS POINTING AT, DRAWN.
 *
 * The chart's own scales place every annotation at its real price and its real candle; this file only decides
 * how each kind looks. An annotation in the segment being spoken is EMPHASISED (brighter, softly lit, a slow
 * pulse); the rest are at rest (thin, dashed, dim) so the chart stays readable while the evidence stays.
 *
 * Kinds: a level (a line at its price, tagged on the axis), a zone (a soft band), a candle or a run of
 * candles (a light column with a pointer over it), a swing (a diamond on the candle that made it), the
 * current candle (a ring), and the distance from price to a watched level (a live read-out that moves with
 * the quote). A candle or swing on a timeframe the chart is not showing is never guessed onto this one — the
 * chart lists it as a note instead.
 *
 * Motion is one slow opacity pulse on the emphasised line and nothing else, and it is switched off entirely
 * for anyone who asks for reduced motion (HUD_CSS).
 */

const VIOLET = "#B69CFF";
const roleColor = (a: Annotation): string =>
  a.kind !== "level" ? H.cyan2
  : a.role === "invalidation" || a.role === "stop" ? H.red
  : a.role === "trigger" || a.role === "watch" || a.role === "entry" ? H.gold3
  : a.role === "support" || a.role === "target" ? H.green
  : a.role === "resistance" ? "#F2A3AB"
  : H.cyan2;

const fmt2 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export type LayerProps = {
  shown: ShownAnnotation[];
  bars: { t: number; o: number; h: number; l: number; c: number; live?: boolean }[];
  tf: ChartTf | undefined;
  x: (i: number) => number;
  y: (p: number) => number;
  plotW: number;
  priceH: number;
  axis: number;
  bw: number;
  lastPx: number | null;
  compact: boolean;
  /** Pixels at the top that belong to the OHLC read-out: labels stay out of them. */
  top: number;
  picked: string | null;
  onPick: (id: string, at: { x: number; y: number }) => void;
  noPan: (e: ReactPointerEvent) => void;
  /** The conditional scenario drawn beside these, if any: its own labels sit above its trigger and below its
      invalidation, so a level label on the same price takes the other side of the line. */
  scenario?: { trigger: number | null; invalidation: number | null } | null;
};

function indexOfT(bars: readonly { t: number }[], t: number): number {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].t === t) return mid; if (bars[mid].t < t) lo = mid + 1; else hi = mid - 1; }
  return -1;
}

/** Annotations that cannot be drawn on the displayed timeframe: said, never guessed at. */
export function annotationNotes(shown: ShownAnnotation[], tf: ChartTf | undefined): { id: string; tf: ChartTf; text: string }[] {
  const out: { id: string; tf: ChartTf; text: string }[] = [];
  for (const { ann: a } of shown) {
    if ((a.kind === "candle" || a.kind === "candles" || a.kind === "swing") && tf && a.tf !== tf) out.push({ id: a.id, tf: a.tf, text: `ATLAS · ${a.label} — on the ${a.tf} chart` });
  }
  return out.slice(0, 3);
}

/** Every price the annotations stand on, so the chart's price fit can keep the discussed area in view. */
export function annotationPrices(shown: ShownAnnotation[]): number[] {
  const out: number[] = [];
  for (const { ann: a, active } of shown) {
    if (!active) continue;                                   // only what is being discussed moves the view
    if (a.kind === "level" || a.kind === "distance" || a.kind === "swing") out.push(a.price);
    else if (a.kind === "zone") out.push(a.from, a.to);
  }
  return out;
}

/** The newest emphasised annotation that sits on a candle of the displayed timeframe, as a bar index. */
export function focusIndex(shown: ShownAnnotation[], bars: readonly { t: number }[], tf: ChartTf | undefined): number | null {
  for (let k = shown.length - 1; k >= 0; k--) {
    const { ann: a, active } = shown[k];
    if (!active) continue;
    if ((a.kind === "candle" || a.kind === "swing") && a.tf === tf) { const i = indexOfT(bars, a.t); if (i >= 0) return i; }
    if (a.kind === "candles" && a.tf === tf) { const i = indexOfT(bars, a.from); if (i >= 0) return i; }
  }
  return null;
}

export function AnnotationLayer(p: LayerProps) {
  const { shown, bars, tf, x, y, plotW, priceH, axis, bw, lastPx, compact, top, picked, onPick, noPan, scenario } = p;
  const same = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 0.06;
  /** Levels whose distance from price is being read out: the read-out rides on the level's own label. */
  const measured = new Set(shown.filter((s) => s.ann.kind === "distance").map((s) => (s.ann as { price: number }).price.toFixed(2)));
  const levelPrices = new Set(shown.filter((s) => s.ann.kind === "level").map((s) => (s.ann as { price: number }).price.toFixed(2)));
  const fs = compact ? 8.5 : 9.5;
  const n = bars.length;
  // At rest first, emphasised last: what is being discussed is drawn on top.
  const order = [...shown].sort((a, b) => Number(a.active) - Number(b.active));
  const labelRows: number[] = [];
  /** Keep level labels off each other: nudge a label up or down until it has its own row. */
  const row = (want: number): number => {
    let yy = Math.max(top + 10, Math.min(priceH - 4, want));
    for (let g = 0; g < 8 && labelRows.some((r) => Math.abs(r - yy) < 11); g++) yy = yy - 11 < top + 10 ? yy + 11 : yy - 11;
    labelRows.push(yy);
    return yy;
  };
  const tap = (id: string, lx: number, ly: number) => ({
    onPointerDown: noPan,
    onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); onPick(id, { x: lx, y: ly }); },
    style: { cursor: "pointer" as const },
    pointerEvents: "auto" as const,
  });

  return (
    <g data-overlay="atlas-annotations">
      <defs>
        <linearGradient id="atlasBeam" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={H.cyan2} stopOpacity="0" /><stop offset="0.5" stopColor={H.cyan2} stopOpacity="0.16" /><stop offset="1" stopColor={H.cyan2} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="atlasColumn" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={H.gold3} stopOpacity="0.2" /><stop offset="1" stopColor={H.gold3} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {order.map(({ ann: a, active }) => {
        const col = roleColor(a);
        const cls = `atlas-ann ${active ? "atlas-emph" : "atlas-rest"}`;
        const sel = picked === a.id;

        if (a.kind === "level") {
          const yy = y(a.price);
          if (yy < 2 || yy > priceH - 1) return null;          // off the visible price range: the fit brings it in when it is being discussed
          // Above the line — unless the scenario's own "Trigger" label is already there.
          const ly = row(same(scenario?.trigger, a.price) ? yy + 12 : yy - 5);
          const pips = measured.has(a.price.toFixed(2)) && lastPx != null ? Math.round(Math.abs(a.price - lastPx) / 0.1) : null;
          const away = pips != null && pips > 0 ? ` · ${pips} pips ${a.price > (lastPx as number) ? "↑" : "↓"}` : "";
          const text = `◆ ${short(a.label, compact ? 20 : 38)}${away}`;
          return (
            <g key={a.id} className={cls} data-ann={a.id} data-ann-kind="level" data-active={active ? "1" : "0"} data-pips={pips ?? undefined}>
              {active && <rect x={0} y={yy - 9} width={plotW} height={18} fill="url(#atlasBeam)" pointerEvents="none" />}
              <line className="atlas-line" x1={0} x2={plotW} y1={yy} y2={yy} stroke={col} strokeWidth={active ? 1.8 : 1} strokeDasharray={active ? undefined : "5 4"}
                strokeOpacity={active ? 1 : 0.55} filter={active ? "url(#hudGlow)" : undefined} pointerEvents="none" />
              <rect x={plotW + 2} y={yy - 8} width={axis - 4} height={16} rx={2} fill={col} fillOpacity={active ? 1 : 0.7} pointerEvents="none" />
              <text x={plotW + axis / 2} y={yy + 4} textAnchor="middle" fontSize={compact ? 9 : 10} fontWeight={700} fill="#04080C" pointerEvents="none">{a.price.toFixed(2)}</text>
              <g {...tap(a.id, plotW - 8, ly)}>
                <text x={plotW - 6} y={ly} textAnchor="end" fontSize={fs} fontWeight={active ? 700 : 500} fill={col} fillOpacity={active ? 1 : 0.8}
                  stroke="rgba(3,7,11,0.9)" strokeWidth={3} paintOrder="stroke" textDecoration={sel ? "underline" : undefined}>{text}</text>
              </g>
            </g>
          );
        }

        if (a.kind === "zone") {
          const y1 = Math.max(0, y(Math.max(a.from, a.to))), y2 = Math.min(priceH, y(Math.min(a.from, a.to)));
          if (y2 <= 0 || y1 >= priceH || y2 - y1 < 1) return null;
          const h = Math.max(4, y2 - y1);
          return (
            <g key={a.id} className={cls} data-ann={a.id} data-ann-kind="zone" data-active={active ? "1" : "0"}>
              <rect className="atlas-line" x={0} y={y1} width={plotW} height={h} fill={H.cyan2} fillOpacity={active ? 0.13 : 0.06} pointerEvents="none" />
              <line x1={0} x2={plotW} y1={y1} y2={y1} stroke={H.cyan2} strokeOpacity={active ? 0.8 : 0.35} pointerEvents="none" />
              <line x1={0} x2={plotW} y1={y2} y2={y2} stroke={H.cyan2} strokeOpacity={active ? 0.8 : 0.35} pointerEvents="none" />
              <g {...tap(a.id, 12, Math.max(top + 12, y1 + 12))}>
                <text x={8} y={row(Math.max(top + 12, y1 + 12))} fontSize={fs} fontWeight={600} fill={H.cyan2} fillOpacity={active ? 1 : 0.75}
                  stroke="rgba(3,7,11,0.9)" strokeWidth={3} paintOrder="stroke">◆ Zone {short(a.label, compact ? 20 : 34)}</text>
              </g>
            </g>
          );
        }

        if (a.kind === "candle" || a.kind === "candles") {
          if (a.tf !== tf) return null;
          const i0 = indexOfT(bars, a.kind === "candle" ? a.t : a.from), i1 = a.kind === "candle" ? i0 : indexOfT(bars, a.to);
          if (i0 < 0 || i1 < 0) return null;
          const xa = Math.max(0, x(Math.min(i0, i1)) - bw / 2 - 1), xb = Math.min(plotW, x(Math.max(i0, i1)) + bw / 2 + 1);
          if (xb <= 0 || xa >= plotW) return null;
          let hi = -Infinity;
          for (let k = Math.min(i0, i1); k <= Math.max(i0, i1); k++) hi = Math.max(hi, bars[k].h);
          const cx = (xa + xb) / 2, py = Math.max(top + 16, y(hi) - 9);
          return (
            <g key={a.id} className={cls} data-ann={a.id} data-ann-kind={a.kind} data-active={active ? "1" : "0"}>
              <rect className="atlas-line" x={xa} y={0} width={Math.max(3, xb - xa)} height={priceH} fill="url(#atlasColumn)" opacity={active ? 1 : 0.45} pointerEvents="none" />
              {/* the pointer: a small arrowhead over the candle being discussed */}
              <path d={`M${cx - 5},${py - 7} L${cx + 5},${py - 7} L${cx},${py} Z`} fill={H.gold3} fillOpacity={active ? 1 : 0.55} pointerEvents="none" />
              <g {...tap(a.id, cx, py - 12)}>
                <text x={Math.max(40, Math.min(plotW - 40, cx))} y={Math.max(top + 9, py - 11)} textAnchor="middle" fontSize={fs} fontWeight={600} fill={H.gold3} fillOpacity={active ? 1 : 0.75}
                  stroke="rgba(3,7,11,0.9)" strokeWidth={3} paintOrder="stroke">{short(a.label, compact ? 22 : 38)}</text>
              </g>
            </g>
          );
        }

        if (a.kind === "swing") {
          if (a.tf !== tf) return null;
          const i = indexOfT(bars, a.t);
          if (i < 0) return null;
          const cx = x(i), cy = y(a.price);
          if (cx < 4 || cx > plotW - 4 || cy < 4 || cy > priceH - 4) return null;
          const up = a.type === "high";
          return (
            <g key={a.id} className={cls} data-ann={a.id} data-ann-kind="swing" data-active={active ? "1" : "0"}>
              <path className="atlas-line" d={`M${cx},${cy - 5} L${cx + 5},${cy} L${cx},${cy + 5} L${cx - 5},${cy} Z`} fill="none" stroke={H.gold3} strokeWidth={active ? 1.8 : 1.1} strokeOpacity={active ? 1 : 0.6}
                filter={active ? "url(#hudGlow)" : undefined} pointerEvents="none" />
              <g {...tap(a.id, cx, cy + (up ? -12 : 16))}>
                <text x={Math.max(48, Math.min(plotW - 48, cx))} y={Math.max(top + 9, Math.min(priceH - 3, cy + (up ? -10 : 17)))} textAnchor="middle" fontSize={fs} fontWeight={600}
                  fill={H.gold3} fillOpacity={active ? 1 : 0.75} stroke="rgba(3,7,11,0.9)" strokeWidth={3} paintOrder="stroke">{short(a.label, compact ? 22 : 36)}</text>
              </g>
            </g>
          );
        }

        if (a.kind === "current") {
          if (!n) return null;
          const b = bars[n - 1], cx = x(n - 1);
          if (cx < 0 || cx > plotW) return null;
          const yt = Math.max(2, y(b.h) - 4), yb = Math.min(priceH - 1, y(b.l) + 4);
          return (
            <g key={a.id} className={cls} data-ann={a.id} data-ann-kind="current" data-active={active ? "1" : "0"} pointerEvents="none">
              <rect className="atlas-line" x={cx - bw / 2 - 3} y={yt} width={bw + 6} height={Math.max(8, yb - yt)} rx={3} fill="none" stroke={H.gold3} strokeWidth={active ? 1.5 : 1} strokeOpacity={active ? 1 : 0.5} />
              <text x={Math.min(plotW - 4, cx + bw / 2 + 6)} y={Math.max(top + 9, yt - 3)} textAnchor="end" fontSize={fs} fontWeight={700} fill={H.gold3}
                stroke="rgba(3,7,11,0.9)" strokeWidth={3} paintOrder="stroke">{b.live ? "now · forming" : "latest candle"}</text>
            </g>
          );
        }

        if (a.kind === "distance") {
          if (lastPx == null || !n) return null;
          const y1 = Math.max(2, Math.min(priceH - 2, y(lastPx))), y2 = Math.max(2, Math.min(priceH - 2, y(a.price)));
          if (Math.abs(y1 - y2) < 6) return null;
          const cx = Math.min(plotW - 12, x(n - 1) + Math.max(bw, 10) + 8);
          const pips = Math.round(Math.abs(a.price - lastPx) / 0.1);
          const up = a.price > lastPx;
          const my = Math.max(top + 12, Math.min(priceH - 6, (y1 + y2) / 2 + 3));
          const label = `${pips} pips ${up ? "↑" : "↓"}`;
          const w = label.length * (compact ? 5 : 5.6) + 10;
          // The number rides on the level's own label when that level is drawn; alone, it gets its own badge.
          const onLabel = levelPrices.has(a.price.toFixed(2));
          return (
            <g key={a.id} className={cls} data-ann={a.id} data-ann-kind="distance" data-active={active ? "1" : "0"} data-pips={pips} pointerEvents="none">
              <line x1={cx} x2={cx} y1={y1} y2={y2} stroke={H.gold3} strokeDasharray="2 3" strokeOpacity={active ? 0.95 : 0.55} />
              <line x1={cx - 4} x2={cx + 4} y1={y1} y2={y1} stroke={H.gold3} strokeOpacity={active ? 1 : 0.6} />
              <line x1={cx - 4} x2={cx + 4} y1={y2} y2={y2} stroke={H.gold3} strokeOpacity={active ? 1 : 0.6} />
              {!onLabel && (
                <>
                  <rect x={Math.min(plotW - w - 2, cx - w / 2)} y={my - 10} width={w} height={14} rx={3} fill="rgba(3,7,11,0.92)" stroke={H.gold3} strokeOpacity={0.7} />
                  <text x={Math.min(plotW - w / 2 - 2, cx)} y={my} textAnchor="middle" fontSize={compact ? 8.5 : 9.5} fontWeight={700} fill={H.gold3}>{label}</text>
                </>
              )}
            </g>
          );
        }
        return null;   // a scenario is drawn by the chart's own scenario overlay
      })}
    </g>
  );
}

/** The member's own lines. A different colour, a different layer, never cleared with ATLAS's. */
export function UserLineLayer({ lines, y, plotW, priceH, axis, compact, noPan, onRemove }: {
  lines: UserLine[]; y: (p: number) => number; plotW: number; priceH: number; axis: number; compact: boolean;
  noPan: (e: ReactPointerEvent) => void; onRemove: (id: string) => void;
}) {
  return (
    <g data-overlay="user-drawings">
      {lines.map((l) => {
        const yy = y(l.price);
        if (yy < -10 || yy > priceH + 10) return null;
        return (
          <g key={l.id} data-user-line={l.id}>
            <line x1={0} x2={plotW} y1={yy} y2={yy} stroke={VIOLET} strokeWidth={1.2} strokeOpacity={0.9} pointerEvents="none" />
            <rect x={plotW + 2} y={yy - 8} width={axis - 4} height={16} rx={2} fill={VIOLET} pointerEvents="none" />
            <text x={plotW + axis / 2} y={yy + 4} textAnchor="middle" fontSize={compact ? 9 : 10} fontWeight={700} fill="#04080C" pointerEvents="none">{l.price.toFixed(2)}</text>
            <g onPointerDown={noPan} onClick={(e) => { e.stopPropagation(); onRemove(l.id); }} style={{ cursor: "pointer" }} pointerEvents="auto">
              <title>Your line — tap to remove</title>
              <text x={8} y={yy - 4} fontSize={compact ? 8.5 : 9.5} fontWeight={600} fill={VIOLET} stroke="rgba(3,7,11,0.9)" strokeWidth={3} paintOrder="stroke">✎ Your line ✕</text>
            </g>
          </g>
        );
      })}
    </g>
  );
}

/**
 * "ATLAS IS EXPLAINING" — one compact line, placed like a subtitle under the price pane so it never covers the
 * candles: which part of the answer the chart is showing, and — only when gold has moved since the answer was
 * built — by how much. The briefing's own time is on hover.
 */
export function ExplainCaption({ ex, price, top, compact, onStop }: { ex: ExplainState; price: number | null; top: number; compact: boolean; onStop: () => void }) {
  const e = ex.explanation;
  if (!e) return null;
  const explaining = ex.status === "explaining", showing = ex.status === "showing", corrected = ex.status === "corrected" && !!ex.correction;
  if (!explaining && !showing && !corrected) return null;
  const seg = e.segments[ex.segment] ?? null;
  const moved = movedSince(e, price);
  const stamp = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const col = corrected ? H.gold3 : H.cyan2;
  const since = !corrected && moved != null && Math.abs(moved) >= 3 ? `gold ${moved > 0 ? "+" : ""}${moved} pips since` : null;
  return (
    <div className="pointer-events-none absolute left-1/2 z-20 flex max-w-[calc(100%-12px)] -translate-x-1/2 justify-center" style={{ top }} data-explain-caption={ex.status} role="status" aria-live="polite">
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-[7px] px-2 py-[3px]" title={`Briefing built at ${stamp}`}
        style={{ background: "rgba(3,7,11,0.93)", border: `1px solid ${col}77`, boxShadow: `0 0 12px ${col}22` }}>
        <span className="flex shrink-0 items-end gap-[2px]" aria-hidden>
          {[0, 1, 2].map((k) => <span key={k} className={explaining ? "atlas-eq" : ""} style={{ width: 2, height: explaining ? 9 : 4, background: col, borderRadius: 1, animationDelay: `${k * 0.18}s` }} />)}
        </span>
        <span className="shrink-0 text-[8.5px] font-bold uppercase tracking-[0.14em]" style={{ color: col }}>
          {corrected ? "Correction" : explaining ? (compact ? "ATLAS" : "ATLAS is explaining") : "Showing"}
        </span>
        <span className="min-w-0 truncate text-[10.5px]" style={{ color: H.text, maxWidth: compact ? 168 : 440 }} data-explain-text="">
          {corrected ? ex.correction : seg ? seg.text : "…"}
        </span>
        {since && <span className="hidden shrink-0 text-[9px] tabular-nums sm:inline" style={{ color: H.gold2 }} data-explain-moved="">{since}</span>}
        <button onClick={onStop} onPointerDown={(ev) => ev.stopPropagation()} aria-label={explaining ? "Stop the explanation" : "Dismiss"} data-explain-stop="" className="shrink-0 px-0.5 text-[11px] leading-none" style={{ color: H.mut }}>✕</button>
      </div>
    </div>
  );
}

/** Tap an ATLAS annotation: ask about it, or take it off the chart. */
export function AnnotationMenu({ ann, at, plotW, priceH, onAsk, onRemove, onClose }: {
  ann: Annotation; at: { x: number; y: number }; plotW: number; priceH: number;
  onAsk: (q: string) => void; onRemove: () => void; onClose: () => void;
}) {
  // "Why does 4,361.67 (read invalidation) matter right now?" — the price first: it is what ATLAS can look up.
  const what = ann.kind === "level" ? `${fmt2(ann.price)} (${ann.label.toLowerCase()})`
    : ann.kind === "zone" ? `the ${fmt2(ann.from)}–${fmt2(ann.to)} zone`
    : `the ${ann.label.toLowerCase()}`;
  const W = 214;
  const left = Math.max(6, Math.min(plotW - W - 6, at.x - W + 20));
  const topPx = Math.max(6, Math.min(priceH - 104, at.y + 8));
  const btn = "block w-full rounded-[5px] px-2 py-1.5 text-left text-[11px] transition hover:brightness-125";
  return (
    <div className="absolute z-30 rounded-[8px] p-1.5" style={{ left, top: topPx, width: W, background: "rgba(5,11,17,0.97)", border: `1px solid ${H.lineHi}`, boxShadow: "0 10px 30px rgba(0,0,0,0.6)" }}
      onPointerDown={(e) => e.stopPropagation()} data-ann-menu={ann.id}>
      <p className="truncate px-2 pb-1 pt-0.5 text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: H.cyan2 }}>ATLAS · {short(ann.label, 30)}</p>
      <button className={btn} style={{ color: H.text }} onClick={() => { onAsk(`Why does ${what} matter right now?`); onClose(); }}>Why does this matter?</button>
      {(ann.kind === "level" || ann.kind === "zone") && (
        <button className={btn} style={{ color: H.text }} onClick={() => { onAsk(`What happens if ${what} breaks?`); onClose(); }}>What happens if this breaks?</button>
      )}
      <button className={btn} style={{ color: H.mut }} onClick={() => { onRemove(); onClose(); }}>Remove from the chart</button>
    </div>
  );
}
