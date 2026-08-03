/**
 * Multi-timeframe trend alignment.
 *
 * The engines used to bias trades off the 4H/Daily "higher-timeframe" trend and
 * take anything that leaned the same way. That produced too many stop-outs: the
 * daily can be bullish while the intraday stack (1H → 30m → 15m) is actually
 * rolling over, so a "with-trend" long buys straight into a short-term downleg.
 *
 * This module computes the trend on the three EXECUTION timeframes the trader
 * actually enters on — 1H, 30m, 15m — and only calls them "aligned" when all
 * three agree. A trade is allowed only when this stack agrees with the setup
 * direction; otherwise the engine stands aside (WAIT / NO-TRADE). Higher
 * timeframes still provide context, but they no longer override a conflicting
 * execution stack.
 */
import type { Row } from "./marketData";

export type Dir3 = "bullish" | "bearish" | "ranging";
export type MtfTrend = { tf: string; trend: Dir3 };
export type MtfResult = {
  byTf: MtfTrend[];
  dir: "LONG" | "SHORT" | null; // set only when all frames agree (fully aligned)
  aligned: boolean;             // all frames share one non-ranging direction
  conflict: boolean;            // at least one frame opposes another (bull vs bear)
  label: string;                // e.g. "1H bullish · 30m bullish · 15m bullish"
};

function sma(a: number[], n: number): number | null {
  if (a.length < n) return null;
  let s = 0;
  for (let i = a.length - n; i < a.length; i++) s += a[i];
  return s / n;
}

// Trend from a close series: price vs 20/50 SMA stack (same rule the engines use).
export function trendOfCloses(closes: number[]): Dir3 {
  const c = closes.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (c.length < 20) return "ranging";
  const p = c[c.length - 1], s20 = sma(c, 20), s50 = sma(c, 50);
  if (s20 == null || s50 == null) return "ranging";
  return p > s20 && s20 > s50 ? "bullish" : p < s20 && s20 < s50 ? "bearish" : "ranging";
}

export function trendOfRows(rows: Row[] | null | undefined): Dir3 {
  if (!rows || rows.length < 20) return "ranging";
  return trendOfCloses(rows.map((r) => +r.close));
}

/**
 * Drop the most recent bar, which — during an open session — is the CURRENT,
 * still-forming candle. Twelve Data returns it as the newest value; using its
 * OHLC as a completed candle is a look-ahead/repaint bug (the "close" keeps
 * changing tick-to-tick). Every indicator, trend, structure and ATR read must
 * run on CLOSED candles only. Keep at least `min` bars so callers stay valid.
 */
export function closedBars(rows: Row[] | null | undefined, min = 20): Row[] | null {
  if (!rows || rows.length === 0) return rows ?? null;
  if (rows.length <= min) return rows; // too few to safely trim — leave as-is
  return rows.slice(0, -1);
}

/** Given the labelled execution frames (1H, 30m, 15m), decide whether they line up. */
export function mtfAlign(frames: { tf: string; rows: Row[] | null | undefined }[]): MtfResult {
  const byTf: MtfTrend[] = frames.map((f) => ({ tf: f.tf, trend: trendOfRows(f.rows) }));
  const trends = byTf.map((x) => x.trend);
  const hasBull = trends.includes("bullish");
  const hasBear = trends.includes("bearish");
  const allBull = trends.length > 0 && trends.every((t) => t === "bullish");
  const allBear = trends.length > 0 && trends.every((t) => t === "bearish");
  const dir = allBull ? "LONG" : allBear ? "SHORT" : null;
  const label = byTf.map((x) => `${x.tf} ${x.trend}`).join(" · ");
  return { byTf, dir, aligned: dir != null, conflict: hasBull && hasBear, label };
}
