"use client";

import { useEffect, useRef } from "react";

/**
 * THE BRAIN CORE.
 *
 * A living visual, and every part of its motion is a market measurement:
 *   • breathing rate  ← intensity (volatility + velocity). A dead market breathes slowly. A violent one races.
 *   • radius swell    ← intensity
 *   • directional tilt← pressure lean: the field leans toward whichever side has control
 *   • ring rotation   ← intensity
 *   • filament count  ← how much THE BRAIN currently has to process (events in play)
 *   • hue             ← lean, from cold blue through gold to warm red
 *
 * There is no idle animation. If the market is still, this is still, and that stillness is information.
 * When there is no market data the core goes grey and stops — it never pretends to be alive.
 */
export type BrainCoreProps = {
  /** 0–100, from volatility and velocity. */
  intensity: number;
  /** -100 (sellers) … +100 (buyers). */
  lean: number;
  /** How many things it is actively tracking — drives filament density. */
  load?: number;
  /** False when the feed is dead or the market is closed: the core dims and nearly stops. */
  alive: boolean;
  size?: number;
  className?: string;
};

export function BrainCore({ intensity, lean, load = 0, alive, size = 200, className = "" }: BrainCoreProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  // Live values in a ref so the animation loop is never torn down and restarted by a prop change —
  // the core breathes continuously and simply follows the market to its new state.
  const target = useRef({ intensity, lean, load, alive });
  target.current = { intensity, lean, load, alive };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const cx = size / 2;
    const cy = size / 2;
    const base = size * 0.26;

    // Smoothed state: the visual eases toward the market rather than snapping, which reads as breathing
    // rather than flickering.
    let iNow = 0, leanNow = 0, loadNow = 0, aliveNow = 0;
    let phase = 0;
    let ringPhase = 0;
    let raf = 0;
    let last = performance.now();

    const reduced = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

    const draw = (now: number) => {
      const dt = Math.min(64, now - last) / 1000;
      last = now;

      const t = target.current;
      const ease = 1 - Math.exp(-dt * 1.6);
      iNow += ((t.alive ? t.intensity : 2) - iNow) * ease;
      leanNow += (t.lean - leanNow) * ease;
      loadNow += (t.load - loadNow) * ease;
      aliveNow += ((t.alive ? 1 : 0) - aliveNow) * ease;

      // Breath period: ~7s when the market is asleep, ~1.1s when it is running.
      const period = 7 - (iNow / 100) * 5.9;
      phase += (dt / Math.max(0.6, period)) * Math.PI * 2 * (reduced ? 0.35 : 1);
      ringPhase += dt * (0.08 + (iNow / 100) * 0.85) * (reduced ? 0.3 : 1);

      const breathe = Math.sin(phase);
      const swell = 1 + (0.04 + (iNow / 100) * 0.12) * breathe;
      const r = base * swell;

      // Hue: cold blue when sellers lead, gold at balance, warm when buyers lead. Desaturates when dead.
      const l = Math.max(-100, Math.min(100, leanNow)) / 100;
      const H = l >= 0 ? 44 - l * 12 : 208 + l * 4;      // 44 = gold, 208 = cold blue
      const sat = (28 + Math.abs(l) * 34) * (0.25 + aliveNow * 0.75);
      const lum = 52 + (iNow / 100) * 14;

      ctx.clearRect(0, 0, size, size);

      // Outer field — the energy it sits in. Expands with volatility, leans with pressure.
      const tilt = l * size * 0.035;
      const g = ctx.createRadialGradient(cx + tilt, cy, r * 0.25, cx, cy, size * 0.5);
      g.addColorStop(0, `hsla(${H}, ${sat}%, ${lum}%, ${0.30 * (0.25 + aliveNow * 0.75)})`);
      g.addColorStop(0.45, `hsla(${H}, ${sat}%, ${lum - 14}%, ${0.12 * (0.25 + aliveNow * 0.75)})`);
      g.addColorStop(1, "hsla(210, 20%, 8%, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.5, 0, Math.PI * 2);
      ctx.fill();

      // Filaments — neural activity. Their number is how much it has to process; their jitter is intensity.
      const strands = Math.round(6 + Math.min(16, loadNow) * 1.1);
      ctx.lineWidth = 1;
      for (let k = 0; k < strands; k++) {
        const a = (k / strands) * Math.PI * 2 + ringPhase * 0.6;
        const wobble = Math.sin(phase * 1.7 + k) * (0.04 + (iNow / 100) * 0.22);
        const r1 = r * (1.08 + wobble);
        const r2 = r * (1.55 + wobble * 1.6);
        ctx.strokeStyle = `hsla(${H}, ${sat}%, ${lum + 12}%, ${(0.07 + (iNow / 100) * 0.22) * aliveNow})`;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.quadraticCurveTo(
          cx + Math.cos(a + 0.3) * r2 * 1.05, cy + Math.sin(a + 0.3) * r2 * 1.05,
          cx + Math.cos(a + 0.62) * r2, cy + Math.sin(a + 0.62) * r2,
        );
        ctx.stroke();
      }

      // Orbit ring — rotation speed is intensity. Its gap sits on the side that is losing.
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = `hsla(${H}, ${sat + 10}%, ${lum + 16}%, ${(0.22 + (iNow / 100) * 0.3) * aliveNow})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.62, ringPhase, ringPhase + Math.PI * 1.55);
      ctx.stroke();

      ctx.lineWidth = 0.8;
      ctx.strokeStyle = `hsla(${H}, ${sat}%, ${lum + 6}%, ${0.14 * aliveNow})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.92, -ringPhase * 0.62, -ringPhase * 0.62 + Math.PI * 1.1);
      ctx.stroke();

      // The core. Deliberately NOT a glossy sphere — a dense, dark centre with light at its edge reads
      // as an instrument; a shiny ball reads as a toy.
      const ccx = cx + tilt * 0.35;
      const core = ctx.createRadialGradient(ccx, cy, r * 0.02, ccx, cy, r);
      core.addColorStop(0, `hsla(${H}, ${sat + 10}%, ${Math.max(8, lum - 38)}%, ${0.55 + aliveNow * 0.4})`);
      core.addColorStop(0.62, `hsla(${H}, ${sat + 6}%, ${Math.max(12, lum - 26)}%, ${0.42 + aliveNow * 0.32})`);
      core.addColorStop(0.9, `hsla(${H}, ${Math.min(92, sat + 30)}%, ${Math.min(88, lum + 22)}%, ${0.30 + aliveNow * 0.4})`);
      core.addColorStop(1, `hsla(${H}, ${Math.min(92, sat + 34)}%, ${Math.min(94, lum + 30)}%, ${0.10 + aliveNow * 0.22})`);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(ccx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      // Concentric contours inside the core — they contract with compression and spread with expansion,
      // so the core's internal structure is itself a reading of volatility.
      for (let k = 1; k <= 3; k++) {
        const rr = r * (0.3 + k * 0.2) * (1 + (iNow / 100) * 0.10 * Math.sin(phase + k));
        ctx.lineWidth = 0.7;
        ctx.strokeStyle = `hsla(${H}, ${sat + 16}%, ${lum + 20}%, ${(0.10 + (iNow / 100) * 0.16) * aliveNow})`;
        ctx.beginPath();
        ctx.arc(ccx, cy, rr, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Rim.
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = `hsla(${H}, ${sat + 20}%, ${lum + 28}%, ${(0.42 + (iNow / 100) * 0.34) * aliveNow})`;
      ctx.beginPath();
      ctx.arc(ccx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      // A single bright arc on the side that has control. It is the one unmistakable directional cue.
      if (Math.abs(l) > 0.06) {
        const start = l >= 0 ? -Math.PI / 2 - 0.5 : Math.PI / 2 - 0.5;
        ctx.lineWidth = 2;
        ctx.strokeStyle = `hsla(${l >= 0 ? 152 : 356}, 62%, 62%, ${Math.min(0.62, Math.abs(l) * 0.8) * aliveNow})`;
        ctx.beginPath();
        ctx.arc(ccx, cy, r * 1.06, start, start + Math.min(2.4, Math.abs(l) * 3));
        ctx.stroke();
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={ref} width={size} height={size} style={{ width: size, height: size }} className={className} aria-hidden />;
}

export default BrainCore;
