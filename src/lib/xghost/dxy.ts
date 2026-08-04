/**
 * xGhost — DXY (U.S. Dollar Index) confirmation module.
 *
 * SOURCE ORDER (decided in the route, classified here):
 *   1. NATIVE Twelve Data "DXY" — only if the plan serves it (Grow plan does NOT).
 *   2. FREE feed — ICE U.S. Dollar Index (DX-Y.NYB) intraday candles.
 *   3. PROXY — a USD-strength index computed from the five pairs the scan already
 *      fetched (zero extra API calls). Always available, so the scan never goes blind.
 *
 * The reading is taken across FOUR scalping timeframes — 1m, 5m, 15m, 30m — and
 * each is labelled up / down / flat for strength. It is confirmation only: it never
 * invents a level and never produces a trade on its own.
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
  const sep = (e20 - e50) / (Math.abs(e50) || 1);          // trend separation
  const above = (p - e20) / (Math.abs(e20) || 1);          // price vs fast EMA
  // slope of the last 8 closes
  const w = closes.slice(-8); const slope = (w[w.length - 1] - w[0]) / (Math.abs(w[0]) || 1);
  const raw = sep * 220 + above * 90 + slope * 160;        // scaled to ~[-1,1]
  return Math.max(-1, Math.min(1, raw));
}

function dirLabel(s: number | null): string { return s == null ? "n/a" : s > 0.15 ? "up" : s < -0.15 ? "down" : "flat"; }

type C = number[] | Row[] | null;
const toCloses = (r: C): number[] => !r ? [] : (typeof r[0] === "number" ? (r as number[]) : closesOf(r as Row[]));

/**
 * Classify DXY strength across 1m / 5m / 15m / 30m.
 * Weighting favours the higher scalping timeframes for trend, but the fast frames
 * still move the needle so a fresh turn is caught early.
 *   30m .35 · 15m .30 · 5m .20 · 1m .15
 */
export function classifyDxy(rows1m: C, rows5m: C, rows15m: C, rows30m: C, source: "native" | "free" | "proxy"): DxyRead {
  const c1 = toCloses(rows1m), c5 = toCloses(rows5m), c15 = toCloses(rows15m), c30 = toCloses(rows30m);
  const s1 = tfScore(c1), s5 = tfScore(c5), s15 = tfScore(c15), s30 = tfScore(c30);
  const parts = [s1, s5, s15, s30];
  const wts = [0.15, 0.20, 0.30, 0.35];
  const byTf = [
    { tf: "1m", dir: dirLabel(s1) },
    { tf: "5m", dir: dirLabel(s5) },
    { tf: "15m", dir: dirLabel(s15) },
    { tf: "30m", dir: dirLabel(s30) },
  ];

  const present = parts.filter((x): x is number => x != null);
  if (present.length === 0) return { state: "Neutral", score: 0, byTf, source };

  let sum = 0, wsum = 0;
  parts.forEach((x, i) => { if (x != null) { sum += x * wts[i]; wsum += wts[i]; } });
  const score = Math.round((sum / (wsum || 1)) * 100);      // -100..+100

  // Conflict: the timeframes materially disagree in sign and no side dominates.
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

// ── Free feed: ICE U.S. Dollar Index (DX-Y.NYB) via the public Yahoo chart API ──
// Returns closed candles oldest→newest for one interval, or null on any failure
// (the route then tries the next source). This is a real dollar-index quote — not
// a proxy — so when it responds the reading is a true DXY chart read.
const YF_INTERVAL: Record<string, { interval: string; range: string }> = {
  "1min": { interval: "1m", range: "1d" },
  "5min": { interval: "5m", range: "5d" },
  "15min": { interval: "15m", range: "5d" },
  "30min": { interval: "30m", range: "1mo" },
};
export async function fetchFreeDxy(interval: "1min" | "5min" | "15min" | "30min", size: number): Promise<Row[] | null> {
  const cfg = YF_INTERVAL[interval];
  if (!cfg) return null;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=${cfg.interval}&range=${cfg.range}`;
  try {
    const r = await fetch(url, {
      cache: "no-store",
      headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const ts: number[] | undefined = res?.timestamp;
    const q = res?.indicators?.quote?.[0];
    if (!Array.isArray(ts) || !q) return null;
    const rows: Row[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (![o, h, l, c].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
      rows.push({
        datetime: new Date(ts[i] * 1000).toISOString(),
        open: String(o), high: String(h), low: String(l), close: String(c),
      });
    }
    if (rows.length < 25) return null;
    return rows.slice(-size);
  } catch {
    return null;
  }
}
