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
/**
 * ONE COLOUR LANGUAGE (owner 09-21: "what do the dots mean and what is it telling me?"). The old radar
 * coloured by level type, so an "equal high" above price was red and an "equal low" below it was green —
 * the opposite of the ABOVE / BELOW headings beside it. Now colour answers one question, where is it:
 *   green = liquidity ABOVE price (stops of sellers), red = liquidity BELOW price (stops of buyers),
 *   blue = the busiest price (a magnet price trades back to), gold ring = a level ATLAS is watching.
 * The level TYPE is the shape: a round dot is a swing high/low, a diamond is equal highs/lows (stops stacked).
 */
export const ABOVE_RGB = "41,223,166", BELOW_RGB = "255,83,100", NODE_RGB = "89,175,255", WATCH_RGB = "255,216,117";
export function blipRgb(b: Pick<RadarBlip, "kind" | "side" | "price">, price: number | null): string {
  if (b.kind === "node") return NODE_RGB;
  if (b.kind === "watch") return WATCH_RGB;
  const above = (b.side ?? (price != null && b.price >= price ? "above" : "below")) === "above";
  return above ? ABOVE_RGB : BELOW_RGB;
}
/** Nice dollar step so four rings cover the farthest level: rings read $1/$2/$3/$4, $5/$10/$15/$20… */
export function ringStep(maxD: number): number {
  for (const st of [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100]) if (st * 4 >= maxD) return st;
  return Math.ceil(maxD / 4);
}
/** The three nearest levels on each side — the ones the list beside the radar names. */
export function nearestKeys(blips: RadarBlip[], price: number | null, n = 3): Set<number> {
  const out = new Set<number>();
  if (price == null) return out;
  for (const side of ["above", "below"] as const) {
    blips.filter((b) => (b.side ?? (b.price >= price ? "above" : "below")) === side)
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price)).slice(0, n).forEach((b) => out.add(b.price));
  }
  return out;
}

const KIND_WORD: Record<RadarBlip["kind"], string> = {
  buyside: "Buyside liquidity (estimated)", sellside: "Sellside liquidity (estimated)",
  equal_high: "Equal highs (estimated liquidity)", equal_low: "Equal lows (estimated liquidity)",
  node: "Busiest price", watch: "Atlas watch level",
};

type Placed = RadarBlip & { x: number; y: number };

export function LiquidityRadar({ price, blips, size = 150, alive, onHover, onPick }: {
  price: number | null; blips: RadarBlip[]; size?: number; alive: boolean;
  /** The blip under the pointer. The panel shows its detail beside the radar, where there is room for it. */
  onHover?: (b: RadarBlip | null) => void;
  /** Tapping a blip pins that level on the chart. */
  onPick?: (b: RadarBlip) => void;
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
        const step = ringStep(maxD), span = step * 4;
        const named = nearestKeys(bl, p);
        // Ring labels: each ring is a fixed dollar distance from price.
        // Rings 2 and 4 carry their dollar distance (every ring would crowd at phone size).
        g.font = "600 7px ui-monospace, monospace"; g.fillStyle = "rgba(160,190,215,0.6)"; g.textAlign = "center"; g.textBaseline = "top";
        for (const k of [2, 4]) { const rr = 11 + (k / 4) * (R - 17); g.fillText(`$${+(step * k).toFixed(2)}`, cx + rr, cy + 2); }
        g.textAlign = "center"; g.textBaseline = "middle"; g.font = "700 6.5px ui-monospace, monospace";
        g.fillStyle = `rgba(${ABOVE_RGB},0.7)`; g.fillText("ABOVE", cx, cy - R + 13);
        g.fillStyle = `rgba(${BELOW_RGB},0.7)`; g.fillText("BELOW", cx, cy + R - 13);
        let up = 0, dn = 0;
        for (const b of bl) {
          const d = Math.min(1, Math.abs(b.price - p) / span);
          const above = (b.side ?? (b.price >= p ? "above" : "below")) === "above";
          const k = above ? up++ : dn++;
          // Fan each half out so blips never stack. The ANGLE means nothing; only up/down and distance do.
          const a = (above ? -Math.PI : 0) + 0.32 + ((k * 0.37) % 1) * (Math.PI - 0.64);
          const r = 11 + d * (R - 17);
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          out.push({ ...b, x, y });
          const focus = named.has(b.price) || b.kind === "watch";
          const pulse = reduce ? 0.5 : 0.5 + 0.5 * Math.sin(now / 520 + k);
          const col = blipRgb(b, p);
          const isHover = hover && Math.abs(hover.price - b.price) < 0.001;
          const alpha = focus || isHover ? 0.95 : 0.35;
          if (focus) { g.beginPath(); g.fillStyle = `rgba(${col},${0.10 + pulse * 0.10})`; g.arc(x, y, 6 + pulse * 2, 0, Math.PI * 2); g.fill(); }
          const rad = isHover ? 4.5 : focus ? 3.4 : 2.4;
          g.beginPath(); g.lineWidth = isHover ? 2 : 1.4;
          if (b.kind === "equal_high" || b.kind === "equal_low") { g.moveTo(x, y - rad - 1); g.lineTo(x + rad + 1, y); g.lineTo(x, y + rad + 1); g.lineTo(x - rad - 1, y); g.closePath(); }
          else g.arc(x, y, rad, 0, Math.PI * 2);
          if (b.swept) { g.strokeStyle = `rgba(${col},${alpha})`; g.stroke(); }
          else { g.fillStyle = `rgba(${col},${alpha})`; g.fill(); }
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
    <div className="relative" style={{ width: size, height: size, cursor: hover ? "pointer" : undefined }}
      onMouseMove={onMove} onMouseLeave={() => setHover(null)}
      onClick={() => { if (hover && onPick) onPick(hover); }}
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

/**
 * THE RADAR IN ONE SENTENCE — what the picture says right now, from the levels it is showing. Pure; it
 * describes where the untaken liquidity sits and never predicts which way price will go.
 */
export function radarRead(blips: RadarBlip[], price: number | null): string | null {
  if (price == null || !blips.length) return null;
  const live = blips.filter((b) => !b.swept && b.kind !== "node" && b.kind !== "watch");
  const side = (b: RadarBlip) => (b.side ?? (b.price >= price ? "above" : "below"));
  const up = live.filter((b) => side(b) === "above").sort((a, b) => a.price - b.price);
  const dn = live.filter((b) => side(b) === "below").sort((a, b) => b.price - a.price);
  const f = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const d = (b: RadarBlip) => Math.abs(b.price - price);
  const parts: string[] = [];
  const nu = up[0], nd = dn[0];
  if (nu && nd) {
    const near = d(nd) < d(nu) ? nd : nu, far = near === nd ? nu : nd;
    parts.push(`Nearest untaken liquidity is ${side(near) === "above" ? "above" : "below"} at ${f(near.price)} — $${d(near).toFixed(2)} away (the other side is $${d(far).toFixed(2)} away at ${f(far.price)}).`);
  } else if (nu) parts.push(`All the untaken liquidity is above — nearest ${f(nu.price)}, $${d(nu).toFixed(2)} away.`);
  else if (nd) parts.push(`All the untaken liquidity is below — nearest ${f(nd.price)}, $${d(nd).toFixed(2)} away.`);
  const within = (arr: RadarBlip[]) => arr.filter((b) => d(b) <= 10).length;
  const wu = within(up), wd = within(dn);
  if (wu !== wd && Math.max(wu, wd) >= 2) parts.push(`More is stacked ${wu > wd ? "above" : "below"}: ${Math.max(wu, wd)} levels within $10 vs ${Math.min(wu, wd)} ${wu > wd ? "below" : "above"}.`);
  const eq = live.filter((b) => (b.kind === "equal_high" || b.kind === "equal_low") && d(b) <= 10).sort((a, b) => d(a) - d(b))[0];
  if (eq) parts.push(`Equal ${eq.kind === "equal_high" ? "highs" : "lows"} at ${f(eq.price)} are the strongest magnet nearby.`);
  parts.push("Watch how price reacts when it gets there: a quick poke and snap back is a sweep; a close through that holds usually runs to the next level.");
  return parts.join(" ");
}

/** The plain-English name for each blip kind, so the panel and the radar always agree. */
export const RADAR_KIND_WORD = KIND_WORD;
export const RADAR_KIND_COLOR = COL;
