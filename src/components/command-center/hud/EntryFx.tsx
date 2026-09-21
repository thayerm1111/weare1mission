"use client";
import { useEffect, useRef } from "react";

/**
 * THE OPENING (owner 09-21): "When I tap enter I want the screen to really move and it to really feel
 * like I'm opening things. Show flashes of gold, the market moving, and just overall more futuristic
 * technology." And: "I still want sound."
 *
 *   0.00s  tap        a hard gold flash from the seam; blast doors begin to part with a boom + hiss
 *   0.15s  warp       light streaks rush out from the centre (hyperspace), sparks burst from the seam
 *   0.40s  doors      the two gold-edged doors slide apart, the room shakes once
 *   0.6s→  market     a live-looking gold chart races across the back wall, seeded from the real price,
 *                     with a glowing head and price tag; data columns stream down both edges
 *   later  flashes    short gold flashes on each system check and at ATLAS ONLINE (driven by the parent)
 *
 * Sound is synthesised on the AudioContext created inside the tap — no files, nothing to download, and
 * silent (never broken) where the browser refuses audio.
 */

/* ── sound ─────────────────────────────────────────────────────────────────── */

type Ctx = AudioContext;
function out(ctx: Ctx, vol: number) {
  const g = ctx.createGain(); g.gain.value = vol; g.connect(ctx.destination); return g;
}
function noiseBuf(ctx: Ctx, secs: number) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * secs), ctx.sampleRate);
  const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
const ok = (ctx: Ctx | null): ctx is Ctx => !!ctx && ctx.state === "running";

/** Deep sub-boom — the doors unlocking. */
export function sfxBoom(ctx: Ctx | null) {
  if (!ok(ctx)) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = out(ctx, 0);
  o.type = "sine"; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(28, t + 1.1);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.55, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
  o.connect(g); o.start(t); o.stop(t + 1.35);
  // the crack on top
  const n = ctx.createBufferSource(); n.buffer = noiseBuf(ctx, 0.3);
  const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 900;
  const ng = out(ctx, 0); ng.gain.setValueAtTime(0.35, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  n.connect(f); f.connect(ng); n.start(t);
}

/** Rising air rush — hydraulics and the doors sliding. */
export function sfxWhoosh(ctx: Ctx | null, dur = 1.2, from = 250, to = 3200, vol = 0.22) {
  if (!ok(ctx)) return;
  const t = ctx.currentTime, n = ctx.createBufferSource(); n.buffer = noiseBuf(ctx, dur + 0.1);
  const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 1.1;
  f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur * 0.8);
  const g = out(ctx, 0); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.35); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  n.connect(f); f.connect(g); n.start(t); n.stop(t + dur + 0.05);
}

/** A tight digital blip — a system coming online. */
export function sfxBlip(ctx: Ctx | null, freq = 1320, vol = 0.05) {
  if (!ok(ctx)) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = out(ctx, 0);
  o.type = "square"; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + 0.06);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  o.connect(g); o.start(t); o.stop(t + 0.1);
}

/** Power-up swell and chord — ATLAS ONLINE. */
export function sfxOnline(ctx: Ctx | null) {
  if (!ok(ctx)) return;
  const t = ctx.currentTime;
  [196, 293.66, 392, 587.33, 783.99].forEach((fq, i) => {
    const o = ctx.createOscillator(), g = out(ctx, 0);
    o.type = i < 2 ? "sawtooth" : "sine"; o.frequency.value = fq;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(400, t); lp.frequency.exponentialRampToValueAtTime(4200, t + 0.9);
    const v = i < 2 ? 0.035 : 0.05;
    g.gain.setValueAtTime(0.0001, t + i * 0.05); g.gain.exponentialRampToValueAtTime(v, t + 0.25 + i * 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    o.connect(lp); lp.connect(g); o.start(t + i * 0.05); o.stop(t + 2.3);
  });
  sfxWhoosh(ctx, 0.9, 600, 6000, 0.08);
}

/** A low hum under the whole sequence, faded by the returned stopper. */
export function sfxHum(ctx: Ctx | null): () => void {
  if (!ok(ctx)) return () => {};
  const t = ctx.currentTime, g = out(ctx, 0);
  const a = ctx.createOscillator(), b = ctx.createOscillator();
  a.type = "sine"; a.frequency.value = 55; b.type = "sine"; b.frequency.value = 55.7;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 1.5);
  a.connect(g); b.connect(g); a.start(t); b.start(t);
  return () => {
    try { const n = ctx.currentTime; g.gain.cancelScheduledValues(n); g.gain.setValueAtTime(g.gain.value, n); g.gain.exponentialRampToValueAtTime(0.0001, n + 0.8); a.stop(n + 0.9); b.stop(n + 0.9); } catch { /* gone */ }
  };
}

/* ── the moving market + warp + sparks (one canvas) ─────────────────────────── */

type Spark = { x: number; y: number; vx: number; vy: number; life: number; max: number };

export function MarketStorm({ price, flashKey }: { price: number | null; flashKey: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const priceRef = useRef(price);
  priceRef.current = price;
  const flashRef = useRef({ key: flashKey, at: -1 });
  if (flashRef.current.key !== flashKey) flashRef.current = { key: flashKey, at: performance.now() };

  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const g = cv.getContext("2d"); if (!g) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let W = 0, Hh = 0, dpr = 1;
    const size = () => { dpr = Math.min(2, window.devicePixelRatio || 1); W = cv.clientWidth; Hh = cv.clientHeight; cv.width = W * dpr; cv.height = Hh * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size(); window.addEventListener("resize", size);

    // candles: a random walk anchored to the real price when it arrives
    const CW = W < 640 ? 9 : 12;
    type C = { o: number; h: number; l: number; c: number };
    let base = priceRef.current ?? 4380;
    const candles: C[] = [];
    let last = base, mom = 0;
    const push = () => {
      const anchor = priceRef.current ?? base;
      // trending legs with pullbacks, pulled gently toward the real price — reads like a market, not noise
      mom = mom * 0.82 + (Math.random() - 0.5) * 1.6 + (anchor - last) * 0.03;
      const o = last, c = o + mom + (Math.random() - 0.5) * 1.2;
      const h = Math.max(o, c) + Math.random() * 1.4, l = Math.min(o, c) - Math.random() * 1.4;
      candles.push({ o, h, l, c }); last = c;
      if (candles.length > 400) candles.shift();
    };
    for (let i = 0; i < Math.ceil(W / CW) + 4; i++) push();

    const sparks: Spark[] = [];
    const burst = (n: number, x: number, y: number, spread = 1) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = (2 + Math.random() * 9) * spread;
        sparks.push({ x, y, vx: Math.cos(a) * v * (1.6), vy: Math.sin(a) * v * 0.7, life: 0, max: 40 + Math.random() * 50 });
      }
    };
    const streaks = Array.from({ length: W < 640 ? 70 : 140 }, () => ({ a: Math.random() * Math.PI * 2, r: Math.random() * 40, v: 6 + Math.random() * 22, w: 0.5 + Math.random() * 1.6 }));

    const t0 = performance.now();
    let lastPush = t0, raf = 0, shift = 0, burstDone = false, lastFlash = -1;
    const draw = (now: number) => {
      const t = now - t0;
      g.clearRect(0, 0, W, Hh);
      const cx = W / 2, cy = Hh / 2;

      if (!burstDone && t > 120) { burst(W < 640 ? 90 : 180, cx, cy, 1.2); burstDone = true; }
      if (flashRef.current.at > 0 && flashRef.current.at !== lastFlash) { lastFlash = flashRef.current.at; burst(40, cx + (Math.random() - 0.5) * W * 0.5, cy + (Math.random() - 0.5) * Hh * 0.4, 0.6); }

      // 1) warp streaks for the first ~1.6s
      if (t < 1800 && !reduce) {
        const k = t < 300 ? t / 300 : Math.max(0, 1 - (t - 300) / 1500);
        g.lineCap = "round";
        for (const s of streaks) {
          s.r += s.v * (1 + t / 300);
          const r2 = s.r + s.v * 6;
          const x1 = cx + Math.cos(s.a) * s.r, y1 = cy + Math.sin(s.a) * s.r * 0.62;
          const x2 = cx + Math.cos(s.a) * r2, y2 = cy + Math.sin(s.a) * r2 * 0.62;
          g.strokeStyle = s.w > 1.3 ? `rgba(255,216,117,${0.75 * k})` : `rgba(120,230,255,${0.5 * k})`;
          g.lineWidth = s.w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
          if (s.r > Math.max(W, Hh)) s.r = Math.random() * 30;
        }
      }

      // 2) the market racing across the back wall
      const mk = Math.min(1, Math.max(0, (t - 450) / 900));
      if (mk > 0) {
        const speed = t < 2200 ? 0.9 : 0.25; // fast while the doors open, then a steady tape
        shift += speed * (reduce ? 0.2 : 1);
        while (shift >= CW) { shift -= CW; push(); }
        if (now - lastPush > 16) lastPush = now;
        const n = Math.ceil(W / CW) + 2;
        const view = candles.slice(-n);
        let lo = Infinity, hi = -Infinity;
        for (const c of view) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
        const pad = (hi - lo) * 0.15 + 1;
        // full-screen while the doors open, then it settles into a band low on the wall, under the text
        const settle = Math.min(1, Math.max(0, (t - 1900) / 900));
        const e = settle * settle * (3 - 2 * settle);
        const top = Hh * (0.2 + 0.46 * e), bot = Hh * (0.8 + 0.14 * e);
        const dim = 1 - 0.45 * e;
        const Y = (v: number) => bot - ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (bot - top);
        g.globalAlpha = 0.28 * mk * dim;
        view.forEach((c, i) => {
          const x = i * CW - shift;
          const up = c.c >= c.o;
          g.strokeStyle = up ? "#E7C467" : "#3FB6D3";
          g.fillStyle = up ? "rgba(231,196,103,.9)" : "rgba(63,182,211,.75)";
          g.lineWidth = 1; g.beginPath(); g.moveTo(x + CW / 2, Y(c.h)); g.lineTo(x + CW / 2, Y(c.l)); g.stroke();
          const y1 = Y(Math.max(c.o, c.c)), y2 = Y(Math.min(c.o, c.c));
          g.fillRect(x + 2, y1, CW - 4, Math.max(1, y2 - y1));
        });
        // the tape line and its glowing head
        g.globalAlpha = 0.85 * mk * dim;
        g.strokeStyle = "rgba(255,216,117,.9)"; g.lineWidth = 1.6; g.shadowColor = "rgba(255,216,117,.8)"; g.shadowBlur = 10;
        g.beginPath();
        view.forEach((c, i) => { const x = i * CW - shift + CW / 2, y = Y(c.c); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
        g.stroke();
        const lc = view[view.length - 1];
        const hx = (view.length - 1) * CW - shift + CW / 2, hy = Y(lc.c);
        g.fillStyle = "#FFD875"; g.beginPath(); g.arc(Math.min(hx, W - 8), hy, 3.5, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
        g.globalAlpha = mk * (0.6 + 0.4 * dim);
        g.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
        const label = `XAUUSD ${lc.c.toFixed(2)}`;
        const tw = g.measureText(label).width + 12;
        const lx = Math.min(W - tw - 6, hx + 8);
        g.fillStyle = "rgba(213,169,61,.92)"; g.fillRect(lx, hy - 9, tw, 18);
        g.fillStyle = "#10131A"; g.fillText(label, lx + 6, hy + 4);
        g.globalAlpha = 1;
        base = priceRef.current ?? base;
      }

      // 3) sparks
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i]; s.life++; s.x += s.vx; s.y += s.vy; s.vx *= 0.965; s.vy = s.vy * 0.965 + 0.06;
        const a = 1 - s.life / s.max;
        if (a <= 0) { sparks.splice(i, 1); continue; }
        g.fillStyle = `rgba(255,${190 + Math.floor(40 * a)},${90 + Math.floor(60 * a)},${a})`;
        g.fillRect(s.x, s.y, 2, 2);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", size); };
  }, []);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />;
}

/** Columns of streaming numbers down both edges — the machine reading the market. */
export function DataRain({ price, side }: { price: number | null; side: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    let n = 0;
    const id = window.setInterval(() => {
      const p = (price ?? 4380) + (Math.random() - 0.5) * 12;
      const kinds = [p.toFixed(2), `Δ ${(Math.random() * 4 - 2).toFixed(2)}`, `VOL ${Math.floor(Math.random() * 900 + 100)}`, `0x${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`, `LQ ${(p + (Math.random() - 0.5) * 30).toFixed(1)}`];
      const row = document.createElement("div");
      row.textContent = kinds[n++ % kinds.length];
      row.className = "es-rain-row";
      if (Math.random() < 0.18) row.style.color = "#FFD875";
      el.prepend(row);
      while (el.childElementCount > 40) el.lastElementChild?.remove();
    }, 70);
    return () => window.clearInterval(id);
  }, [price]);
  return <div ref={ref} className={`es-rain es-rain-${side}`} aria-hidden />;
}

/** Rotating HUD rings around the core. */
export function HudRings({ size, spin }: { size: number; spin: number }) {
  const r = size / 2;
  const ticks = Array.from({ length: 72 }, (_, i) => i);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" aria-hidden
      style={{ opacity: spin }}>
      <g className="es-ring-a" style={{ transformOrigin: "50% 50%" }}>
        {ticks.map((i) => {
          const a = (i / 72) * Math.PI * 2, long = i % 6 === 0;
          const r1 = r - 6, r2 = r - (long ? 18 : 11);
          return <line key={i} x1={r + Math.cos(a) * r1} y1={r + Math.sin(a) * r1} x2={r + Math.cos(a) * r2} y2={r + Math.sin(a) * r2}
            stroke={long ? "rgba(255,216,117,.8)" : "rgba(39,215,242,.45)"} strokeWidth={long ? 2 : 1} />;
        })}
      </g>
      <g className="es-ring-b" style={{ transformOrigin: "50% 50%" }}>
        <circle cx={r} cy={r} r={r - 30} fill="none" stroke="rgba(231,196,103,.75)" strokeWidth={2.5}
          strokeDasharray={`${(r - 30) * 0.9} ${(r - 30) * 0.5} ${(r - 30) * 0.3} ${(r - 30) * 0.6}`} />
      </g>
      <g className="es-ring-c" style={{ transformOrigin: "50% 50%" }}>
        <circle cx={r} cy={r} r={r - 42} fill="none" stroke="rgba(39,215,242,.5)" strokeWidth={1} strokeDasharray="3 7" />
      </g>
    </svg>
  );
}

export const FX_CSS = `
.es-door{position:absolute;left:0;right:0;height:50.5%;z-index:60;background:
  linear-gradient(180deg,#0b1118,#05090e),repeating-linear-gradient(90deg,rgba(39,215,242,.06) 0 1px,transparent 1px 42px);
  background-blend-mode:screen;transition:transform 1.05s cubic-bezier(.7,0,.2,1)}
.es-door::after{content:"";position:absolute;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent,#FFD875 20%,#fff6d8 50%,#FFD875 80%,transparent);box-shadow:0 0 22px 4px rgba(255,216,117,.8)}
.es-door-top{top:0}.es-door-top::after{bottom:0}
.es-door-bot{bottom:0}.es-door-bot::after{top:0}
.es-door-label{position:absolute;left:50%;transform:translateX(-50%);font:600 11px ui-monospace,Menlo,monospace;letter-spacing:.4em;color:rgba(231,196,103,.75)}
.es-door-top .es-door-label{bottom:26px}.es-door-bot .es-door-label{top:26px}
.es-open .es-door-top{transform:translateY(-102%)}.es-open .es-door-bot{transform:translateY(102%)}
.es-flash{position:absolute;inset:0;z-index:70;pointer-events:none;background:radial-gradient(60% 40% at 50% 50%,rgba(255,236,180,.95),rgba(255,200,90,.55) 40%,transparent 75%);animation:es-flash .9s ease-out both}
@keyframes es-flash{0%{opacity:0}8%{opacity:1}100%{opacity:0}}
.es-pulse{position:absolute;inset:0;z-index:5;pointer-events:none;background:radial-gradient(50% 45% at 50% 50%,rgba(255,216,117,.28),transparent 70%);animation:es-pulse .7s ease-out both}
@keyframes es-pulse{0%{opacity:0}15%{opacity:1}100%{opacity:0}}
.es-shake{animation:es-shake .55s cubic-bezier(.36,.07,.19,.97) both}
@keyframes es-shake{10%,90%{transform:translate3d(-2px,1px,0)}20%,80%{transform:translate3d(4px,-2px,0)}30%,50%,70%{transform:translate3d(-7px,3px,0)}40%,60%{transform:translate3d(7px,-3px,0)}}
.es-rain{position:absolute;top:0;bottom:0;width:92px;overflow:hidden;z-index:3;font:10px/1.55 ui-monospace,Menlo,monospace;color:rgba(39,215,242,.55);
  mask-image:linear-gradient(to bottom,#000 30%,transparent);-webkit-mask-image:linear-gradient(to bottom,#000 30%,transparent)}
.es-rain-left{left:14px;padding-top:120px}.es-rain-right{right:14px;padding-top:120px;text-align:right}
.es-rain-row{animation:es-in .2s ease-out both}
.es-ring-a{animation:es-spin 14s linear infinite}.es-ring-b{animation:es-spin 6s linear infinite reverse}.es-ring-c{animation:es-spin 22s linear infinite}
@keyframes es-spin{to{transform:rotate(360deg)}}
.es-hex{position:absolute;inset:0;z-index:1;opacity:.12;background-image:radial-gradient(circle at 1px 1px,rgba(39,215,242,.9) 1px,transparent 1.4px);background-size:22px 22px;
  mask-image:radial-gradient(50% 50% at 50% 50%,#000,transparent);-webkit-mask-image:radial-gradient(50% 50% at 50% 50%,#000,transparent)}
.es-tapglow{animation:es-tap 1.6s ease-in-out infinite}
@keyframes es-tap{0%,100%{box-shadow:0 0 18px rgba(231,196,103,.35)}50%{box-shadow:0 0 42px rgba(255,216,117,.8)}}
@media (max-width:640px){.es-rain{width:64px;font-size:9px}}
@media (prefers-reduced-motion: reduce){.es-shake,.es-ring-a,.es-ring-b,.es-ring-c{animation:none}.es-door{transition-duration:.3s}}
`;
