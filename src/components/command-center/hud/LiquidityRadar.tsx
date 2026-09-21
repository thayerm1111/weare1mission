"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { H } from "./theme";

export type RadarBlip = {
  price: number;
  kind: "buyside" | "sellside" | "equal_high" | "equal_low" | "node" | "watch";
  label: string;
  meaning?: string;
  swept?: boolean;
  side?: "above" | "below";
  distance?: number;
};

/**
 * LIQUIDITY RADAR — where the levels sit around price, and what each one is.
 *
 * Distance from the centre is distance from price (scaled to the farthest blip shown); blips above price
 * sit in the upper half, below in the lower. A hollow ring means the level has already been swept.
 *
 * IT DOES NOT SEE ORDERS. Gold is over the counter and no feed in this system carries a book, so nothing
 * here claims to show resting orders or institutional size. Blips are levels the engine holds plus two
 * display-only detections (equal highs/lows, the busiest recent price); the tooltip says, for each one,
 * what it is and that clustered liquidity there is an estimate.
 *
 * Read-only: it renders what it is handed and reports nothing back to anything.
 */
const COL: Record<RadarBlip["kind"], string> = {
  buyside: "41,223,166", sellside: "255,83,100", equal_high: "255,83,100",
  equal_low: "41,223,166", node: "89,175,255", watch: "255,216,117",
};
const KIND_WORD: Record<RadarBlip["kind"], string> = {
  buyside: "Buyside liquidity (estimated)", sellside: "Sellside liquidity (estimated)",
  equal_high: "Equal highs (estimated liquidity)", equal_low: "Equal lows (estimated liquidity)",
  node: "Busiest price", watch: "Atlas watch level",
};

type Placed = RadarBlip & { x: number; y: number };

export function LiquidityRadar({ price, blips, size = 150, alive, onHover }: {
  price: number | null; blips: RadarBlip[]; size?: number; alive: boolean;
  /** The blip under the pointer. The panel shows its detail beside the radar, where there is room for it. */
  onHover?: (b: RadarBlip | null) => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const placed = useRef<Placed[]>([]);
  const data = useRef({ price, blips, alive });
  data.current = { price, blips, alive };
  const [hover, setHoverState] = useState<Placed | null>(null);
  const setHover = useCallback((b: Placed | null) => { setHoverState(b); onHover?.(b); }, [onHover]);

  useEffect(() => {
    const c = ref.current; if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr; c.height = size * dpr;
    const g = c.getContext("2d"); if (!g) return;
    g.scale(dpr, dpr);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0; const t0 = performance.now();

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
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * Math.PI * 2;
        g.strokeStyle = k % 6 === 0 ? "rgba(255,83,100,0.55)" : "rgba(255,83,100,0.22)";
        g.beginPath(); g.moveTo(cx + Math.cos(a) * (R + 1), cy + Math.sin(a) * (R + 1)); g.lineTo(cx + Math.cos(a) * (R - (k % 6 === 0 ? 6 : 3)), cy + Math.sin(a) * (R - (k % 6 === 0 ? 6 : 3))); g.stroke();
      }

      const sa = reduce ? -Math.PI / 4 : ((now - t0) / 3200) * Math.PI * 2;
      if (al) {
        const cg = g.createConicGradient ? g.createConicGradient(sa - 0.9, cx, cy) : null;
        if (cg) { cg.addColorStop(0, "rgba(0,0,0,0)"); cg.addColorStop(0.14, "rgba(39,215,242,0.20)"); cg.addColorStop(0.15, "rgba(0,0,0,0)"); g.fillStyle = cg; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill(); }
        g.strokeStyle = "rgba(39,215,242,0.6)"; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(sa) * R, cy + Math.sin(sa) * R); g.stroke();
      }

      const out: Placed[] = [];
      if (p != null && bl.length) {
        const maxD = Math.max(...bl.map((b) => Math.abs(b.price - p)), 0.5);
        let up = 0, dn = 0;
        for (const b of bl) {
          const d = Math.abs(b.price - p) / maxD;
          const above = (b.side ?? (b.price >= p ? "above" : "below")) === "above";
          const k = above ? up++ : dn++;
          // Fan each half out so blips never stack: above in the upper half, below in the lower.
          const a = (above ? -Math.PI : 0) + 0.32 + ((k * 0.37) % 1) * (Math.PI - 0.64);
          const r = 11 + d * (R - 17);
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          out.push({ ...b, x, y });
          const pulse = reduce ? 0.5 : 0.5 + 0.5 * Math.sin(now / 520 + k);
          const col = COL[b.kind];
          const isHover = hover && Math.abs(hover.price - b.price) < 0.001;
          g.beginPath(); g.fillStyle = `rgba(${col},${0.10 + pulse * 0.10})`; g.arc(x, y, 6 + pulse * 2, 0, Math.PI * 2); g.fill();
          g.beginPath(); g.lineWidth = isHover ? 2 : 1.4;
          if (b.swept) { g.strokeStyle = `rgba(${col},0.95)`; g.arc(x, y, isHover ? 4.5 : 3.2, 0, Math.PI * 2); g.stroke(); }
          else { g.fillStyle = `rgba(${col},0.95)`; g.arc(x, y, isHover ? 4.5 : 3.2, 0, Math.PI * 2); g.fill(); }
          if (b.kind === "watch") { g.beginPath(); g.strokeStyle = `rgba(${col},0.75)`; g.lineWidth = 1; g.arc(x, y, 7.5, 0, Math.PI * 2); g.stroke(); }
        }
      }
      placed.current = out;

      g.beginPath(); g.fillStyle = H.gold3; g.shadowColor = H.gold3; g.shadowBlur = 8; g.arc(cx, cy, 3.5, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size, hover]);

  const onMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best: Placed | null = null, bd = 12;
    for (const b of placed.current) {
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bd) { bd = d; best = b; }
    }
    setHover(best);
  }, [setHover]);

  return (
    <div className="relative" style={{ width: size, height: size }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
      onTouchStart={(e) => {
        const r = e.currentTarget.getBoundingClientRect(); const t = e.touches[0];
        const x = t.clientX - r.left, y = t.clientY - r.top;
        let best: Placed | null = null, bd = 16;
        for (const b of placed.current) { const d = Math.hypot(b.x - x, b.y - y); if (d < bd) { bd = d; best = b; } }
        setHover(best);
      }}>
      <canvas ref={ref} style={{ width: size, height: size, display: "block" }} aria-label="Liquidity radar" />
    </div>
  );
}

/** The plain-English name for each blip kind, so the panel and the radar always agree. */
export const RADAR_KIND_WORD = KIND_WORD;
export const RADAR_KIND_COLOR = COL;
