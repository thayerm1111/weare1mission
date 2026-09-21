"use client";
import { useEffect, useRef } from "react";
import { H } from "./theme";

export type RadarBlip = { price: number; kind: "buyside" | "sellside" | "node" | "watch"; label: string; swept?: boolean };

/**
 * LIQUIDITY RADAR — where the engine's levels sit around price.
 *
 * Distance from the centre is distance from price (scaled to the farthest level shown); levels above
 * price sit in the upper half, below in the lower. Swept levels are drawn hollow. It only draws levels
 * the engine and its history map actually hold; the sweep line is decoration, the blips are data.
 */
export function LiquidityRadar({ price, blips, size = 150, alive }: { price: number | null; blips: RadarBlip[]; size?: number; alive: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const data = useRef({ price, blips, alive });
  data.current = { price, blips, alive };

  useEffect(() => {
    const c = ref.current; if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr; c.height = size * dpr;
    const g = c.getContext("2d"); if (!g) return;
    g.scale(dpr, dpr);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0; const t0 = performance.now();
    const col: Record<RadarBlip["kind"], string> = { buyside: "41,223,166", sellside: "255,83,100", node: "89,175,255", watch: "255,216,117" };

    const draw = (now: number) => {
      const { price: p, blips: bl, alive: al } = data.current;
      const W = size, cx = W / 2, cy = W / 2, R = W / 2 - 6;
      g.clearRect(0, 0, W, W);
      const bg = g.createRadialGradient(cx, cy, 0, cx, cy, R);
      bg.addColorStop(0, "rgba(255,83,100,0.05)"); bg.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = bg; g.fillRect(0, 0, W, W);
      for (let k = 1; k <= 4; k++) { g.beginPath(); g.strokeStyle = `rgba(89,175,255,${0.08 + k * 0.03})`; g.lineWidth = 1; g.arc(cx, cy, (R * k) / 4, 0, Math.PI * 2); g.stroke(); }
      g.strokeStyle = "rgba(89,175,255,0.12)";
      g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
      // tick crown
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * Math.PI * 2;
        g.strokeStyle = k % 6 === 0 ? "rgba(255,83,100,0.55)" : "rgba(255,83,100,0.22)";
        g.beginPath(); g.moveTo(cx + Math.cos(a) * (R + 1), cy + Math.sin(a) * (R + 1)); g.lineTo(cx + Math.cos(a) * (R - (k % 6 === 0 ? 6 : 3)), cy + Math.sin(a) * (R - (k % 6 === 0 ? 6 : 3))); g.stroke();
      }
      // sweep
      const sa = reduce ? -Math.PI / 4 : ((now - t0) / 2600) * Math.PI * 2;
      if (al) {
        const cg = g.createConicGradient ? g.createConicGradient(sa - 0.9, cx, cy) : null;
        if (cg) { cg.addColorStop(0, "rgba(0,0,0,0)"); cg.addColorStop(0.14, "rgba(39,215,242,0.22)"); cg.addColorStop(0.15, "rgba(0,0,0,0)"); g.fillStyle = cg; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill(); }
        g.strokeStyle = "rgba(39,215,242,0.7)"; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(sa) * R, cy + Math.sin(sa) * R); g.stroke();
      }
      // blips
      if (p != null && bl.length) {
        const maxD = Math.max(...bl.map((b) => Math.abs(b.price - p)), 0.5);
        const byHalf = { up: 0, dn: 0 };
        bl.forEach((b) => {
          const d = Math.abs(b.price - p) / maxD;
          const upHalf = b.price >= p;
          const k = upHalf ? byHalf.up++ : byHalf.dn++;
          const a = (upHalf ? -Math.PI : 0) + 0.35 + ((k * 0.61) % 1) * (Math.PI - 0.7);
          const r = 10 + d * (R - 16);
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          const pulseK = 0.5 + 0.5 * Math.sin(now / 420 + k);
          const c = col[b.kind];
          g.beginPath(); g.fillStyle = `rgba(${c},${0.12 + pulseK * 0.12})`; g.arc(x, y, 6 + pulseK * 2, 0, Math.PI * 2); g.fill();
          g.beginPath(); g.lineWidth = 1.4;
          if (b.swept) { g.strokeStyle = `rgba(${c},0.95)`; g.arc(x, y, 3, 0, Math.PI * 2); g.stroke(); }
          else { g.fillStyle = `rgba(${c},0.95)`; g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
        });
      }
      // price
      g.beginPath(); g.fillStyle = H.gold3; g.shadowColor = H.gold3; g.shadowBlur = 8; g.arc(cx, cy, 3.5, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={ref} style={{ width: size, height: size, display: "block" }} aria-label="Liquidity radar" />;
}
