"use client";
import { useEffect, useRef } from "react";

/**
 * THE BRAIN CORE — the golden intelligence sphere with its orbital instrument rings.
 *
 * Its motion is tied to state, not decoration: rotation speed follows market intensity, the pulse
 * colour follows the Brain state (cyan watching, gold opportunity, green in a trade, red on a risk
 * event), and a new thesis sends one ring of light outward. With no live market it slows almost to a
 * stop and desaturates — it never pretends to be watching a feed that is not arriving.
 */
export type OrbState = "idle" | "watching" | "analyzing" | "opportunity" | "trade_ready" | "in_trade" | "risk_event" | "speaking";

const STATE_RGB: Record<OrbState, [number, number, number]> = {
  idle: [89, 175, 255], watching: [39, 215, 242], analyzing: [39, 215, 242], opportunity: [255, 216, 117],
  trade_ready: [255, 216, 117], in_trade: [41, 223, 166], risk_event: [255, 83, 100], speaking: [255, 216, 117],
};

export function BrainOrb({ state, intensity, alive, pulseKey, size = 240 }: {
  state: OrbState; intensity: number; alive: boolean; pulseKey?: string | number | null; size?: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const live = useRef({ state, intensity, alive });
  live.current = { state, intensity, alive };
  const pulse = useRef<{ t: number } | null>(null);
  const lastKey = useRef<string | number | null | undefined>(pulseKey);

  useEffect(() => {
    if (pulseKey != null && pulseKey !== lastKey.current) { lastKey.current = pulseKey; pulse.current = { t: performance.now() }; }
  }, [pulseKey]);

  useEffect(() => {
    const c = ref.current; if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr; c.height = size * dpr;
    const g = c.getContext("2d"); if (!g) return;
    g.scale(dpr, dpr);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    // Particles orbiting at fixed radii; generated once so the field is stable, not noisy.
    const parts = Array.from({ length: 70 }, (_, i) => ({
      r: 0.36 + ((i * 37) % 100) / 100 * 0.14, a: (i * 2.399) % (Math.PI * 2), s: 0.15 + ((i * 13) % 10) / 40, z: ((i * 7) % 10) / 10,
    }));

    let raf = 0; let t0 = performance.now(); let phase = 0;
    const draw = (now: number) => {
      const dt = Math.min(64, now - t0); t0 = now;
      const { state: st, intensity: it, alive: al } = live.current;
      const speed = (al ? 0.35 + Math.min(1, it / 100) * 1.1 : 0.06) * (st === "analyzing" || st === "speaking" ? 1.6 : 1);
      phase += (reduce ? 0 : dt / 1000) * speed;
      const [R, G, B] = STATE_RGB[al ? st : "idle"];
      const W = size, cx = W / 2, cy = W / 2, rad = W * 0.5;
      g.clearRect(0, 0, W, W);

      // outer halo
      const halo = g.createRadialGradient(cx, cy, rad * 0.1, cx, cy, rad);
      halo.addColorStop(0, `rgba(255,200,90,${al ? 0.20 : 0.06})`);
      halo.addColorStop(0.45, `rgba(${R},${G},${B},${al ? 0.07 : 0.02})`);
      halo.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = halo; g.fillRect(0, 0, W, W);

      // fine tick rings
      g.save(); g.translate(cx, cy);
      const ring = (r: number, alpha: number, w = 1, dash?: number[]) => {
        g.beginPath(); g.setLineDash(dash ?? []); g.lineWidth = w;
        g.strokeStyle = `rgba(${R},${G},${B},${alpha})`; g.arc(0, 0, r, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
      };
      ring(rad * 0.93, 0.18, 1, [1, 5]);
      ring(rad * 0.84, 0.22);
      ring(rad * 0.62, 0.16, 1, [2, 3]);

      // tick marks on the 0.88 ring, rotating slowly
      g.save(); g.rotate(phase * 0.15);
      for (let k = 0; k < 120; k++) {
        const a = (k / 120) * Math.PI * 2, long = k % 10 === 0;
        g.strokeStyle = `rgba(${R},${G},${B},${long ? 0.55 : 0.22})`; g.lineWidth = 1;
        g.beginPath(); g.moveTo(Math.cos(a) * rad * 0.86, Math.sin(a) * rad * 0.86);
        g.lineTo(Math.cos(a) * rad * (long ? 0.905 : 0.885), Math.sin(a) * rad * (long ? 0.905 : 0.885)); g.stroke();
      }
      g.restore();

      // rotating arcs — gold and cyan, counter-rotating
      const arc = (r: number, from: number, len: number, col: string, w: number) => {
        g.beginPath(); g.strokeStyle = col; g.lineWidth = w; g.lineCap = "round"; g.arc(0, 0, r, from, from + len); g.stroke();
      };
      arc(rad * 0.76, phase * 0.9, 1.3, `rgba(255,216,117,${al ? 0.85 : 0.3})`, 2.2);
      arc(rad * 0.76, phase * 0.9 + Math.PI, 0.55, `rgba(255,216,117,${al ? 0.5 : 0.2})`, 1.4);
      arc(rad * 0.70, -phase * 1.3, 0.9, `rgba(39,215,242,${al ? 0.8 : 0.25})`, 1.8);
      arc(rad * 0.70, -phase * 1.3 + 2.4, 1.6, `rgba(39,215,242,${al ? 0.35 : 0.12})`, 1);
      arc(rad * 0.955, phase * 0.4 + 1, 0.8, `rgba(${R},${G},${B},0.6)`, 1.6);
      arc(rad * 0.955, phase * 0.4 + 4, 0.35, `rgba(255,216,117,0.55)`, 1.6);
      arc(rad * 0.53, phase * 2.1, 0.6, `rgba(255,216,117,${al ? 0.6 : 0.2})`, 1.2);
      arc(rad * 0.53, phase * 2.1 + 3.4, 1.1, `rgba(39,215,242,${al ? 0.45 : 0.15})`, 1);

      // particles
      for (const p of parts) {
        const a = p.a + phase * p.s;
        const x = Math.cos(a) * rad * p.r * 1.55, y = Math.sin(a) * rad * p.r * 1.55;
        g.fillStyle = p.z > 0.5 ? `rgba(255,216,117,${0.25 + p.z * 0.4})` : `rgba(${R},${G},${B},${0.2 + p.z * 0.5})`;
        g.fillRect(x, y, p.z > 0.8 ? 1.6 : 1, p.z > 0.8 ? 1.6 : 1);
      }

      // scanner sweep
      if (al) {
        const sa = (phase * 0.8) % (Math.PI * 2);
        const sg = g.createConicGradient ? g.createConicGradient(sa, 0, 0) : null;
        if (sg) {
          sg.addColorStop(0, `rgba(${R},${G},${B},0.16)`); sg.addColorStop(0.08, "rgba(0,0,0,0)"); sg.addColorStop(1, "rgba(0,0,0,0)");
          g.fillStyle = sg; g.beginPath(); g.arc(0, 0, rad * 0.84, 0, Math.PI * 2); g.fill();
        }
      }

      // thesis-change pulse: one expanding ring
      if (pulse.current) {
        const k = (now - pulse.current.t) / 1400;
        if (k >= 1) pulse.current = null;
        else { g.beginPath(); g.lineWidth = 2; g.strokeStyle = `rgba(255,216,117,${0.7 * (1 - k)})`; g.arc(0, 0, rad * (0.3 + k * 0.7), 0, Math.PI * 2); g.stroke(); }
      }

      // the core sphere
      const breathe = 1 + Math.sin(phase * 2.2) * (al ? 0.025 + Math.min(1, it / 100) * 0.03 : 0.005);
      const cr = rad * 0.3 * breathe;
      const core = g.createRadialGradient(-cr * 0.3, -cr * 0.35, cr * 0.05, 0, 0, cr);
      core.addColorStop(0, al ? "rgba(255,246,214,1)" : "rgba(200,200,200,0.8)");
      core.addColorStop(0.25, al ? "rgba(255,216,117,0.98)" : "rgba(150,150,150,0.7)");
      core.addColorStop(0.7, al ? "rgba(196,137,32,0.95)" : "rgba(90,90,90,0.6)");
      core.addColorStop(1, al ? "rgba(80,50,10,0.9)" : "rgba(40,40,40,0.6)");
      g.shadowColor = al ? "rgba(255,196,80,0.8)" : "transparent"; g.shadowBlur = al ? 26 : 0;
      g.fillStyle = core; g.beginPath(); g.arc(0, 0, cr, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
      // circuitry on the sphere
      g.save(); g.beginPath(); g.arc(0, 0, cr, 0, Math.PI * 2); g.clip();
      g.strokeStyle = "rgba(255,240,200,0.35)"; g.lineWidth = 0.7;
      for (let k = -3; k <= 3; k++) {
        g.beginPath(); g.ellipse(0, 0, cr, Math.abs(k) * cr * 0.28 + 0.5, 0, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.ellipse(Math.sin(phase * 0.6) * 2, 0, Math.abs(k) * cr * 0.28 + 0.5, cr, 0, 0, Math.PI * 2); g.stroke();
      }
      g.restore();
      // cyan inner ring hugging the core
      g.beginPath(); g.lineWidth = 1.5; g.strokeStyle = `rgba(39,215,242,${al ? 0.7 : 0.2})`; g.arc(0, 0, cr * 1.18, 0, Math.PI * 2); g.stroke();
      g.restore();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={ref} style={{ width: size, height: size, display: "block" }} aria-label="THE BRAIN core" />;
}
