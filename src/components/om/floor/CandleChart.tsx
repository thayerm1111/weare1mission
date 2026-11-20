"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { chartFrame, type ChartCandle, type ChartLevel } from "@/lib/floor/chart";

/**
 * THE FLOOR'S CHART — the market's own candles, drawn crisp, with nothing moving behind the figures.
 *
 * It draws only what it is given: candles from the market-data feed, the price that came with them, and
 * levels the engine actually produced. It invents no candle, smooths nothing, and animates nothing — a
 * new answer simply replaces the old one. All the arithmetic (the scale, the ticks, which levels fit) is
 * in src/lib/floor/chart.ts, where it is tested.
 *
 * TIME AXIS. The feed stamps candles in its own exchange's clock, not the member's, so a clock time under
 * a candle would be wrong for most people. The axis therefore says how long ago each mark was, measured
 * between the candles themselves — which is right in every time zone.
 */
const UP = "#87C6AF", DOWN = "#E099A1", GRID = "rgba(255,255,255,0.055)", AXIS = "#A9AFBB";
const LEVEL_COLOR: Record<ChartLevel["kind"], string> = {
  resistance: "rgba(244,245,247,0.62)", support: "rgba(244,245,247,0.62)",
  entry: "#B6C4FF", stop: "#E099A1", target: "#87C6AF",
};

export function CandleChart({ candles, price, dec, levels, zone, label }: {
  candles: ChartCandle[]; price: number | null; dec: number; levels: ChartLevel[];
  /** The entry zone, when the play is open to this member. */
  zone?: { low: number; high: number } | null;
  /** What the picture is, for a screen reader. */
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) }); };
    read();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const f = useMemo(() => (size ? chartFrame({ candles, price, levels, zone: zone ?? null, width: size.w, height: size.h, dec }) : null), [candles, price, levels, zone, size, dec]);

  return (
    <div ref={box} style={{ position: "absolute", inset: 0 }}>
      {f && (
        <svg role="img" aria-label={label} width={f.width} height={f.height} viewBox={`0 0 ${f.width} ${f.height}`} fontFamily="inherit">
          {/* frame */}
          {f.yTicks.map((t) => <line key={`h${t.value}`} x1={0} x2={f.plotW} y1={t.y} y2={t.y} stroke={GRID} strokeWidth="1" />)}
          {f.xTicks.map((t) => <line key={`v${t.i}`} x1={t.x} x2={t.x} y1={f.top} y2={f.bottom} stroke={GRID} strokeWidth="1" />)}
          <line x1={0} x2={f.plotW} y1={f.bottom} y2={f.bottom} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />

          {/* entry zone */}
          {f.zone && <rect x={0} y={f.zone.y} width={f.plotW} height={f.zone.h} fill="rgba(182,196,255,0.09)" />}

          {/* candles */}
          {f.bars.map((b) => (
            <g key={b.i}>
              <line x1={b.x} x2={b.x} y1={b.yHigh} y2={b.yLow} stroke={b.up ? UP : DOWN} strokeWidth="1" />
              <rect x={b.x - f.bodyW / 2} y={b.yTop} width={f.bodyW} height={b.bodyH} rx="0.6" fill={b.up ? UP : DOWN} />
            </g>
          ))}

          {/* levels the engine produced */}
          {f.levels.map((l) => (
            <g key={`${l.kind}${l.price}`}>
              <line x1={0} x2={f.plotW} y1={l.y} y2={l.y} stroke={LEVEL_COLOR[l.kind]} strokeWidth="1" strokeDasharray="4 4" />
              <text x={12} y={l.labelY} fill="#F4F5F7" fontSize="12.5" style={{ fontVariantNumeric: "tabular-nums", paintOrder: "stroke" }} stroke="#12131C" strokeWidth="4" strokeLinejoin="round">{l.text}</text>
            </g>
          ))}

          {/* price axis */}
          {f.yTicks.map((t) => (
            <text key={`p${t.value}`} x={f.plotW + f.axisPad} y={t.y + 4} fill={AXIS} fontSize="12.5" style={{ fontVariantNumeric: "tabular-nums" }}>{t.text}</text>
          ))}
          {f.last && (
            <g>
              <line x1={0} x2={f.plotW} y1={f.last.y} y2={f.last.y} stroke="rgba(135,198,175,0.35)" strokeWidth="1" strokeDasharray="1 4" />
              <rect x={f.plotW + f.axisPad - 8} y={f.last.y - 11} width={f.axisW - f.axisPad + 6} height={22} rx="6" fill={UP} />
              <text x={f.plotW + f.axisPad} y={f.last.y + 4.5} fill="#101116" fontSize="12.5" fontWeight="500" style={{ fontVariantNumeric: "tabular-nums" }}>{f.last.text}</text>
            </g>
          )}

          {/* time axis */}
          {f.xTicks.map((t) => (
            <text key={`t${t.i}`} x={t.x} y={f.height - 4} fill={AXIS} fontSize="12.5" textAnchor={t.anchor}>{t.text}</text>
          ))}
        </svg>
      )}
    </div>
  );
}
