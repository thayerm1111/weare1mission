"use client";
import { H, fmt2 } from "./theme";

export type Pivot = { i: number; price: number; kind: "H" | "L"; tag: "HH" | "LH" | "HL" | "LL" | "H" | "L" };

/** Fractal pivots from the chart bars — a DISPLAY of structure, never fed to the engine. */
export function pivotsOf(bars: { h: number; l: number }[], k = 3, keep = 5): Pivot[] {
  const raw: { i: number; price: number; kind: "H" | "L" }[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let hi = true, lo = true;
    for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (bars[j].h >= bars[i].h) hi = false; if (bars[j].l <= bars[i].l) lo = false; }
    if (hi) raw.push({ i, price: bars[i].h, kind: "H" });
    if (lo) raw.push({ i, price: bars[i].l, kind: "L" });
  }
  // alternate H/L, keeping the extreme of any run
  const alt: typeof raw = [];
  for (const p of raw) {
    const last = alt[alt.length - 1];
    if (last && last.kind === p.kind) { if ((p.kind === "H" && p.price > last.price) || (p.kind === "L" && p.price < last.price)) alt[alt.length - 1] = p; }
    else alt.push(p);
  }
  const out: Pivot[] = [];
  let lastH: number | null = null, lastL: number | null = null;
  for (const p of alt) {
    let tag: Pivot["tag"] = p.kind;
    if (p.kind === "H") { if (lastH != null) tag = p.price > lastH ? "HH" : "LH"; lastH = p.price; }
    else { if (lastL != null) tag = p.price > lastL ? "HL" : "LL"; lastL = p.price; }
    out.push({ ...p, tag });
  }
  return out.slice(-keep);
}

const TAG_WORD: Record<Pivot["tag"], string> = { HH: "Higher High", LH: "Lower High", HL: "Higher Low", LL: "Lower Low", H: "Swing High", L: "Swing Low" };

export function StructureViz({ pivots, price, bearish }: { pivots: Pivot[]; price: number | null; bearish: boolean }) {
  const W = 190, Hh = 120, pad = 14;
  if (pivots.length < 2) return <div className="grid h-full place-items-center text-[11px]" style={{ color: H.mut }}>Not enough swings yet.</div>;
  const pts = [...pivots.map((p) => p.price), ...(price != null ? [price] : [])];
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const y = (p: number) => pad + ((hi - p) / (hi - lo || 1)) * (Hh - pad * 2);
  const n = pivots.length + (price != null ? 1 : 0);
  const x = (k: number) => pad + (k / (n - 1)) * (W - pad * 2);
  const seq = pivots.map((p, k) => [x(k), y(p.price)] as const);
  if (price != null) seq.push([x(n - 1), y(price)] as const);
  const d = seq.map((q, k) => `${k ? "L" : "M"}${q[0]},${q[1]}`).join(" ");
  const tone = bearish ? H.red : H.green;
  const top = pivots.reduce((a, b) => (b.price > a.price ? b : a), pivots[0]);
  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
      {/* wireframe mesh */}
      {seq.map((q, k) => seq.slice(k + 1, k + 3).map((r, j) => (
        <line key={`${k}-${j}`} x1={q[0]} y1={q[1]} x2={r[0]} y2={r[1]} stroke="rgba(89,175,255,0.18)" strokeWidth={0.6} />
      )))}
      {seq.map((q, k) => <line key={`g${k}`} x1={q[0]} y1={q[1]} x2={q[0]} y2={Hh - 4} stroke="rgba(89,175,255,0.08)" strokeWidth={0.6} />)}
      <path d={d} fill="none" stroke="#9FC9EE" strokeWidth={1.3} />
      {price != null && <path d={`M${seq[seq.length - 2][0]},${seq[seq.length - 2][1]} L${seq[seq.length - 1][0]},${seq[seq.length - 1][1]}`} stroke={tone} strokeWidth={1.8} fill="none" />}
      {pivots.map((p, k) => (
        <g key={k}>
          <circle cx={x(k)} cy={y(p.price)} r={2.2} fill={p.kind === "H" ? H.red : H.green} />
          <text x={x(k)} y={y(p.price) + (p.kind === "H" ? -5 - (k % 2) * 7 : 11 + (k % 2) * 7)} textAnchor="middle" fontSize="7" fill={H.text}>{TAG_WORD[p.tag]}</text>
          {p === top && <text x={x(k)} y={y(p.price) - 13} textAnchor="middle" fontSize="7" fill={H.red}>{fmt2(p.price)}</text>}
        </g>
      ))}
    </svg>
  );
}
