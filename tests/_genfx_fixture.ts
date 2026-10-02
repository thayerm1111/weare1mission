import { type Bar } from "../src/lib/genfx/replay";

/**
 * A deterministic stand-in for a currency market: a seeded random walk with drifting trend legs and
 * a calm/active volatility cycle, on a 5-minute clock that skips weekends the way the real feed does
 * (Friday 21:00 UTC to Sunday 21:00 UTC). Nothing here is tuned to make GEN FX look good or bad — it
 * exists so the replay's mechanics can be tested without a market.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const M5 = 5 * 60_000;
const open = (t: number): boolean => {
  const d = new Date(t), wd = d.getUTCDay(), h = d.getUTCHours();
  if (wd === 6) return false;
  if (wd === 5 && h >= 21) return false;
  if (wd === 0 && h < 21) return false;
  return true;
};

export function synthBars(o: { seed: number; start: number; bars: number; price: number; pip: number; dec: number; volPips: number }): Bar[] {
  const r = rng(o.seed);
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += r(); return s - 3; };
  const out: Bar[] = [];
  let px = o.price, drift = 0, legLeft = 0, t = Math.floor(o.start / M5) * M5;
  const round = (n: number) => +n.toFixed(o.dec);
  while (out.length < o.bars) {
    if (!open(t)) { t += M5; continue; }
    if (legLeft <= 0) { legLeft = 30 + Math.floor(r() * 220); drift = (r() - 0.5) * 0.9; }
    legLeft--;
    const hour = new Date(t).getUTCHours();
    const active = hour >= 7 && hour < 17 ? 1.5 : 0.7;
    const step = o.volPips * o.pip * active;
    const op = px;
    let hi = op, lo = op, c = op;
    for (let k = 0; k < 5; k++) { c += (gauss() * 0.45 + drift * 0.12) * step; hi = Math.max(hi, c); lo = Math.min(lo, c); }
    out.push({ t, o: round(op), h: round(Math.max(hi, op, c)), l: round(Math.min(lo, op, c)), c: round(c) });
    px = round(c);
    t += M5;
  }
  return out;
}

/** 2026-03-02 00:00 UTC, a Monday. */
export const MONDAY = Date.UTC(2026, 2, 2);
