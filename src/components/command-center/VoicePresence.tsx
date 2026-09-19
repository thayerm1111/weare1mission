"use client";

import { useEffect, useRef } from "react";

/**
 * THE PRESENCE — something to talk TO, rather than a transcript to read.
 *
 * A voice session that renders as a chat box is a chat box. The thing that makes a conversation feel
 * like a conversation is that the other party is visibly there while it happens: reacting while you
 * speak, moving while it answers, still when neither of you is saying anything.
 *
 * EVERY MOVEMENT HERE IS A MEASUREMENT, which is the same rule the market visuals follow. The outer
 * ring follows the microphone, so a member can SEE they are being heard — that alone would have made
 * three hours of silent-microphone debugging unnecessary. The core follows the actual amplitude of the
 * audio being played, sample by sample, so it moves with the words rather than to a timer. When
 * nothing is happening it breathes slowly and does nothing else.
 *
 * There is no idle animation pretending to be alive. A presence that gestures while disconnected is
 * a cartoon, and this system is not in the business of implying activity it does not have.
 */

export type PresenceMode = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "muted" | "dead";

export function VoicePresence({
  mode, micLevel, outLevel, size = 132,
}: {
  mode: PresenceMode;
  /** 0–1, the microphone's current peak. */
  micLevel: number;
  /** 0–1, the amplitude of what is being spoken right now. */
  outLevel: number;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const live = useRef({ mode, micLevel, outLevel });
  live.current = { mode, micLevel, outLevel };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const cx = size / 2, cy = size / 2;
    let raf = 0, t = 0, last = performance.now();
    // Smoothed, so the face does not flicker on a single loud sample.
    let mic = 0, out = 0, breath = 0;

    const PALETTE: Record<PresenceMode, [string, string]> = {
      idle:       ["#3d4a5f", "#2a3444"],
      connecting: ["#6FA8DC", "#3d4a5f"],
      listening:  ["#3FD9A0", "#1f6f57"],
      thinking:   ["#6FA8DC", "#2f5d80"],
      speaking:   ["#F0C475", "#8a6b32"],
      muted:      ["#E9B949", "#5f4d20"],
      dead:       ["#F4737B", "#5f2f33"],
    };

    const draw = (now: number) => {
      const dt = Math.min(64, now - last) / 1000;
      last = now;
      const s = live.current;

      mic += (s.micLevel - mic) * Math.min(1, dt * 14);
      out += (s.outLevel - out) * Math.min(1, dt * 20);

      /*
       * Breathing rate carries meaning: fast while it is speaking, attentive while listening, slow and
       * shallow when there is nothing to do. It is the difference between "connected" and "present".
       */
      const rate = s.mode === "speaking" ? 1.9 : s.mode === "listening" ? 1.0 : s.mode === "thinking" ? 2.6 : 0.42;
      breath += dt * rate;
      t += dt;

      const [hi, lo] = PALETTE[s.mode] ?? PALETTE.idle;
      const alive = s.mode !== "idle" && s.mode !== "dead";
      ctx.clearRect(0, 0, size, size);

      // ── the listening ring: this is the microphone, drawn ──────────────
      const ringR = size * 0.40;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 2;
      ctx.stroke();

      if (s.mode === "listening" || s.mode === "muted") {
        const heard = Math.min(1, mic * 9);
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * heard);
        ctx.strokeStyle = s.mode === "muted" ? PALETTE.muted[0] : PALETTE.listening[0];
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.stroke();
      }

      // ── the core ───────────────────────────────────────────────────────
      const pulse = alive ? Math.sin(breath) * 0.045 : 0;
      // What it is SAYING drives the size. The words are visible before they are understood.
      const speech = s.mode === "speaking" ? out * 0.42 : 0;
      const r = size * (0.215 + pulse + speech);

      const g = ctx.createRadialGradient(cx, cy - r * 0.25, r * 0.15, cx, cy, r * 1.25);
      g.addColorStop(0, hi);
      g.addColorStop(0.55, lo);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.globalAlpha = alive ? 0.95 : 0.4;
      ctx.fill();
      ctx.globalAlpha = 1;

      /*
       * The voice, drawn as it is spoken.
       *
       * Not a waveform of the whole utterance — a ring of spokes whose length is the CURRENT amplitude,
       * so it moves on syllables. This is the part that reads as somebody talking rather than a
       * progress indicator.
       */
      if (s.mode === "speaking" && out > 0.004) {
        const spokes = 40;
        ctx.strokeStyle = hi;
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        for (let i = 0; i < spokes; i++) {
          const a = (i / spokes) * Math.PI * 2;
          // A fixed per-spoke offset, so the shape has character instead of being a perfect circle.
          const jitter = 0.55 + 0.45 * Math.abs(Math.sin(i * 2.39 + t * 2.1));
          const len = r * 0.20 + out * size * 0.34 * jitter;
          const x0 = cx + Math.cos(a) * (r + 3), y0 = cy + Math.sin(a) * (r + 3);
          ctx.globalAlpha = 0.18 + 0.5 * jitter * Math.min(1, out * 5);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(cx + Math.cos(a) * (r + 3 + len), cy + Math.sin(a) * (r + 3 + len));
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // ── thinking: three points going round, and nothing else ───────────
      if (s.mode === "thinking" || s.mode === "connecting") {
        for (let i = 0; i < 3; i++) {
          const a = t * 2.2 + (i * Math.PI * 2) / 3;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * ringR, cy + Math.sin(a) * ringR, 2.6, 0, Math.PI * 2);
          ctx.fillStyle = hi;
          ctx.globalAlpha = 0.35 + 0.45 * ((Math.sin(t * 3 + i) + 1) / 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // ── muted: it can still hear nothing, and says so without words ────
      if (s.mode === "muted") {
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.72, cy - r * 0.72);
        ctx.lineTo(cx + r * 0.72, cy + r * 0.72);
        ctx.strokeStyle = PALETTE.muted[0];
        ctx.lineWidth = 2.4;
        ctx.lineCap = "round";
        ctx.stroke();
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={ref} style={{ width: size, height: size, display: "block" }} aria-hidden />;
}

export default VoicePresence;
