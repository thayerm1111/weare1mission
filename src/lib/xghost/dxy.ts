/**
 * xGhost — DXY (U.S. Dollar Index) confirmation module.
 *
 * Preferred source is the NATIVE Twelve Data DXY symbol on 1H / 15m / 5m. If the
 * plan/feed does not serve DXY, we fall back to a computed USD-strength PROXY
 * built from the same pair candles the scan already fetched (zero extra API
 * calls). Either way we output the six-state classification the spec requires.
 *
 * The classifier only reads closes → trend + slope across the three timeframes,
 * weighted 1H > 15m > 5m. It never invents a level; it is confirmation only.
 */
import type { Row } from "../marketData";
import type { DxyRead } from "./engine";

const closesOf = (r: Row[]) => r.map((v) => +v.close);
function ema(v: number[], n: number): number | null { if (v.length < n) return null; const k = 2 / (n + 1); let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n; for (let i = n; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; }

// One timeframe → a normalized USD-strength reading in [-1, +1]
// (+ = dollar up / strengthening, − = dollar down / weakening).
function tfScore(closes: number[]): number | null {
  if (closes.length < 25) return null;
  const p = closes[closes.length - 1];
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  if (e20 == null || e50 == null || !p) return null;
  const sep = (e20 - e50) / (Math.abs(e50) || 1);         // trend separation
  const above = (p - e20) / (Math.abs(e20) || 1);          // price vs fast EMA
  // slope of the last 8 closes
  const w = closes.slice(-8); const slope = (w[w.length - 1] - w[0]) / (Math.abs(w[0]) || 1);
  const raw = sep * 220 + above * 90 + slope * 160;         // scaled to ~[-1,1]
  return Math.max(-1, Math.min(1, raw));
}

export function classifyDxy(rows1h: number[] | Row[] | null, rows15: number[] | Row[] | null, rows5: number[] | Row[] | null, source: "native" | "proxy"): DxyRead {
  const toC = (r: number[] | Row[] | null): number[] => !r ? [] : (typeof r[0] === "number" ? (r as number[]) : closesOf(r as Row[]));
  const c1 = toC(rows1h), c15 = toC(rows15), c5 = toC(rows5);
  const s1 = tfScore(c1), s15 = tfScore(c15), s5 = tfScore(c5);
  const parts = [s1, s15, s5];
  const byTf = [
    { tf: "1H", dir: dirLabel(s1) }, { tf: "15m", dir: dirLabel(s15) }, { tf: "5m", dir: dirLabel(s5) },
  ];
  const present = parts.filter((x): x is number => x != null);
  if (present.length === 0) return { state: "Neutral", score: 0, byTf, source };
  // Weighted 1H > 15m > 5m
  const wts = [0.5, 0.3, 0.2]; let sum = 0, wsum = 0;
  parts.forEach((x, i) => { if (x != null) { sum += x * wts[i]; wsum += wts[i]; } });
  const score = Math.round((sum / (wsum || 1)) * 100);      // -100..+100
  // Conflict: the timeframes materially disagree in sign
  const signs = present.map((x) => Math.sign(x)).filter((s) => Math.abs(s) > 0);
  const hasUp = signs.some((s) => s > 0), hasDn = signs.some((s) => s < 0);
  const conflicting = hasUp && hasDn && Math.abs(score) < 45;
  let state: DxyRead["state"];
  if (conflicting) state = "Conflicting / transitioning";
  else if (score >= 55) state = "Strong bullish";
  else if (score >= 20) state = "Moderate bullish";
  else if (score <= -55) state = "Strong bearish";
  else if (score <= -20) state = "Moderate bearish";
  else state = "Neutral";
  return { state, score, byTf, source };
}

function dirLabel(s: number | null): string { return s == null ? "n/a" : s > 0.15 ? "up" : s < -0.15 ? "down" : "flat"; }

// ── Proxy: synthesize a USD-strength series from the pair candles ───────────
// USD strengthens when EUR/GBP/AUD fall and USD/JPY, USD/CAD rise. We build an
// index from log-prices with DXY-like weights (EUR heaviest). Only the SHAPE
// matters for the trend classifier, so absolute scaling is irrelevant.
const PROXY_W: Record<string, { w: number; usdIsBase: boolean }> = {
  "EUR/USD": { w: 0.42, usdIsBase: false },
  "GBP/USD": { w: 0.14, usdIsBase: false },
  "AUD/USD": { w: 0.10, usdIsBase: false },
  "USD/JPY": { w: 0.20, usdIsBase: true },
  "USD/CAD": { w: 0.14, usdIsBase: true },
};
export function buildProxyCloses(pairs: Record<string, Row[] | null>): number[] {
  const series: { w: number; usdIsBase: boolean; closes: number[] }[] = [];
  for (const sym of Object.keys(PROXY_W)) {
    const rows = pairs[sym]; if (!rows || rows.length < 25) continue;
    series.push({ ...PROXY_W[sym], closes: closesOf(rows) });
  }
  if (!series.length) return [];
  const n = Math.min(...series.map((s) => s.closes.length));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const s of series) {
      const c = s.closes[s.closes.length - n + i];
      if (!(c > 0)) continue;
      const ln = Math.log(c);
      v += (s.usdIsBase ? 1 : -1) * s.w * ln;   // USD-base pairs: up = USD up; USD-quote pairs: up = USD down
    }
    out.push(v);
  }
  return out;
}
