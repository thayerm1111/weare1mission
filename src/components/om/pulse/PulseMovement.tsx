import type { PulseComparison } from "@/lib/pulse/comparison";

export function PulseMovement({ series, scale }: { series: PulseComparison | null; scale: number }) {
  if (!series) return <span className="om-pulse-move om-label" aria-label="No matching hourly prices">—</span>;
  const values = series.changes, last = values[values.length - 1];
  const y = (v: number) => 14 - v / (scale || 1) * 11;
  const points = values.map((v,i) => (2 + i * 12) + "," + y(v)).join(" ");
  const label = (last > 0 ? "+" : "") + last.toFixed(2) + "%";
  return <span className="om-pulse-move" data-trend={last > 0 ? "up" : last < 0 ? "down" : "flat"} aria-label={label + " over six hours"}>
    <svg viewBox="0 0 76 28" aria-hidden="true"><path d="M2 14H74" stroke="currentColor" opacity=".26" strokeDasharray="2 3" />
      <polyline fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" points={points} />
      <circle cx="74" cy={y(last)} r="1.8" fill="currentColor" />
    </svg><small>{label}</small>
  </span>;
}
