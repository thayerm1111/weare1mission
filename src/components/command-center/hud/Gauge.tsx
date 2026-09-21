"use client";
import { H } from "./theme";

/**
 * A compact semicircle gauge with a segmented bar beneath — the reference's pressure / volatility
 * instruments. `value01` is where the needle sits (0–1). The displayed number is whatever the caller
 * passes; the gauge never invents one.
 */
export function Gauge({ title, display, sub, value01, color, empty = false }: {
  title: string; display: string; sub: string; value01: number | null; color: string; empty?: boolean;
}) {
  const v = value01 == null ? 0 : Math.max(0, Math.min(1, value01));
  const R = 34, cx = 44, cy = 42, len = Math.PI * R;
  const segs = 10, lit = Math.round(v * segs);
  return (
    <div className="flex h-full min-w-0 flex-col items-center justify-between rounded-[8px] px-2 pb-2 pt-2"
      style={{ background: "linear-gradient(180deg,#0A1520,#07101A)", border: `1px solid ${H.line}` }}>
      <p className="w-full truncate text-center text-[9.5px] font-bold uppercase tracking-[0.13em]" style={{ color: H.text }}>{title}</p>
      <div className="relative" style={{ width: 88, height: 50 }}>
        <svg width="88" height="50" viewBox="0 0 88 50" aria-hidden>
          <path d={`M ${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}`} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" strokeLinecap="round" />
          <path d={`M ${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}`} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
            strokeDasharray={`${len}`} strokeDashoffset={`${len * (1 - v)}`}
            style={{ transition: "stroke-dashoffset .8s cubic-bezier(.22,.9,.24,1)", filter: `drop-shadow(0 0 5px ${color})`, opacity: empty ? 0.25 : 1 }} />
        </svg>
        <p className="absolute inset-x-0 bottom-0 text-center text-[17px] font-bold tabular-nums leading-none" style={{ color: H.text }}>{display}</p>
      </div>
      <p className="text-[10px] font-semibold" style={{ color }}>{sub}</p>
      <div className="flex w-full max-w-[96px] gap-[2px]">
        {Array.from({ length: segs }, (_, i) => (
          <span key={i} className="h-[4px] flex-1 rounded-[1px]" style={{ background: i < lit ? color : "rgba(255,255,255,0.07)", opacity: i < lit ? 0.4 + (i / segs) * 0.6 : 1 }} />
        ))}
      </div>
    </div>
  );
}
